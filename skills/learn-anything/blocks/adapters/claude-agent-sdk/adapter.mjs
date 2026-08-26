#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { createSdkMcpServer, startup, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { A2UI_CATALOG_PROMPT } from "../../a2ui/prompt.mjs";
import { createClaudeEventState, fallbackCanvasForClaudeItem, mapClaudeMessage } from "./events.mjs";

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

async function* browserMessages(url, token, mentorId, abortSignal, onMessage) {
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
    const content = item.type === "user_message" && item.message?.source === "work"
      ? `Learner asks an inline clarification from the current work canvas. Answer without replacing or leaving the activity.\nQuestion: ${item.message.content}\nCurrent A2UI canvas: ${JSON.stringify(item.canvasContext, null, 2)}`
      : item.type === "user_message"
        ? item.message.content
      : item.type === "execution_result"
        ? `Learner explicitly submitted this ${item.language} code for feedback:\n${item.code || "(code unavailable)"}\n\nLatest execution result:\n${JSON.stringify(item.result, null, 2)}`
        : `Browser canvas action:\n${JSON.stringify(item.action, null, 2)}`;
    await onMessage(item);
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
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
let continuationPostedThisTurn = false;
const mentorId = crypto.randomUUID();
const renderCanvas = tool(
  "render_canvas",
  "Apply A2UI v0.9 messages and publish the one explicit question or action that continues the course.",
  {
    focus: z.enum(["chat", "work"]),
    messages: z.array(z.record(z.string(), z.unknown())).max(100),
    continuationKind: z.enum(["question", "action"]),
    continuation: z.string().min(1),
  },
  async ({ focus, messages, continuationKind, continuation }) => {
    try {
      const result = await post(url, "/api/a2ui", {
        focus,
        messages,
        continuation: { kind: continuationKind, text: continuation },
      }, token, mentorId);
      continuationPostedThisTurn = true;
      return { content: [{ type: "text", text: `Canvas updated: ${result.surfaceId || "preserved"}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Canvas update failed: ${error.message}` }], isError: true };
    }
  },
);
const saveMilestone = tool(
  "save_milestone",
  "Persist a completed learning milestone, durable takeaway, and next step in the learning directory.",
  {
    title: z.string(),
    takeaway: z.string(),
    nextStep: z.string(),
  },
  async ({ title, takeaway, nextStep }) => {
    const stamp = new Date().toISOString();
    await appendFile(join(sessionDir, "journal.md"), `## ${title}\n\n- Completed: ${stamp}\n- Takeaway: ${takeaway}\n- Next: ${nextStep}\n\n`, "utf8");
    await appendFile(join(sessionDir, "notes.md"), `## ${title}\n\n${takeaway}\n\nNext: ${nextStep}\n\n`, "utf8");
    return { content: [{ type: "text", text: `Milestone saved: ${title}` }] };
  },
);
const learningTools = createSdkMcpServer({
  name: "learn_anything",
  version: "0.1.3",
  tools: [renderCanvas, saveMilestone],
});

const systemAppend = `You are the headless mentor inside a learn-anything browser workspace. The browser is the learner-facing surface and observation layer. Teach toward: ${session.topic}. Assume no prior knowledge until the learner demonstrates it. Explain a concept before code, use progressive hints, and react automatically to submitted artifacts, execution output, errors, and interactive answers. Never ask the learner to repeat evidence the browser captured.

Drive one primary activity at a time. Use chat focus for a broad learner question or one genuine question that requires their answer. Do not switch to chat merely to acknowledge, explain, or debrief an observed activity result; keep that progression in work focus with one visible next action. Inline work clarification stays on the current canvas: call render_canvas with work focus, no messages, and one concrete action continuation; the server preserves the mounted editor and result while updating that cue. Keep implementation scaffolding backstage and show the subject's native artifact. Use a visual only for a named relationship: Figure for structure, Plot for quantitative change, Math for notation, and finite Params frames for a bounded state sequence. A control must immediately change a visible bound artifact; a plot illustrates rather than proves.

For every turn, call render_canvas exactly once—even when messages is empty—to publish structured continuation metadata. continuationKind is "question" for chat and "action" for work; a chat continuation contains a question mark. When creating or updating work, send actual A2UI v0.9 messages. A new canvas normally sends createSurface, updateComponents, and updateDataModel. Use catalogId "urn:learn-anything:catalog:v1". All messages include version "v0.9".

${A2UI_CATALOG_PROMPT}

Never claim code ran unless browser execution reports it. Use save_milestone after meaningful progress. Project source is read-only; the learning directory is writable. Current degraded capabilities: ${(session.assembly?.degraded || []).join(", ") || "none"}.`;
const state = createClaudeEventState();
let activeBrowserItem = null;
const sdkOptions = {
  abortController,
  cwd: sessionDir,
  additionalDirectories: session.sourceRoot && session.sourceRoot !== sessionDir ? [session.sourceRoot] : [],
  includePartialMessages: true,
  systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
  tools: ["Read", "Grep", "Glob"],
  allowedTools: ["Read", "Grep", "Glob", "mcp__learn_anything__render_canvas", "mcp__learn_anything__save_milestone"],
  mcpServers: { learn_anything: learningTools },
  ...(session.agentSessionId ? { resume: session.agentSessionId } : {}),
};
const warmQuery = await startup({ options: sdkOptions, initializeTimeoutMs: 20_000 });
await post(url, "/api/mentor/register", { mentorId, takeover: true }, token, mentorId);
await post(url, "/api/mentor/ready", {}, token, mentorId);
const sdkQuery = warmQuery.query(browserMessages(url, token, mentorId, abortController.signal, async (item) => {
  activeBrowserItem = item;
  continuationPostedThisTurn = false;
  activeRunId = crypto.randomUUID();
  await post(url, "/api/mentor/event", { type: "RUN_STARTED", threadId: session.slug, runId: activeRunId }, token, mentorId);
}));

const stop = () => abortController.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  for await (const message of sdkQuery) {
    for (const event of mapClaudeMessage(message, state)) {
      const learnerContext = activeBrowserItem?.type === "user_message" && activeBrowserItem.message?.source === "work"
        ? activeBrowserItem.message.context
        : null;
      const executionContext = activeBrowserItem?.type === "execution_result" && activeBrowserItem.componentId
        ? { componentId: activeBrowserItem.componentId, label: `${activeBrowserItem.language || "code"} code` }
        : null;
      const contextualEvent = event.type === "TEXT_MESSAGE_START" && (learnerContext || executionContext)
        ? { ...event, source: "work", context: learnerContext || executionContext }
        : event;
      await post(url, "/api/mentor/event", contextualEvent, token, mentorId);
    }
    if (message.type === "result") {
      const runId = activeRunId || message.uuid || crypto.randomUUID();
      if (message.subtype === "success" && !continuationPostedThisTurn) {
        await post(url, "/api/a2ui", fallbackCanvasForClaudeItem(activeBrowserItem), token, mentorId);
        continuationPostedThisTurn = true;
      }
      if (message.subtype === "success") await post(url, "/api/mentor/event", { type: "RUN_FINISHED", threadId: session.slug, runId, outcome: { type: "success" } }, token, mentorId);
      else await post(url, "/api/mentor/event", { type: "RUN_ERROR", message: (message.errors || []).join("\n") || message.subtype, code: message.subtype }, token, mentorId);
      activeRunId = null;
      activeBrowserItem = null;
    }
  }
} finally {
  await sdkQuery.close();
}
