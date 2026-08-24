#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mentorItemIsSuperseded } from "../codex-cli/turn-order.mjs";

let activeProviderChild = null;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function requestJson(url, path, token, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-learn-anything-token": token, ...(options.headers || {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function mentorPost(url, path, token, mentorId, value) {
  return requestJson(url, path, token, {
    method: "POST",
    headers: { "x-learn-anything-mentor": mentorId },
    body: JSON.stringify(value),
  });
}

function mentorPrompt(topic, item, history) {
  const learnerInput = item.type === "user_message" && item.message?.source === "work"
    ? `Inline clarification. Keep the current work visible.\nQuestion: ${item.message.content}\nCanvas: ${JSON.stringify(item.canvasContext, null, 2)}`
    : item.type === "user_message" ? item.message.content : JSON.stringify(item, null, 2);
  const transcript = history.map((message) => `${message.role === "assistant" ? "Mentor" : "Learner"}: ${message.content}`).join("\n\n");
  return `You are the mentor inside a local adaptive browser course about ${topic}.
The browser is the primary learning surface. Answer every browser event here; never tell the learner to continue in a terminal or another chat.
Assume no prior knowledge until demonstrated. Explain before testing. Keep adapter and runtime details out of learner-facing text.
React automatically to code results and answers captured by the browser. Do not ask the learner to repeat evidence.
Use focus "chat" for explanation. Use focus "work" only for one prepared interactive activity.
When creating work, a2ui_jsonl must be newline-delimited A2UI v0.9 JSON with one message per line and the version string exactly "v0.9":
{"version":"v0.9","createSurface":{"surfaceId":"lesson","catalogId":"urn:learn-anything:catalog:v1"}}
{"version":"v0.9","updateComponents":{"surfaceId":"lesson","components":[{"id":"root","component":"Column","children":["intro","code"]},{"id":"intro","component":"Markdown","content":"A clear explanation"},{"id":"code","component":"Code","language":"java","value":"public class Main {}","runnable":true,"run":{"runner":"java"}}]}}
{"version":"v0.9","updateDataModel":{"surfaceId":"lesson","path":"/","value":{"title":"A learner-facing title"}}}
Supported components: Markdown, Callout, Code, Table, Passage, Figure, Params, Mermaid, Quiz, Checklist. Runnable Code components use run.runner javascript, python, java, rust, c, or sqlite. Keep a2ui_jsonl null when no canvas change is needed.
Return only one valid JSON object with exactly these keys:
{"message":"learner-facing response","focus":"chat|work","a2ui_jsonl":null,"target_component_id":null,"target_quote":null}
Use strings or null for the last three fields. Do not wrap JSON in markdown.
Recent conversation:
${transcript || "No previous messages."}
Browser event:
${learnerInput}`;
}

export function parsePiResponse(stdout) {
  const trimmed = String(stdout || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Pi returned no JSON mentor response: ${trimmed.slice(0, 500)}`);
  let response;
  try { response = JSON.parse(trimmed.slice(start, end + 1)); }
  catch (error) { throw new Error(`Pi mentor response was not valid JSON: ${error.message}`); }
  const keys = ["message", "focus", "a2ui_jsonl", "target_component_id", "target_quote"];
  if (typeof response.message !== "string" || !response.message.trim()) throw new Error("Pi mentor response has no message.");
  if (!["chat", "work"].includes(response.focus)) throw new Error("Pi mentor response has invalid focus.");
  for (const key of ["a2ui_jsonl", "target_component_id", "target_quote"]) {
    if (response[key] !== null && typeof response[key] !== "string") throw new Error(`Pi mentor response has invalid ${key}.`);
  }
  return Object.fromEntries(keys.map((key) => [key, response[key] ?? null]));
}

function runPi({ sessionDir, prompt }) {
  const args = ["--no-skills", "--no-extensions", "--no-context-files", "--no-session", "--no-tools", "-p", prompt];
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pi", args, { cwd: sessionDir, stdio: ["ignore", "pipe", "pipe"] });
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
      if (code !== 0) return reject(new Error(`pi --print exited ${code ?? signal}: ${stderr.trim() || "no error output"}`));
      try { resolvePromise(parsePiResponse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function preflightPi(sessionDir) {
  const response = await runPi({ sessionDir, prompt: "Reply only with this JSON: {\"message\":\"pi-ready\",\"focus\":\"chat\",\"a2ui_jsonl\":null,\"target_component_id\":null,\"target_quote\":null}" });
  if (response.message !== "pi-ready") throw new Error("Pi provider readiness check returned an unexpected response.");
}

async function sendText(url, token, mentorId, text, metadata = {}) {
  const messageId = randomUUID();
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_START", messageId, role: "assistant", ...metadata });
  for (let index = 0; index < text.length; index += 160) {
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text.slice(index, index + 160) });
  }
  await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "TEXT_MESSAGE_END", messageId });
}

async function canvasPayload(url, token, response) {
  const current = await requestJson(url, "/api/session", token);
  const messages = response.a2ui_jsonl ? response.a2ui_jsonl.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`a2ui_jsonl line ${index + 1} is invalid JSON: ${error.message}`); }
  }) : [];
  if (response.focus === "work" && messages.length === 0 && !current.canvas?.activeSurfaceId) throw new Error("Pi selected work focus without a canvas.");
  return { focus: response.focus, messages };
}

async function main() {
  const args = process.argv.slice(2);
  const url = (option(args, "--url") || "").replace(/\/$/, "");
  const sessionDir = resolve(option(args, "--session") || "");
  if (!url || !option(args, "--session")) throw new Error("Usage: adapter.mjs --url <server-url> --session <session-dir>");
  const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
  const token = option(args, "--token") || session.security?.accessToken;
  if (!token) throw new Error("Session has no access token.");
  const mentorId = randomUUID();
  let stopping = false;
  const stop = () => { stopping = true; if (activeProviderChild?.exitCode === null) activeProviderChild.kill("SIGINT"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await preflightPi(sessionDir);
  await requestJson(url, "/api/mentor/register", token, { method: "POST", body: JSON.stringify({ mentorId, takeover: true }) });
  await mentorPost(url, "/api/mentor/ready", token, mentorId, {});

  while (!stopping) {
    const query = new URLSearchParams({ token, mentorId });
    const poll = await fetch(`${url}/api/mentor/next?${query}`);
    if (poll.status === 204) continue;
    const item = await poll.json().catch(() => null);
    if (!poll.ok) throw new Error(`Mentor poll failed: ${poll.status} ${JSON.stringify(item)}`);
    if (!item) continue;
    const runId = randomUUID();
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_STARTED", threadId: session.slug, runId });
    try {
      const before = await requestJson(url, "/api/session", token);
      const answer = await runPi({ sessionDir, prompt: mentorPrompt(session.topic, item, (before.transcript || []).slice(-12)) });
      const current = await requestJson(url, "/api/session", token);
      if (mentorItemIsSuperseded(item, current)) {
        await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_FINISHED", threadId: session.slug, runId, outcome: { type: "cancelled", reason: "newer_learner_message" } });
        continue;
      }
      const canvas = await canvasPayload(url, token, answer);
      const learnerContext = item.type === "user_message" && item.message?.source === "work" ? item.message.context : null;
      const executionContext = item.type === "execution_result" && item.componentId ? { componentId: item.componentId, label: `${item.language || "code"} code` } : null;
      const context = answer.target_component_id ? { componentId: answer.target_component_id, ...(answer.target_quote ? { quote: answer.target_quote } : {}) } : learnerContext || executionContext;
      const metadata = context ? { source: "work", context } : {};
      if (answer.focus === "chat") await mentorPost(url, "/api/a2ui", token, mentorId, canvas);
      await sendText(url, token, mentorId, answer.message, metadata);
      if (answer.focus === "work") await mentorPost(url, "/api/a2ui", token, mentorId, canvas);
      await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_FINISHED", threadId: session.slug, runId, outcome: { type: "success" } });
    } catch (error) {
      if (stopping) break;
      await sendText(url, token, mentorId, `Mentor failed to respond: ${error.message}`);
      await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_ERROR", message: error.message, code: "MENTOR_ERROR" });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
