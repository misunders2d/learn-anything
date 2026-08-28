#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { A2UI_CATALOG_PROMPT } from "../../a2ui/prompt.mjs";
import { plainTextMentorCandidate, reconcileMentorTurn } from "../mentor-turn.mjs";
import { PiRpcClient, piRpcArgs } from "./rpc-client.mjs";

const adapterDir = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(adapterDir, "mentor-extension.ts");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

class MentorHttpError extends Error {
  constructor(path, status, body) {
    super(`${path}: ${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

class MentorCandidateError extends Error {}

async function requestJson(url, path, token, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-learn-anything-token": token, ...(options.headers || {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new MentorHttpError(path, response.status, body);
  return body;
}

function mentorPost(url, path, token, mentorId, value) {
  return requestJson(url, path, token, {
    method: "POST",
    headers: { "x-learn-anything-mentor": mentorId },
    body: JSON.stringify(value),
  });
}

export function mentorSystemPrompt(topic) {
  return `You are the persistent mentor inside a local adaptive browser course about ${topic}.
The browser is the primary learning surface. Answer every browser event here; never send the learner to a terminal or another chat.
Assume no prior knowledge until demonstrated. Explain before testing. Keep adapter and runtime details out of learner-facing text.
React automatically only to code explicitly submitted to the mentor and answers captured by the browser. Do not ask the learner to repeat evidence.

Finish every turn by calling complete_mentor_turn exactly once. Never print JSON or protocol data as assistant prose.
- message: useful learner-facing answer.
- presentation "chat": broad question or a genuine question requiring the learner's answer.
- presentation "inline": only an explicitly anchored question about one visible component. Do not replace its canvas.
- presentation "activity": submitted work, observed activity feedback, or a new/updated visible exercise.
- task_title: required for activity; a short localized title naming the same current task as the instruction, artifact, action, and target. Omit it for chat/inline.
- continuation.kind: question for chat and action for activity/inline. Punctuation is optional.
- continuation.action_type: required for activity/inline; choose run, edit, answer, adjust, read, inspect, or submit so it matches both the main verb in continuation.text and the target component. Omit it for chat.
- continuation.text: one short sentence in the learner's language. For activity/inline, name exactly what to do now, the visible target, and expected evidence when useful. Never say only continue, next, complete the activity, or follow the mentor's guidance. If surface_plan already puts code or content into the target, do not tell the learner to copy, paste, insert, or type that same artifact; ask for the next real interaction with it.
- Keep one active task. Put its brief instruction immediately before its target component; supporting explanation and feedback follow it.
- surface_plan: omit when canvas stays unchanged. To change it, provide structured operations; never provide JSONL strings.

Surface operation kinds map to A2UI v0.9:
- create_surface: surface_id and optional catalog_id.
- update_components: surface_id and components array.
- update_data_model: surface_id, absolute path, and value.
- delete_surface: surface_id.
New work normally uses create_surface, update_components, and update_data_model. Catalog ID is urn:learn-anything:catalog:v1.
${A2UI_CATALOG_PROMPT}
Keep subject-native artifacts visible. Use visuals only for relationships learner needs to see. Never claim code ran unless browser execution reports it.`;
}

export function mentorEventPrompt(item, history = []) {
  let learnerInput;
  if (item.type === "user_message") {
    const anchored = item.message?.source === "work" && item.message?.context?.componentId;
    learnerInput = anchored
      ? `Anchored component question. Explain beside this component without replacing the current activity.\nQuestion: ${item.message.content}\nAnchor: ${JSON.stringify(item.message.context)}\nCanvas: ${JSON.stringify(item.canvasContext, null, 2)}`
      : item.message?.source === "work"
        ? `Question submitted from the work composer. Composer origin does not determine presentation; use chat for a broad question and activity only when visible work should change.\nQuestion: ${item.message.content}\nCurrent canvas: ${JSON.stringify(item.canvasContext, null, 2)}`
        : item.message.content;
  } else if (item.type === "execution_result") {
    learnerInput = `Learner explicitly submitted this ${item.language || "code"} work for feedback:\n${item.code || "(code unavailable)"}\n\nLatest execution result:\n${JSON.stringify(item.result, null, 2)}\n\nCurrent canvas:\n${JSON.stringify(item.canvasContext || null, null, 2)}`;
  } else {
    learnerInput = `Browser activity event:\n${JSON.stringify(item, null, 2)}`;
  }
  const transcript = history.map((message) => `${message.role === "assistant" ? "Mentor" : "Learner"}: ${message.content}`).join("\n\n");
  return `${transcript ? `Initialize this persistent mentor from recent browser transcript:\n${transcript}\n\n` : ""}Browser event:\n${learnerInput}\n\nCall complete_mentor_turn exactly once.`;
}

export function candidateFromPiTurn(turn) {
  if (turn.providerError) throw new Error(`Pi provider failed: ${turn.providerError}`);
  if (turn.toolResults.length > 1) throw new Error("Pi returned multiple complete_mentor_turn results.");
  if (turn.toolResults.length === 1) return turn.toolResults[0];
  return plainTextMentorCandidate(turn.assistantText);
}

async function createRpcClient({ command, sessionDir, sessionId, model, topic }) {
  const args = piRpcArgs({
    sessionDir,
    sessionId,
    model,
    systemPrompt: mentorSystemPrompt(topic),
    sessionName: sessionId ? `Learn Anything: ${topic}` : null,
    extensionPath,
  });
  const client = new PiRpcClient({ command, args, cwd: sessionDir });
  await client.ready();
  return client;
}

async function preflightPi(options) {
  const client = await createRpcClient({ ...options, sessionId: null });
  try {
    const turn = await client.prompt("Readiness check. Call complete_mentor_turn with message pi-ready, presentation chat, continuation kind question, continuation text What would you like to learn, and no surface plan.");
    const candidate = candidateFromPiTurn(turn);
    if (candidate.message !== "pi-ready") throw new Error("Pi provider readiness check returned an unexpected response.");
  } finally {
    client.close();
  }
}

async function commitTurn({ url, token, mentorId, item, before, candidate, runId, initializeSession }) {
  let reconciled;
  try {
    reconciled = reconcileMentorTurn(item, candidate, before, { runId });
  } catch (error) {
    throw new MentorCandidateError(error.message, { cause: error });
  }
  return mentorPost(url, "/api/mentor/turn", token, mentorId, {
    ...reconciled,
    initializeSession,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const url = (option(args, "--url") || "").replace(/\/$/, "");
  const sessionDir = resolve(option(args, "--session") || "");
  if (!url || !option(args, "--session")) throw new Error("Usage: adapter.mjs --url <server-url> --session <session-dir>");
  const saved = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
  const token = option(args, "--token") || saved.security?.accessToken;
  if (!token) throw new Error("Session has no access token.");
  if (!saved.agentSessionId) throw new Error("Session has no persistent Pi mentor session id.");
  await mkdir(join(sessionDir, "runtime", "mentor-sessions"), { recursive: true });

  const command = saved.assembly?.capabilities?.commands?.pi || "pi";
  await preflightPi({ command, sessionDir, model: saved.mentorModel, topic: saved.topic });
  const rpc = await createRpcClient({
    command,
    sessionDir,
    sessionId: saved.agentSessionId,
    model: saved.mentorModel,
    topic: saved.topic,
  });
  let activeModel = saved.mentorModel || null;
  const mentorId = randomUUID();
  const pollController = new AbortController();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    pollController.abort();
    try { await rpc.abort(); } catch {}
    rpc.close();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });

  await requestJson(url, "/api/mentor/register", token, { method: "POST", body: JSON.stringify({ mentorId, takeover: true }) });
  await mentorPost(url, "/api/mentor/ready", token, mentorId, {});

  while (!stopping) {
    const query = new URLSearchParams({ token, mentorId });
    let poll;
    try {
      poll = await fetch(`${url}/api/mentor/next?${query}`, { signal: pollController.signal });
    } catch (error) {
      if (stopping) break;
      throw error;
    }
    if (poll.status === 204) continue;
    const item = await poll.json().catch(() => null);
    if (!poll.ok) throw new Error(`Mentor poll failed: ${poll.status} ${JSON.stringify(item)}`);
    if (!item) continue;
    const runId = randomUUID();
    await mentorPost(url, "/api/mentor/event", token, mentorId, { type: "RUN_STARTED", threadId: saved.slug, runId, turnId: item.mentorTurn?.id });
    try {
      const before = await requestJson(url, "/api/session", token);
      if (before.mentorModel && before.mentorModel !== activeModel) {
        await rpc.setModel(before.mentorModel);
        activeModel = before.mentorModel;
      }
      const history = before.mentorSessionInitialized
        ? []
        : (before.transcript || []).filter((message) => message.id !== item.message?.id).slice(-12);
      let turn = await rpc.prompt(mentorEventPrompt(item, history));
      let candidate = candidateFromPiTurn(turn);
      try {
        await commitTurn({
          url, token, mentorId, item, before, candidate, runId,
          initializeSession: !before.mentorSessionInitialized,
        });
      } catch (error) {
        const rejectedLocally = error instanceof MentorCandidateError;
        const rejectedByHost = error instanceof MentorHttpError && error.status === 400;
        if (!rejectedLocally && !rejectedByHost) throw error;
        turn = await rpc.prompt(`Your structured browser candidate was rejected before publication: ${error.body?.error || error.message}\nCorrect the candidate. Preserve the useful learner answer. Return one concrete localized next action for work. Call complete_mentor_turn exactly once.`);
        candidate = candidateFromPiTurn(turn);
        const current = await requestJson(url, "/api/session", token);
        await commitTurn({
          url, token, mentorId, item, before: current, candidate, runId,
          initializeSession: !current.mentorSessionInitialized,
        });
      }
    } catch (error) {
      if (stopping) break;
      await mentorPost(url, "/api/mentor/event", token, mentorId, {
        type: "RUN_ERROR",
        message: error.message,
        code: "MENTOR_ERROR",
        turnId: item.mentorTurn?.id,
        runId,
      }).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
