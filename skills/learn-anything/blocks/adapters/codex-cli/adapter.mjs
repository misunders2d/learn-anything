#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { A2UI_CATALOG_PROMPT } from "../../a2ui/prompt.mjs";
import { candidateFromCanvas, reconcileMentorTurn, TEACHING_EVIDENCE_PROMPT, teachingPatternsPrompt } from "../mentor-turn.mjs";

const adapterDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(adapterDir, "response.schema.json");

let activeProviderChild = null;
function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function requestJson(url, path, token, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": token,
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function mentorPost(url, path, token, mentorId, value) {
  return requestJson(url, path, token, {
    method: "POST",
    headers: { "x-learn-anything-mentor": mentorId },
    body: JSON.stringify(value),
  });
}

function preflightProvider(cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", ["login", "status"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    activeProviderChild = child;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex authentication preflight timed out."));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (activeProviderChild === child) activeProviderChild = null;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex authentication preflight failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

export function mentorPrompt(topic, item) {
  const learnerInput = item.type === "user_message" && item.message?.source === "work" && item.message?.context?.componentId
    ? `Learner asks an inline clarification from the current work canvas. Answer without replacing or leaving the current activity.\nQuestion: ${item.message.content}\nCurrent A2UI canvas: ${JSON.stringify(item.canvasContext, null, 2)}`
    : item.type === "user_message"
      ? item.message.content
    : JSON.stringify(item, null, 2);
  const foundation = `
You are the mentor inside a local adaptive browser course about: ${topic}.
Assume no prior knowledge until the learner demonstrates it. Calibrate from their language and attempts; never ask them to select a level and never open with a quiz or coding test. Explain a concept before showing code. A beginner code task must include a worked example, one clear change, and an expected result. Use plain learner-facing titles. Internal adapter, profile, transport, and sandbox details appear only when they are the learning objective.

Browser events are your observation of the learner. React automatically to submitted code, execution output, errors, and interactive answers. Unsent drafts persist without creating a mentor turn. Never ask the learner to repeat or check off evidence the browser already captured. Use checklists only for external actions the workspace cannot observe.

Match medium to subject. For humanities and conceptual science, start with one concrete anchor, a short explanation, and a meaningful learner question; do not dump a field survey, force code, or open a stage merely to use it. For a humanities beginner, keep the first turn to that anchor, why it matters, and one choice or question—do not list periods, authors, or genres unless the learner asks. Use a passage, comparison, timeline, diagram, or thought experiment only when it advances the current idea. Use Plot for a quantitative relationship, Math when notation itself matters, and finite Params frames for a bounded state sequence. A control is useful only when it immediately changes a visible bound artifact. A plot illustrates a model; it does not prove it. For demonstrated technical experts, skip basic ceremony and move to a realistic example or failure mode.

The browser has one primary mode. Use focus "chat" for a broad learner question or one genuine question that requires their answer. Do not switch to chat merely to acknowledge, explain, or debrief an observed activity result; keep that progression in focus "work" with one visible next action. An inline clarification from a work canvas stays in focus "work" with a2ui_jsonl null so the current editor, task, and output remain visible.

When creating or updating work, a2ui_jsonl must contain newline-delimited A2UI v0.9 JSON messages. Use the exact protocol envelope with one message type per line:
{"version":"v0.9","createSurface":{"surfaceId":"lesson","catalogId":"urn:learn-anything:catalog:v1"}}
{"version":"v0.9","updateComponents":{"surfaceId":"lesson","components":[{"id":"root","component":"Column","children":["intro"]},{"id":"intro","component":"Markdown","content":"A clear explanation"}]}}
{"version":"v0.9","updateDataModel":{"surfaceId":"lesson","path":"/","value":{"title":"A learner-facing title"}}}

${TEACHING_EVIDENCE_PROMPT}

${A2UI_CATALOG_PROMPT}

Set continuation_kind to "question" for chat and "action" for work. For every work response, task_title is the localized current task title, target_component_id names one component that exists after a2ui_jsonl applies, and action_type is run, edit, answer, adjust, read, inspect, or submit matching both the main continuation verb and target component; use null for all three in chat. continuation is one short sentence in the learner's language. A work continuation names exactly what to do now, its visible target, and expected evidence when useful; never say only continue, next, complete the activity, or follow mentor guidance. Chat continuation must contain a question mark. Keep one active task, with its instruction immediately before the target and supporting explanation afterward.

Keep implementation scaffolding backstage. The learner must see and edit the subject's own artifact, never a wrapper chosen only because a host runner exists. Put hidden fixtures in Code.run.setup. Prefer structured subject feedback beside its cause.
`;
  return `${foundation}
${teachingPatternsPrompt(item)}
Respond to this browser event:
${boundedPrompt(learnerInput)}

Optional milestone records demonstrated progress: title, takeaway, nextStep, concepts, misconceptions. Otherwise milestone is null. Never infer mastery from a click. Optional pattern: {title, description, tags, a2ui_jsonl} for a newly authored generic standalone teaching example, else null.

Return only the required structured response. Keep message useful and concise. If the learner changes the learning topic, follow the new topic immediately.`;
}

export const MAX_PROMPT_BYTES = 256_000;
export function boundedPrompt(prompt, maxBytes = MAX_PROMPT_BYTES) {
  const bytes = Buffer.from(String(prompt));
  if (bytes.length <= maxBytes) return String(prompt);
  return `${bytes.subarray(0, maxBytes - 80).toString("utf8")}\n[Input truncated at mentor transport limit.]`;
}

export function runCodex({ sessionDir, threadId, prompt, spawnImpl = spawn, timeoutMs = 300_000 }) {
  const common = [
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "-c", 'sandbox_mode="read-only"',
  ];
  const args = threadId
    ? ["exec", "resume", ...common, threadId, "-"]
    : ["exec", ...common, "-C", sessionDir, "-s", "read-only", "-"];

  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl("codex", args, { cwd: sessionDir, stdio: ["pipe", "pipe", "pipe"] });
    let failure = null;
    const fail = (error) => { failure ||= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => fail(new Error("Codex mentor turn timed out.")), timeoutMs);
    child.stdin.on("error", (error) => fail(error));
    child.stdin.end(boundedPrompt(prompt));
    activeProviderChild = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 2_000_000) fail(new Error("Codex output exceeded transport limit.")); else stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (activeProviderChild === child) activeProviderChild = null;
      if (code !== 0) {
        reject(new Error(`codex exec exited ${code ?? signal}: ${stderr.trim() || "no error output"}`));
        return;
      }
      let nextThreadId = threadId;
      let responseText = null;
      let providerFailed = false;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "turn.failed" || event.type === "error") providerFailed = true;
        if (event.type === "thread.started" && event.thread_id) nextThreadId = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") responseText = event.item.text;
      }
      if (providerFailed) { reject(new Error("Codex provider turn failed.")); return; }
      if (!responseText) {
        reject(new Error(`Codex returned no mentor message. ${stderr.trim()}`));
        return;
      }
      let response;
      try {
        response = JSON.parse(responseText);
      } catch {
        reject(new Error(`Codex mentor response was not valid JSON: ${responseText.slice(0, 500)}`));
        return;
      }
      resolvePromise({ threadId: nextThreadId, response });
    });
  });
}

export async function main() {
  const args = process.argv.slice(2);
  const url = (option(args, "--url") || "").replace(/\/$/, "");
  const sessionDir = resolve(option(args, "--session") || "");
  if (!url || !option(args, "--session")) {
    throw new Error("Usage: adapter.mjs --url <server-url> --session <session-dir> [--token <token>]");
  }

  const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
  const token = option(args, "--token") || session.security?.accessToken;
  if (!token) throw new Error("Session has no access token.");
  const mentorId = randomUUID();
  let threadId = session.agentSessionId || null;
  let stopping = false;
  const pollController = new AbortController();
  const stop = () => {
    stopping = true;
    pollController.abort();
    if (activeProviderChild?.exitCode === null) activeProviderChild.kill("SIGKILL");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await preflightProvider(sessionDir);
  await requestJson(url, "/api/mentor/register", token, {
    method: "POST",
    body: JSON.stringify({ mentorId, takeover: true }),
  });
  await mentorPost(url, "/api/mentor/ready", token, mentorId, {});

  while (!stopping) {
    const query = new URLSearchParams({ token, mentorId });
    let response;
    try { response = await fetch(`${url}/api/mentor/next?${query}`, { signal: pollController.signal }); }
    catch (error) { if (stopping) break; throw error; }
    if (response.status === 204) continue;
    const item = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Mentor poll failed: ${response.status} ${JSON.stringify(item)}`);
    if (!item) continue;

    const runId = randomUUID();
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_STARTED", threadId: session.slug, runId, turnId: item.mentorTurn?.id, baseRevision: item.mentorTurn?.baseRevision });
    try {
      const before = await requestJson(url, "/api/session", token);
      const history = before.mentorSessionInitialized ? "" : (before.transcript || []).filter((entry) => entry.id !== item.message?.id).slice(-12).map((entry) => `${entry.role}: ${entry.content}`).join("\n\n");
      const result = await runCodex({ sessionDir, threadId, prompt: mentorPrompt(session.topic, item) + (history ? `\nRecent course transcript:\n${boundedPrompt(history, 32_000)}` : "") });
      if (result.threadId && result.threadId !== threadId) {
        threadId = result.threadId;
        await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "CUSTOM", name: "mentor_session", value: { sessionId: threadId } });
      }
      await mentorPost(url, "/api/mentor/turn", token, mentorId, {
        ...reconcileMentorTurn(item, candidateFromCanvas(result.response), before, { runId }),
        initializeSession: !before.mentorSessionInitialized,
      });
    } catch (error) {
      await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_ERROR", message: error.message, code: "MENTOR_ERROR", runId, turnId: item.mentorTurn?.id, baseRevision: item.mentorTurn?.baseRevision });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
