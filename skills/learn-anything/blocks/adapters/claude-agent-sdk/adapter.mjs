#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { createSdkMcpServer, startup, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { A2UI_CATALOG_PROMPT } from "../../a2ui/prompt.mjs";
import { candidateFromCanvas, reconcileMentorTurn, TEACHING_EVIDENCE_PROMPT, teachingPatternsPrompt } from "../mentor-turn.mjs";
import { SequentialTurnGate } from "./turn-gate.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function post(url, path, body, token, mentorId) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": token,
      "x-learn-anything-mentor": mentorId,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${result.error || response.statusText}`);
  return result;
}

async function loadSession(sessionDir) {
  return JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
}

async function* browserMessages(url, token, mentorId, abortSignal, onMessage, gate) {
  let takeover = true;
  while (!abortSignal.aborted) {
    const query = new URLSearchParams({ token, mentorId });
    if (takeover) query.set("takeover", "1");
    let response;
    try {
      response = await fetch(`${url}/api/mentor/next?${query}`, { signal: abortSignal });
    } catch (error) {
      if (abortSignal.aborted) break;
      throw error;
    }
    takeover = false;
    if (response.status === 204) continue;
    const item = await response.json();
    if (!response.ok) throw new Error(item.error || response.statusText);
    const content = item.type === "user_message" && item.message?.source === "work" && item.message?.context?.componentId
      ? `Learner asks an inline clarification from the current work canvas. Answer without replacing or leaving the activity.\nQuestion: ${item.message.content}\nCurrent A2UI canvas: ${JSON.stringify(item.canvasContext, null, 2)}`
      : item.type === "user_message"
        ? item.message.content
      : item.type === "execution_result"
        ? `Learner explicitly submitted this ${item.language} code for feedback:\n${item.code || "(code unavailable)"}\n\nLatest execution result:\n${JSON.stringify(item.result, null, 2)}`
        : `Browser canvas action:\n${JSON.stringify(item.action, null, 2)}`;
    gate.begin();
    const history = await onMessage(item);
    yield {
      type: "user",
      message: { role: "user", content: `${teachingPatternsPrompt(item)}${history || ""}${content}` },
      parent_tool_use_id: null,
    };
    await gate.wait();
  }
}

const args = process.argv.slice(2);
const url = (option(args, "--url") || "").replace(/\/$/, "");
const sessionDir = resolve(option(args, "--session") || "");
if (!url || !option(args, "--session")) throw new Error("Usage: adapter.mjs --url <server-url> --session <session-dir> [--token <token>]");

const session = await loadSession(sessionDir);
const token = option(args, "--token") || session.security?.accessToken;
if (!token) throw new Error("Session has no access token.");
const abortController = new AbortController();
let activeRunId = null;
let preparedTurn = null;
let currentSession = null;
const gate = new SequentialTurnGate();
const mentorId = crypto.randomUUID();
const renderCanvas = tool(
  "render_canvas",
  "Prepare the complete learner-facing answer and A2UI canvas for one atomic commit after the provider turn finishes.",
  {
    message: z.string().min(1).max(20_000),
    milestone: z.object({ title: z.string().min(1).max(200), takeaway: z.string().min(1).max(4000), nextStep: z.string().min(1).max(1000), concepts: z.array(z.string().min(1).max(500)).max(30).optional(), misconceptions: z.array(z.string().min(1).max(500)).max(30).optional() }).optional(),
    pattern: z.object({ title: z.string().min(1).max(120), description: z.string().min(1).max(1000), tags: z.array(z.string().min(1).max(40)).max(12).optional(), a2ui_jsonl: z.string().min(1).max(24_000) }).optional(),
    focus: z.enum(["chat", "work"]),
    messages: z.array(z.record(z.string(), z.unknown())).max(100),
    continuationKind: z.enum(["question", "action"]),
    continuation: z.string().min(1),
    taskTitle: z.string().min(1).max(120).optional(),
    targetComponentId: z.string().min(1).max(200).optional(),
    actionType: z.enum(["run", "edit", "answer", "adjust", "read", "inspect", "submit"]).optional(),
  },
  async (response) => {
    try {
      if (preparedTurn) throw new Error("Only one completed candidate is allowed per turn.");
      preparedTurn = reconcileMentorTurn(activeBrowserItem, candidateFromCanvas(response), currentSession, { runId: activeRunId });
      return { content: [{ type: "text", text: "Turn prepared. End this response; the host will commit it atomically." }] };
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  },
);
const learningTools = createSdkMcpServer({ name: "learn_anything", version: "0.1.3", tools: [renderCanvas] });

const systemAppend = `You are the headless mentor inside a learn-anything browser workspace. The browser is the learner-facing surface and observation layer. Teach toward: ${session.topic}. Assume no prior knowledge until the learner demonstrates it. Explain a concept before code, use progressive hints, and react automatically to submitted artifacts, execution output, errors, and interactive answers. Never ask the learner to repeat evidence the browser captured.

Drive one primary activity at a time. Use chat focus for a broad learner question or one genuine question that requires their answer. Do not switch to chat merely to acknowledge, explain, or debrief an observed activity result; keep that progression in work focus with one visible next action. Inline work clarification stays on the current canvas: call render_canvas with work focus, no messages, and one concrete action continuation; the server preserves the mounted editor and result while updating that cue. Keep implementation scaffolding backstage and show the subject's native artifact. Use a visual only for a named relationship: Figure for structure, Plot for quantitative change, Math for notation, and finite Params frames for a bounded state sequence. A control must immediately change a visible bound artifact; a plot illustrates rather than proves.

Put the complete learner-facing answer in render_canvas.message; streamed assistant prose is not published. For every turn, call render_canvas exactly once—even when messages is empty—to publish structured continuation metadata. continuationKind is "question" for chat and "action" for work; a chat continuation contains a question mark. Every work call requires taskTitle, targetComponentId, and actionType. Choose actionType run, edit, answer, adjust, read, inspect, or submit so it matches the main continuation verb and the target component; targetComponentId must exist on the active surface after messages apply. Write one short continuation sentence in the learner's language. A work continuation names exactly what to do now, its visible target, and expected evidence when useful; never say only continue, next, complete the activity, or follow mentor guidance. Keep one active task, place its instruction immediately before the target, and put supporting explanation afterward. When creating or updating work, send actual A2UI v0.9 messages. A new canvas normally sends createSurface, updateComponents, and updateDataModel. Use catalogId "urn:learn-anything:catalog:v1". All messages include version "v0.9".

${TEACHING_EVIDENCE_PROMPT}

${A2UI_CATALOG_PROMPT}

Never claim code ran unless browser execution reports it. Include optional milestone {title, takeaway, nextStep, concepts, misconceptions} after demonstrated meaningful progress, never merely a click. Optional pattern {title, description, tags, a2ui_jsonl} saves a newly authored generic standalone teaching example. Milestones commit with the turn; do not write journal or notes files. Project source is read-only; the learning directory is writable. Current degraded capabilities: ${(session.assembly?.degraded || []).join(", ") || "none"}.`;
let activeBrowserItem = null;
let conversationInitialized = Boolean(session.agentSessionId);
const sdkOptions = {
  abortController,
  cwd: sessionDir,
  additionalDirectories: session.sourceRoot && session.sourceRoot !== sessionDir ? [session.sourceRoot] : [],
  includePartialMessages: true,
  systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
  tools: ["Read", "Grep", "Glob"],
  allowedTools: ["Read", "Grep", "Glob", "mcp__learn_anything__render_canvas"],
  mcpServers: { learn_anything: learningTools },
  ...(session.agentSessionId ? { resume: session.agentSessionId } : {}),
};
let warmQuery;
let sdkQuery;
const stop = () => { abortController.abort(); gate.finish(); warmQuery?.close(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  warmQuery = await startup({ options: sdkOptions, initializeTimeoutMs: 20_000 });
  if (abortController.signal.aborted) throw new Error("Mentor startup interrupted.");
  await post(url, "/api/mentor/register", { mentorId, takeover: true }, token, mentorId);
  await post(url, "/api/mentor/ready", {}, token, mentorId);
  sdkQuery = warmQuery.query(browserMessages(url, token, mentorId, abortController.signal, async (item) => {
  activeBrowserItem = item;
  preparedTurn = null;
  currentSession = await loadSession(sessionDir);
  activeRunId = crypto.randomUUID();
  await post(url, "/api/mentor/event", { type: "RUN_STARTED", threadId: session.slug, runId: activeRunId, turnId: item.mentorTurn?.id, baseRevision: item.mentorTurn?.baseRevision }, token, mentorId);
  const history = conversationInitialized ? "" : (currentSession.transcript || []).filter((entry) => entry.id !== item.message?.id).slice(-12).map((entry) => `${entry.role}: ${entry.content}`).join("\n\n");
  conversationInitialized = true;
  return history ? `Recent course transcript:\n${history}\n\n` : "";
}, gate));

  for await (const message of sdkQuery) {
    if ((message.type === "system" && message.subtype === "init" || message.type === "result") && message.session_id) {
      await post(url, "/api/mentor/event", { type: "CUSTOM", name: "mentor_session", value: { sessionId: message.session_id } }, token, mentorId);
    }
    if (message.type !== "result") continue;
    try {
      if (message.subtype !== "success") throw new Error((message.errors || []).join("\n") || message.subtype);
      if (!preparedTurn) throw new Error("Mentor completed without a structured turn.");
      await post(url, "/api/mentor/turn", { ...preparedTurn, initializeSession: !currentSession.mentorSessionInitialized }, token, mentorId);
    } catch (error) {
      await post(url, "/api/mentor/event", { type: "RUN_ERROR", message: error.message, code: "MENTOR_ERROR", runId: activeRunId, turnId: activeBrowserItem?.mentorTurn?.id, baseRevision: activeBrowserItem?.mentorTurn?.baseRevision }, token, mentorId);
    } finally {
      activeRunId = null;
      activeBrowserItem = null;
      preparedTurn = null;
      gate.finish();
    }
  }
} finally {
  stop();
  await sdkQuery?.close();
}
