#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { createSdkMcpServer, startup, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createClaudeEventState, mapClaudeMessage } from "./events.mjs";

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
        ? `Learner execution result (${item.language}):\n${JSON.stringify(item.result, null, 2)}`
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
const mentorId = crypto.randomUUID();
const renderCanvas = tool(
  "render_canvas",
  "Apply A2UI v0.9 messages to the browser learning canvas and set chat or work focus.",
  {
    focus: z.enum(["chat", "work"]),
    messages: z.array(z.record(z.string(), z.unknown())).max(100),
  },
  async ({ focus, messages }) => {
    try {
      const result = await post(url, "/api/a2ui", { focus, messages }, token, mentorId);
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

Drive one primary activity at a time. Use chat focus for explanation, questions, alignment, and debrief. Use work focus only after preparing one clear interactive task. Inline work clarification stays on the current canvas: answer without calling render_canvas so the editor and result remain mounted. Keep implementation scaffolding backstage and show the subject's native artifact.

When creating or updating work, call render_canvas with actual A2UI v0.9 messages. A new canvas normally sends createSurface, updateComponents, and updateDataModel. Use catalogId "urn:learn-anything:catalog:v1". updateComponents uses a flat adjacency list with one root component: {"id":"root","component":"Column","children":["intro"]}. Supported learning components are Markdown, Callout, Code, Table, Passage, Figure, Params, Mermaid, Quiz, and Checklist. Their property names match the kit stage catalog except the discriminator is component, not type. Code uses {language,value,runnable,run:{runner,setup?}}. All messages include version "v0.9". Never send executable UI code.

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
      if (message.subtype === "success") await post(url, "/api/mentor/event", { type: "RUN_FINISHED", threadId: session.slug, runId, outcome: { type: "success" } }, token, mentorId);
      else await post(url, "/api/mentor/event", { type: "RUN_ERROR", message: (message.errors || []).join("\n") || message.subtype, code: message.subtype }, token, mentorId);
      activeRunId = null;
      activeBrowserItem = null;
    }
  }
} finally {
  await sdkQuery.close();
}
