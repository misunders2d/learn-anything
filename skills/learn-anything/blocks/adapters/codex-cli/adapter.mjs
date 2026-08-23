#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mentorItemIsSuperseded } from "./turn-order.mjs";

const adapterDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(adapterDir, "response.schema.json");

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

function mentorPrompt(topic, item) {
  const learnerInput = item.type === "user_message" && item.message?.source === "work"
    ? `Learner asks an inline clarification from the current work surface. Answer without replacing or leaving the current activity.\nQuestion: ${item.message.content}\nCurrent stage: ${JSON.stringify(item.stageContext, null, 2)}`
    : item.type === "user_message"
      ? item.message.content
    : JSON.stringify(item, null, 2);
  const foundation = `
You are the mentor inside a local adaptive browser course about: ${topic}.
Assume no prior knowledge until the learner demonstrates it. Calibrate from their language and attempts; never ask them to select a level and never open with a quiz or coding test. Explain a concept before showing code. A beginner code task must include a worked example, one clear change, and an expected result. Use plain learner-facing titles. Internal adapter, profile, transport, and sandbox details appear only when they are the learning objective.

Browser events are your observation of the learner. React automatically to submitted code, execution output, errors, and interactive answers. Unsent drafts persist without creating a mentor turn. Never ask the learner to repeat or check off evidence the browser already captured. Use checklists only for external actions the workspace cannot observe.

Match medium to subject. For humanities and conceptual science, start with one concrete anchor, a short explanation, and a meaningful learner question; do not dump a field survey, force code, or open a stage merely to use it. For a humanities beginner, keep the first turn to that anchor, why it matters, and one choice or question—do not list periods, authors, or genres unless the learner asks. Use a passage, comparison, timeline, diagram, or thought experiment only when it advances the current idea. For demonstrated technical experts, skip basic ceremony and move to a realistic example or failure mode.

The browser has one primary mode. Use focus "chat" for explanation, questions, and debrief. Use focus "work" only after your message has prepared one clear interactive activity. An inline clarification from a work surface is different: answer concisely with focus "work" and stage_json null so the current editor, task, and output remain visible. When creating or replacing work, stage_json must be a JSON string containing a stage object with supported components: markdown, callout, code, table, passage, figure, params, mermaid, quiz, checklist. When focus is chat, stage_json should normally be null.

Keep implementation scaffolding backstage. The learner must see and edit the subject's own artifact, never a wrapper chosen only because a host runner exists. A SQL lesson shows pure SQL, not Python sqlite3 setup. Put hidden fixtures in code.run.setup and choose the backend with code.run.runner. If no suitable runner exists, make the artifact non-runnable instead of wrapping it in another language. Prefer structured subject feedback: tables for SQL, targeted diagnostics for code, annotated passages for literature, and figures or parameters for visual concepts.

You may anchor a work-surface answer to the relevant component with target_component_id and optionally target_quote. For inline clarification, normally reuse the learner's component context. For execution feedback, target the executed code component. Otherwise return null for both fields.

Use these exact component fields:
- markdown: {"id":"...","type":"markdown","content":"..."}
- callout: {"id":"...","type":"callout","tone":"info|success|warning","title":"...","content":"..."}
- code: {"id":"...","type":"code","language":"any learner-facing syntax such as sql|python|rust|latex","value":"only the learner-facing artifact","runnable":true,"run":{"runner":"javascript|python|rust|c|sqlite","setup":"optional hidden fixture"}}
- table: {"id":"...","type":"table","caption":"...","columns":["..."],"rows":[["..."]]}
- passage: {"id":"...","type":"passage","text":"...","source":"...","annotations":[{"quote":"...","note":"..."}]}
- figure: {"id":"...","type":"figure","mermaid":"flowchart LR ...","caption":"...","callouts":[{"label":"..."}]}
- params: {"id":"...","type":"params","title":"...","controls":[{"id":"x","label":"...","min":0,"max":10,"step":1,"value":5}]}
- mermaid: {"id":"...","type":"mermaid","source":"flowchart LR ..."}
- quiz: {"id":"...","type":"quiz","question":"...","options":[{"id":"a","label":"..."}]}
- checklist: {"id":"...","type":"checklist","items":[{"id":"x","label":"...","done":false}]}
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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

async function normalizeStage(url, token, response) {
  const current = await requestJson(url, "/api/session", token);
  let stage;
  if (response.stage_json) {
    stage = JSON.parse(response.stage_json);
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error("stage_json must encode an object.");
  } else if (response.focus === "work" && current.stage?.components) {
    stage = current.stage;
  } else if (response.focus === "work") {
    throw new Error("Codex selected work focus without an existing or replacement stage.");
  } else {
    stage = current.stage?.components ? current.stage : { components: [] };
  }
  if (!Array.isArray(stage.components)) throw new Error("stage_json components must be an array.");
  const components = stage.components.map((component, index) => {
    if (!component || typeof component !== "object" || Array.isArray(component) || typeof component.type !== "string") {
      throw new Error(`Stage component ${index + 1} is invalid.`);
    }
    const id = typeof component.id === "string" && component.id ? component.id : `${component.type}-${index + 1}`;
    if (component.type === "code") {
      const value = typeof component.value === "string" ? component.value : component.content;
      if (typeof value !== "string") throw new Error(`Code component ${id} needs string value.`);
      if (typeof component.language !== "string" || !component.language.trim()) throw new Error(`Code component ${id} needs a learner-facing language.`);
      const legacyRunner = ["javascript", "python", "rust", "c"].includes(component.language) ? component.language : null;
      const run = component.run || (legacyRunner && component.runnable !== false ? { runner: legacyRunner } : null);
      if (run && !["javascript", "python", "rust", "c", "sqlite"].includes(run.runner)) throw new Error(`Code component ${id} has unsupported runner.`);
      if (run?.setup !== undefined && typeof run.setup !== "string") throw new Error(`Code component ${id} runner setup must be a string.`);
      return { ...component, id, value, ...(run ? { run } : {}), runnable: Boolean(run) && component.runnable !== false };
    }
    if (component.type === "checklist") {
      if (!Array.isArray(component.items)) throw new Error(`Checklist component ${id} needs items.`);
      return {
        ...component,
        id,
        items: component.items.map((item, itemIndex) => typeof item === "string"
          ? { id: `${id}-${itemIndex + 1}`, label: item, done: false }
          : { ...item, id: item?.id || `${id}-${itemIndex + 1}`, done: Boolean(item?.done) }),
      };
    }
    if (component.type === "quiz") {
      if (!Array.isArray(component.options)) throw new Error(`Quiz component ${id} needs options.`);
      return {
        ...component,
        id,
        options: component.options.map((item, itemIndex) => ({ ...item, id: item?.id || `${id}-${itemIndex + 1}` })),
      };
    }
    return { ...component, id };
  });
  return {
    ...stage,
    version: stage.version || "learn-anything/v1",
    surfaceId: stage.surfaceId || `${response.focus}-${randomUUID()}`,
    focus: response.focus,
    title: response.title || current.stage?.title || current.topic,
    components,
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
let threadId = session.assembly?.profile === "codex-cli" ? session.agentSessionId : null;
let firstPoll = true;
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const query = new URLSearchParams({ token, mentorId });
  if (firstPoll) query.set("takeover", "1");
  firstPoll = false;
  const response = await fetch(`${url}/api/mentor/next?${query}`);
  if (response.status === 204) continue;
  const item = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Mentor poll failed: ${response.status} ${JSON.stringify(item)}`);
  if (!item) continue;

  const runId = randomUUID();
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_STARTED", threadId: session.slug, runId });
  try {
    const result = await runCodex({
      sessionDir,
      threadId,
      prompt: mentorPrompt(session.topic, item),
    });
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
    const stage = await normalizeStage(url, token, result.response);
    const learnerContext = item.type === "user_message" && item.message?.source === "work" ? item.message.context : null;
    const executionContext = item.type === "execution_result" && item.componentId ? { componentId: item.componentId, label: `${item.language || "code"} code` } : null;
    const responseContext = result.response.target_component_id
      ? { componentId: result.response.target_component_id, ...(result.response.target_quote ? { quote: result.response.target_quote } : {}) }
      : learnerContext || executionContext;
    const responseMetadata = responseContext ? { source: "work", context: responseContext } : {};
    if (result.response.focus === "chat") await mentorPost(url, "/api/stage", token, mentorId, stage);
    await sendText(url, token, mentorId, result.response.message, responseMetadata);
    if (result.response.focus === "work") await mentorPost(url, "/api/stage", token, mentorId, stage);
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
