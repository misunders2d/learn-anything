#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { A2UI_CATALOG_PROMPT } from "../../a2ui/prompt.mjs";
import { mentorItemIsSuperseded } from "./turn-order.mjs";

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
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Codex authentication preflight timed out."));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex authentication preflight failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function mentorPrompt(topic, item) {
  const learnerInput = item.type === "user_message" && item.message?.source === "work"
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

${A2UI_CATALOG_PROMPT}

Set continuation_kind to "question" for chat and "action" for work. continuation is the exact short question or action the learner will see; chat continuation must contain a question mark.

Keep implementation scaffolding backstage. The learner must see and edit the subject's own artifact, never a wrapper chosen only because a host runner exists. Put hidden fixtures in Code.run.setup. Prefer structured subject feedback beside its cause.
`;
  return `${foundation}
Respond to this browser event:
${learnerInput}

Return only the required structured response. Keep message useful and concise. If the learner changes the learning topic, follow the new topic immediately.`;
}

function runCodex({ sessionDir, threadId, prompt }) {
  const common = [
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
  ];
  const args = threadId
    ? ["exec", "resume", ...common, threadId, prompt]
    : ["exec", ...common, "-C", sessionDir, "-s", "read-only", prompt];

  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", args, { cwd: sessionDir, stdio: ["ignore", "pipe", "pipe"] });
    activeProviderChild = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (activeProviderChild === child) activeProviderChild = null;
      if (code !== 0) {
        reject(new Error(`codex exec exited ${code ?? signal}: ${stderr.trim() || "no error output"}`));
        return;
      }
      let nextThreadId = threadId;
      let responseText = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "thread.started" && event.thread_id) nextThreadId = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") responseText = event.item.text;
      }
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

async function sendText(url, token, mentorId, text, metadata = {}) {
  const messageId = randomUUID();
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_START", messageId, role: "assistant", ...metadata });
  for (let index = 0; index < text.length; index += 160) {
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text.slice(index, index + 160) });
  }
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_END", messageId });
}

async function normalizeCanvasPayload(url, token, response) {
  const current = await requestJson(url, "/api/session", token);
  let messages = [];
  if (response.a2ui_jsonl) {
    if (typeof response.a2ui_jsonl !== "string") throw new Error("a2ui_jsonl must be a string or null.");
    messages = response.a2ui_jsonl
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`a2ui_jsonl line ${index + 1} is invalid JSON: ${error.message}`);
        }
      });
  }
  if (response.focus === "work" && messages.length === 0 && !current.canvas?.activeSurfaceId) {
    throw new Error("Codex selected work focus without an existing or replacement A2UI surface.");
  }
  return {
    focus: response.focus,
    messages,
    continuation: { kind: response.continuation_kind, text: response.continuation },
  };
}

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
const stop = () => {
  stopping = true;
  if (activeProviderChild?.exitCode === null) activeProviderChild.kill("SIGINT");
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
  const response = await fetch(`${url}/api/mentor/next?${query}`);
  if (response.status === 204) continue;
  const item = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Mentor poll failed: ${response.status} ${JSON.stringify(item)}`);
  if (!item) continue;

  const runId = randomUUID();
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_STARTED", threadId: session.slug, runId });
  try {
    let result = await runCodex({
      sessionDir,
      threadId,
      prompt: mentorPrompt(session.topic, item),
    });
    let canvasPayload = await normalizeCanvasPayload(url, token, result.response);
    try {
      await mentorPost(url, "/api/a2ui?validate=1", token, mentorId, canvasPayload);
    } catch (validationError) {
      result = await runCodex({
        sessionDir,
        threadId: result.threadId || threadId,
        prompt: `Your previous A2UI update was rejected before the learner saw your claim: ${validationError.message}\nReturn one corrected structured response now. Preserve the intended learner message, but make a2ui_jsonl valid. updateComponents merges by id, so every existing component must remain reachable from root unless you delete and recreate the surface.`,
      });
      canvasPayload = await normalizeCanvasPayload(url, token, result.response);
      await mentorPost(url, "/api/a2ui?validate=1", token, mentorId, canvasPayload);
    }
    if (result.threadId && result.threadId !== threadId) {
      threadId = result.threadId;
      await mentorPost(url, "/api/mentor/event", token, mentorId, {
        type: "CUSTOM",
        name: "mentor_session",
        value: { sessionId: threadId },
      });
    }
    const currentSession = await requestJson(url, "/api/session", token);
    if (mentorItemIsSuperseded(item, currentSession)) {
      await mentorPost(url, "/api/mentor/event", token, mentorId, {
        type: "RUN_FINISHED",
        threadId: session.slug,
        runId,
        outcome: { type: "cancelled", reason: "newer_learner_message" },
      });
      continue;
    }
    const learnerContext = item.type === "user_message" && item.message?.source === "work" ? item.message.context : null;
    const executionContext = item.type === "execution_result" && item.componentId ? { componentId: item.componentId, label: `${item.language || "code"} code` } : null;
    const responseContext = result.response.target_component_id
      ? { componentId: result.response.target_component_id, ...(result.response.target_quote ? { quote: result.response.target_quote } : {}) }
      : learnerContext || executionContext;
    const responseMetadata = responseContext ? { source: "work", context: responseContext } : {};
    if (result.response.focus === "chat") await mentorPost(url, "/api/a2ui", token, mentorId, canvasPayload);
    await sendText(url, token, mentorId, result.response.message, responseMetadata);
    if (result.response.focus === "work") await mentorPost(url, "/api/a2ui", token, mentorId, canvasPayload);
    await mentorPost(url, "/api/mentor/event", token, mentorId, {
      type: "RUN_FINISHED",
      threadId: session.slug,
      runId,
      outcome: { type: "success" },
    });
  } catch (error) {
    await sendText(url, token, mentorId, `Mentor failed to respond: ${error.message}`);
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_ERROR", message: error.message, code: "MENTOR_ERROR" });
  }
}
