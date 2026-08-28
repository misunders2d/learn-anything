import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { candidateFromPiTurn, mentorEventPrompt, mentorSystemPrompt } from "../skills/learn-anything/blocks/adapters/pi-cli/adapter.mjs";
import { composeSurfacePlan, plainTextMentorCandidate, reconcileMentorTurn } from "../skills/learn-anything/blocks/adapters/mentor-turn.mjs";
import { actionRepeatsVisibleState } from "../skills/learn-anything/blocks/continuation.mjs";
import { collectPiRpcTurn, PiRpcClient, piRpcArgs } from "../skills/learn-anything/blocks/adapters/pi-cli/rpc-client.mjs";
import { parsePiModelList } from "../skills/learn-anything/blocks/adapters/pi-cli/models.mjs";

const extensionPath = "/tmp/course/mentor-extension.ts";

test("Pi mentor uses persistent RPC with only the terminating mentor tool", () => {
  const args = piRpcArgs({
    sessionDir: "/tmp/course",
    sessionId: "course-mentor-id",
    sessionName: "Learn Anything: Python decorators",
    model: "openai-codex/gpt-5.6-sol",
    systemPrompt: "mentor contract",
    extensionPath,
  });
  assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(args[args.indexOf("--session-id") + 1], "course-mentor-id");
  assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-sol");
  assert.match(args[args.indexOf("--session-dir") + 1], /runtime\/mentor-sessions$/);
  assert.equal(args[args.indexOf("--tools") + 1], "complete_mentor_turn");
  assert.equal(args.includes("--no-builtin-tools"), true);
  assert.equal(args.includes("--no-tools"), false);
  assert.equal(args[args.indexOf("--extension") + 1], extensionPath);
  assert.equal(piRpcArgs({ sessionDir: "/tmp/course", extensionPath }).includes("--no-session"), true);
});

test("Pi mentor prompt separates composer origin from learner intent", () => {
  const broadWorkQuestion = mentorEventPrompt({
    type: "user_message",
    message: { content: "Почему декораторы вообще нужны?", source: "work" },
    canvasContext: { activeSurfaceId: "lesson" },
  });
  const anchored = mentorEventPrompt({
    type: "user_message",
    message: { content: "What does this line do?", source: "work", context: { componentId: "code" } },
    canvasContext: { activeSurfaceId: "lesson" },
  });
  assert.match(broadWorkQuestion, /origin does not determine presentation/i);
  assert.match(broadWorkQuestion, /use chat for a broad question/i);
  assert.match(anchored, /anchored component question/i);
  assert.match(mentorSystemPrompt("decorators"), /complete_mentor_turn exactly once/i);
  assert.doesNotMatch(mentorSystemPrompt("decorators"), /a2ui_jsonl|Return only one valid JSON/i);
});

test("RPC turn uses validated tool details and never parses JSON-looking prose", () => {
  const details = {
    contractVersion: 1,
    message: "Decorators wrap behavior.",
    presentation: "chat",
    continuation: { kind: "question", text: "Want a tiny example" },
  };
  const turn = collectPiRpcTurn([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "```json\n{not valid}\n```" }], stopReason: "toolUse" } },
    { type: "tool_execution_end", toolName: "complete_mentor_turn", isError: false, result: { details } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(candidateFromPiTurn(turn), details);
});

test("plain assistant prose is safe fallback content, not parsed control data", () => {
  const turn = collectPiRpcTurn([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A decorator receives a function and returns behavior around it. {not control JSON}" }], stopReason: "stop" } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(candidateFromPiTurn(turn), plainTextMentorCandidate(turn.assistantText));
  assert.throws(() => candidateFromPiTurn({ toolResults: [], assistantText: "", providerError: null }), /neither a completed mentor tool call nor learner-facing text/i);
});

test("persistent RPC switches model between turns without replacing its process", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-rpc-test-"));
  const fake = join(root, "fake-rpc.mjs");
  await writeFile(fake, `
let buffer = "";
let model = { provider: "openai-codex", id: "gpt-a" };
let prompts = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") send({ id: command.id, type: "response", command: "get_state", success: true, data: { model } });
    if (command.type === "set_model") { model = { provider: command.provider, id: command.modelId }; send({ id: command.id, type: "response", command: "set_model", success: true, data: model }); }
    if (command.type === "prompt") {
      prompts += 1;
      send({ id: command.id, type: "response", command: "prompt", success: true });
      send({ type: "tool_execution_end", toolName: "complete_mentor_turn", isError: false, result: { details: { contractVersion: 1, message: model.id + ":" + prompts, presentation: "chat", continuation: { kind: "question", text: "Next" } } } });
      send({ type: "agent_settled" });
    }
  }
});
`, "utf8");
  const client = new PiRpcClient({ command: process.execPath, args: [fake], cwd: root, timeoutMs: 5_000 });
  try {
    assert.equal((await client.ready()).model.id, "gpt-a");
    assert.equal((await client.prompt("first")).toolResults[0].message, "gpt-a:1");
    await client.setModel("anthropic/claude-b");
    assert.equal((await client.prompt("second")).toolResults[0].message, "claude-b:2");
    assert.equal(client.child.exitCode, null);
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider failures remain operational and cannot become learner text", () => {
  const turn = collectPiRpcTurn([
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" } },
    { type: "agent_settled" },
  ]);
  assert.throws(() => candidateFromPiTurn(turn), /provider failed: provider unavailable/i);
});

test("surface plans become host-owned A2UI envelopes", () => {
  assert.deepEqual(composeSurfacePlan({ operations: [
    { kind: "create_surface", surface_id: "lesson" },
    { kind: "update_components", surface_id: "lesson", components: [{ id: "root", component: "Column", children: [] }] },
    { kind: "update_data_model", surface_id: "lesson", path: "/", value: { title: "Decorators" } },
  ] }), [
    { version: "v0.9", createSurface: { surfaceId: "lesson", catalogId: "urn:learn-anything:catalog:v1" } },
    { version: "v0.9", updateComponents: { surfaceId: "lesson", components: [{ id: "root", component: "Column", children: [] }] } },
    { version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/", value: { title: "Decorators" } } },
  ]);
  assert.throws(() => composeSurfacePlan({ operations: [{ kind: "update_data_model", surface_id: "lesson", path: "title", value: "bad" }] }), /absolute data-model path/i);
});

test("broad work-composer questions can move to chat and missing punctuation is normalized", () => {
  const item = {
    type: "user_message",
    message: { id: "learner-1", source: "work", content: "Почему декораторы нужны?" },
    mentorTurn: { id: "turn-1", baseRevision: 7 },
  };
  const result = reconcileMentorTurn(item, {
    message: "Они отделяют повторяемое поведение от основной функции.",
    presentation: "chat",
    continuation: { kind: "question", text: "Показать короткий пример" },
  }, {
    canvas: { activeSurfaceId: "lesson" },
    continuation: { kind: "action", text: "Edit the visible code." },
  }, { runId: "run-1" });
  assert.equal(result.focus, "chat");
  assert.equal(result.presentation, "chat");
  assert.equal(result.continuation.text, "Показать короткий пример?");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.baseRevision, 7);
});

test("visible code cannot be assigned as a copy-paste step after the host already placed it", () => {
  const canvas = {
    activeSurfaceId: "lesson",
    surfaces: { lesson: { components: { code: { id: "code", component: "Code", value: "print('ok')" } } } },
  };
  assert.equal(actionRepeatsVisibleState("Скопируй этот код в блок code и нажми Run.", canvas, "code"), true);
  assert.equal(actionRepeatsVisibleState("Нажми Run и проверь строку ok.", canvas, "code"), false);

  canvas.surfaces.lesson.components.practice = { id: "practice", component: "Code", value: "" };
  assert.equal(actionRepeatsVisibleState("Copy this code into the practice editor.", canvas, "practice"), false);
  assert.equal(actionRepeatsVisibleState("Copy this code into the worked example.", canvas, "code"), true);
});

test("work turns reject generic fallback instructions and require one concrete localized action", () => {
  const item = {
    type: "execution_result",
    language: "python",
    componentId: "code",
    mentorTurn: { id: "turn-action", baseRevision: 2 },
  };
  const session = { canvas: { activeSurfaceId: "lesson" }, continuation: null };
  assert.throws(() => reconcileMentorTurn(item, {
    message: "Вывод верный.",
    presentation: "activity",
    task_title: "Проверка вывода",
    continuation: { kind: "action", text: "Complete the next unfinished step in the visible activity using the mentor's guidance.", action_type: "inspect" },
  }, session), /one concrete visible action/i);
  assert.throws(() => reconcileMentorTurn(item, {
    message: "Вывод верный.",
    presentation: "activity",
    task_title: "Проверка вывода",
    continuation: { kind: "none", text: "", action_type: "inspect" },
  }, session), /one concrete visible action/i);

  assert.throws(() => reconcileMentorTurn(item, {
    message: "Вывод верный.",
    presentation: "activity",
    continuation: { kind: "action", text: "Нажми Run и проверь строку Сумма: 5." },
  }, session), /localized task_title/i);

  const result = reconcileMentorTurn(item, {
    message: "Вывод верный.",
    presentation: "activity",
    task_title: "Повтор функции два раза",
    continuation: { kind: "action", text: "Замени 3 на 2 в repeat, затем запусти код и проверь две строки «Сумма: 5».", action_type: "edit" },
    target_component_id: "code",
  }, session);
  assert.equal(result.focus, "work");
  assert.equal(result.taskTitle, "Повтор функции два раза");
  assert.equal(result.context.componentId, "code");
  assert.deepEqual(result.continuation, {
    kind: "action",
    text: "Замени 3 на 2 в repeat, затем запусти код и проверь две строки «Сумма: 5».",
    taskTitle: "Повтор функции два раза",
    targetComponentId: "code",
    actionType: "edit",
  });
});

test("only explicitly anchored work questions force inline presentation", () => {
  const item = {
    type: "user_message",
    message: { source: "work", content: "Why?", context: { componentId: "code" } },
    mentorTurn: { id: "turn-2", baseRevision: 9 },
  };
  const result = reconcileMentorTurn(item, {
    message: "That line applies the wrapper.",
    presentation: "chat",
    continuation: { kind: "question", text: "Does that make sense" },
    surface_plan: { operations: [{ kind: "delete_surface", surface_id: "lesson" }] },
  }, {
    canvas: {
      activeSurfaceId: "lesson",
      surfaces: { lesson: { dataModel: { title: "Wrapped function" }, components: { code: { id: "code", component: "Code" } } } },
    },
    continuation: { kind: "action", text: "Change the wrapped function, then run it.", taskTitle: "Wrapped function", targetComponentId: "code", actionType: "edit" },
  });
  assert.equal(result.presentation, "inline");
  assert.equal(result.focus, "work");
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.continuation, {
    kind: "action",
    text: "Change the wrapped function, then run it.",
    taskTitle: "Wrapped function",
    targetComponentId: "code",
    actionType: "edit",
  });
  assert.equal(result.context.componentId, "code");
});

test("Pi model list parser returns provider-qualified selectable models", () => {
  const models = parsePiModelList(`provider        model             context  max-out  thinking  images\nopenai-codex    gpt-5.6-sol       272K     128K     yes       yes\nanthropic       claude-haiku-4-5  200K     64K      yes       yes\n`);
  assert.deepEqual(models.map(({ id }) => id), ["openai-codex/gpt-5.6-sol", "anthropic/claude-haiku-4-5"]);
  assert.equal(models[0].thinking, true);
});
