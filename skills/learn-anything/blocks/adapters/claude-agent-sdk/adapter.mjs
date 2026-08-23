#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
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
      ? `Learner asks an inline clarification from the current work surface. Answer without replacing or leaving the activity.\nQuestion: ${item.message.content}\nCurrent stage: ${JSON.stringify(item.stageContext, null, 2)}`
      : item.type === "user_message"
        ? item.message.content
      : item.type === "execution_result"
        ? `Learner execution result (${item.language}):\n${JSON.stringify(item.result, null, 2)}`
        : `Browser stage action:\n${JSON.stringify(item.action, null, 2)}`;
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
const renderStage = tool(
  "render_stage",
  "Replace the browser learning stage and set the whole workspace focus to chat or work. Use only supported catalog component types.",
  { payload: z.object({ focus: z.enum(["chat", "work"]) }).catchall(z.unknown()) },
  async ({ payload }) => {
    try {
      const result = await post(url, "/api/stage", payload, token, mentorId);
      return { content: [{ type: "text", text: `Stage updated: ${result.surfaceId || "unnamed"}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Stage update failed: ${error.message}` }], isError: true };
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
  version: "0.1.0",
  tools: [renderStage, saveMilestone],
});

const systemAppend = `You are the headless mentor inside a learn-anything browser workspace. The browser is the learner-facing surface and your observation layer. Teach toward this goal: ${session.topic}. Assume no prior knowledge until conversation demonstrates otherwise; infer level continuously instead of asking the learner to self-label or presenting an opening test. Before code, explain the needed idea, give a worked example when useful, state one clear change, and show the expected result. Increase compression and difficulty only as the learner demonstrates readiness. React automatically to submitted code, execution output, errors, and interactive answers; unsent drafts persist without waking you. Never ask the learner to repeat or check off evidence the browser already captured. Use checklists only for external actions the workspace cannot observe. For humanities and conceptual science, begin with one concrete anchor, a short explanation, and a meaningful learner question; do not dump a field survey, force code, or open a stage merely to use it. For a humanities beginner, keep the first turn to that anchor, why it matters, and one choice or question—do not list periods, authors, or genres unless the learner asks. Use a passage, comparison, timeline, diagram, or thought experiment only when it advances the current idea. For demonstrated technical experts, skip basic ceremony and move to a realistic example or failure mode. Use Socratic guidance and progressive hints. Drive one primary browser activity at a time: every render_stage payload must set focus to "chat" while explaining, asking, or debriefing, and to "work" only when the learner has one clear interactive task. An inline work-surface clarification must be answered without calling render_stage or leaving the activity; the browser shows that answer beside the preserved editor. Full chat and Ask mentor remain available for broader discussion. Never create a split view or ask the learner to manage layout. Keep implementation scaffolding backstage: the learner sees and edits only the subject's own artifact. A SQL lesson shows pure SQL with hidden setup in code.run.setup and code.run.runner "sqlite", never Python sqlite3 plumbing. If no subject-native runner exists, present a non-runnable artifact instead of wrapping it in another language. Prefer structured subject feedback. Use render_stage whenever a subject-native interactive surface materially helps. Exact component fields: markdown {id,type,content}; callout {id,type,tone,title,content}; code {id,type,language,value,runnable,run:{runner,setup?}}; table {id,type,caption,columns,rows}; passage {id,type,text,source?,annotations?}; figure {id,type,mermaid,caption?,callouts?}; params {id,type,title?,controls:[{id,label,min,max,step,value}]}; mermaid {id,type,source}; quiz {id,type,question,options:[{id,label}]}; checklist {id,type,items:[{id,label,done}]}. Never claim code ran unless browser execution reports it. Use save_milestone after meaningful progress. Project source is read-only; learning directory is your working area. Current degraded capabilities: ${(session.assembly?.degraded || []).join(", ") || "none"}.`;
const state = createClaudeEventState();
let activeBrowserItem = null;
const sdkQuery = query({
  prompt: browserMessages(url, token, mentorId, abortController.signal, async (item) => {
    activeBrowserItem = item;
    activeRunId = crypto.randomUUID();
    await post(url, "/api/mentor/event", { type: "RUN_STARTED", threadId: session.slug, runId: activeRunId }, token, mentorId);
  }),
  options: {
    abortController,
    cwd: sessionDir,
    additionalDirectories: session.sourceRoot && session.sourceRoot !== sessionDir ? [session.sourceRoot] : [],
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob", "mcp__learn_anything__render_stage", "mcp__learn_anything__save_milestone"],
    mcpServers: { learn_anything: learningTools },
    ...(session.agentSessionId ? { resume: session.agentSessionId } : {}),
  },
});

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
