import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyA2uiMessages,
  applyParameterFrame,
  createInitialCanvas,
  resolveDataBinding,
} from "../skills/learn-anything/blocks/a2ui/state.mjs";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";

async function request(address, path, options = {}, mentorId = null) {
  const response = await fetch(`${address.url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": address.accessToken,
      ...(mentorId ? { "x-learn-anything-mentor": mentorId } : {}),
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}

async function fixture({ profile = "portable-shell", modelCatalogLoader } = {}) {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-a2ui-"));
  const constructed = await constructSession({ topic: "Python protocols", root, profile });
  const runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0, modelCatalogLoader });
  const address = await runtime.listen();
  return { root, constructed, runtime, address };
}

test("saved generic work guidance is removed and queued for mentor repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-continuation-repair-"));
  let runtime;
  try {
    const constructed = await constructSession({ topic: "Python decorators", root, profile: "portable-shell" });
    const session = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    session.canvas = {
      focus: "work",
      activeSurfaceId: "lesson",
      surfaces: {
        lesson: {
          id: "lesson",
          dataModel: { title: "Decorator task" },
          components: {
            root: { id: "root", component: "Column", children: ["code"] },
            code: { id: "code", component: "Code", language: "python", value: "print('ok')", runnable: true },
          },
        },
      },
    };
    session.continuation = { kind: "action", text: "Complete the next unfinished step in the visible activity using the mentor's guidance." };
    await writeFile(constructed.sessionPath, `${JSON.stringify(session, null, 2)}\n`);

    runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0 });
    const address = await runtime.listen();
    const mentorId = "repair-mentor";
    const registered = await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    assert.equal(registered.response.status, 202);
    const next = await request(address, `/api/mentor/next?mentorId=${mentorId}`, { method: "GET" });
    assert.equal(next.response.status, 200);
    assert.equal(next.body.type, "stage_action");
    assert.equal(next.body.action, "repair_activity_focus");
    const snapshot = await request(address, "/api/session");
    assert.equal(snapshot.body.continuation, null);
    assert.equal(snapshot.body.canvas.focus, "work");

    const repaired = await request(address, "/api/mentor/turn", {
      method: "POST",
      body: JSON.stringify({
        turnId: next.body.mentorTurn.id,
        baseRevision: next.body.mentorTurn.baseRevision,
        message: "Переходим к цепочке двух декораторов.",
        presentation: "activity",
        taskTitle: "Цепочка двух декораторов",
        focus: "work",
        continuation: { kind: "action", text: "Нажми Run в блоке code и проверь строку ПРИВЕТ, АНЯ!.", taskTitle: "Цепочка двух декораторов", targetComponentId: "code", actionType: "run" },
        messages: [],
        context: { componentId: "code" },
      }),
    }, mentorId);
    assert.equal(repaired.response.status, 201);
    const afterRepair = await request(address, "/api/session");
    assert.equal(afterRepair.body.canvas.surfaces.lesson.dataModel.title, "Цепочка двух декораторов");
    assert.equal(afterRepair.body.continuation.text, "Нажми Run в блоке code и проверь строку ПРИВЕТ, АНЯ!.");
    const repairedSession = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(repairedSession.activityContractVersion, 1);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter-neutral work contract survives restart without a repair loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-portable-activity-"));
  let runtime;
  try {
    const constructed = await constructSession({ topic: "Portable activity", root, profile: "portable-shell" });
    runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0 });
    let address = await runtime.listen();
    const mentorId = "portable-mentor";
    await request(address, "/api/mentor/register", { method: "POST", body: JSON.stringify({ mentorId, takeover: true }) });
    const posted = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({
        focus: "work",
        continuation: { kind: "action", text: "Copy the worked example into the practice code editor.", taskTitle: "Portable code check", targetComponentId: "code", actionType: "edit" },
        messages: [
          { version: "v0.9", createSurface: { surfaceId: "lesson", catalogId: "urn:learn-anything:catalog:v1" } },
          { version: "v0.9", updateComponents: { surfaceId: "lesson", components: [
            { id: "root", component: "Column", children: ["example", "code"] },
            { id: "example", component: "Code", language: "javascript", value: "console.log('ok')", runnable: false },
            { id: "code", component: "Code", language: "javascript", value: "", runnable: true },
          ] } },
        ],
      }),
    }, mentorId);
    assert.equal(posted.response.status, 202);
    await runtime.close();

    runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0 });
    address = await runtime.listen();
    const resumed = await request(address, "/api/session");
    assert.deepEqual(resumed.body.continuation, {
      kind: "action",
      text: "Copy the worked example into the practice code editor.",
      taskTitle: "Portable code check",
      targetComponentId: "code",
      actionType: "edit",
    });
    assert.equal(resumed.body.canvas.surfaces.lesson.dataModel.title, "Portable code check");
    const persisted = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(persisted.activityContractVersion, 1);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("surface direction is validated and persisted in the A2UI data model", () => {
  const initial = createInitialCanvas("Arabic reading");
  assert.equal(initial.surfaces.lesson.dataModel.direction, "ltr");

  const rtl = applyA2uiMessages(initial, [{
    version: "v0.9",
    updateDataModel: { surfaceId: "lesson", path: "/direction", value: "rtl" },
  }], { focus: "work" });
  assert.equal(rtl.surfaces.lesson.dataModel.direction, "rtl");

  assert.throws(() => applyA2uiMessages(rtl, [{
    version: "v0.9",
    updateDataModel: { surfaceId: "lesson", path: "/direction", value: "sideways" },
  }], { focus: "work" }), /direction must be ltr, rtl, or auto/i);
});

test("code runs stay local until the learner submits the latest result", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "code-submit-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({
        focus: "work",
        continuation: { kind: "action", text: "Experiment, then submit the result when ready.", taskTitle: "Experiment", targetComponentId: "code", actionType: "submit" },
        messages: [
          { version: "v0.9", createSurface: { surfaceId: "experiment", catalogId: "urn:learn-anything:catalog:v1" } },
          { version: "v0.9", updateComponents: { surfaceId: "experiment", components: [
            { id: "root", component: "Column", children: ["code"] },
            { id: "code", component: "Code", language: "javascript", value: "console.log('one')", runnable: true, run: { runner: "javascript" } },
          ] } },
          { version: "v0.9", updateDataModel: { surfaceId: "experiment", path: "/", value: { title: "Experiment" } } },
        ],
      }),
    }, mentorId);

    let mentorReceived = false;
    const nextMentorItem = request(address, `/api/mentor/next?mentorId=${mentorId}`).then((value) => {
      mentorReceived = true;
      return value;
    });
    const run = await request(address, "/api/run", {
      method: "POST",
      body: JSON.stringify({ componentId: "code", language: "javascript", code: "console.log('two')" }),
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.body.stdout, "two\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mentorReceived, false);

    const submit = await request(address, "/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "submit_code", componentId: "code", code: "console.log('two')" }),
    });
    assert.equal(submit.response.status, 202);
    const delivered = await nextMentorItem;
    assert.equal(delivered.response.status, 200);
    assert.equal(delivered.body.type, "execution_result");
    assert.equal(delivered.body.submitted, true);
    assert.equal(delivered.body.code, "console.log('two')");
    assert.equal(delivered.body.result.stdout, "two\n");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("model selection stays unavailable for adapters that do not own a Pi model catalog", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const catalog = await request(address, "/api/models");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.supported, false);
    assert.deepEqual(catalog.body.models, []);
    const change = await request(address, "/api/model", {
      method: "POST",
      body: JSON.stringify({ model: "openai-codex/gpt-5.4-mini" }),
    });
    assert.equal(change.response.status, 409);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("per-course mentor model selection persists without replacing the Pi session", async () => {
  const modelCatalogLoader = async () => ({
    defaultModel: "openai-codex/gpt-5.6-sol",
    models: [
      { id: "openai-codex/gpt-5.6-sol", provider: "openai-codex", model: "gpt-5.6-sol" },
      { id: "openai-codex/gpt-5.4-mini", provider: "openai-codex", model: "gpt-5.4-mini" },
    ],
  });
  const state = await fixture({ profile: "pi-cli", modelCatalogLoader });
  let runtime = state.runtime;
  let address = state.address;
  const mentorId = "persistent-model-mentor";
  try {
    const catalog = await request(address, "/api/models");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.selectedModel, "openai-codex/gpt-5.6-sol");
    assert.deepEqual(catalog.body.models.map((model) => model.id), ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.4-mini"]);

    const invalid = await request(address, "/api/model", {
      method: "POST",
      body: JSON.stringify({ model: "made-up/missing" }),
    });
    assert.equal(invalid.response.status, 400);

    const selected = await request(address, "/api/model", {
      method: "POST",
      body: JSON.stringify({ model: "openai-codex/gpt-5.4-mini" }),
    });
    assert.equal(selected.response.status, 202);
    assert.equal(selected.body.selectedModel, "openai-codex/gpt-5.4-mini");
    const afterSelection = await request(address, "/api/session");
    assert.equal(afterSelection.body.mentorState, "idle");

    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    await request(address, "/api/mentor/session-ready", { method: "POST", body: "{}" }, mentorId);
    const beforeRestart = JSON.parse(await readFile(state.constructed.sessionPath, "utf8"));
    assert.ok(beforeRestart.agentSessionId);
    assert.equal(beforeRestart.mentorModel, "openai-codex/gpt-5.4-mini");
    assert.equal(beforeRestart.mentorSessionInitialized, true);

    await runtime.close();
    runtime = await createLearnAnythingServer({
      sessionDir: state.constructed.sessionDir,
      kitRoot,
      port: 0,
      modelCatalogLoader,
    });
    address = await runtime.listen();
    const resumed = await request(address, "/api/session");
    const afterRestart = JSON.parse(await readFile(state.constructed.sessionPath, "utf8"));
    assert.equal(resumed.body.mentorModel, "openai-codex/gpt-5.4-mini");
    assert.equal(resumed.body.mentorSessionInitialized, true);
    assert.equal(afterRestart.agentSessionId, beforeRestart.agentSessionId);
  } finally {
    await runtime.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("mentor turn commit publishes transcript, canvas, continuation, and completion atomically", async () => {
  const { root, constructed, runtime, address } = await fixture();
  const mentorId = "atomic-turn-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    await request(address, "/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "Почему декораторы нужны?", source: "work", surfaceId: "lesson" }),
    });
    const next = await request(address, `/api/mentor/next?mentorId=${mentorId}`);
    assert.equal(next.response.status, 200);
    assert.ok(next.body.mentorTurn.id);
    assert.equal(Number.isInteger(next.body.mentorTurn.baseRevision), true);
    await request(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({ type: "RUN_STARTED", runId: "run-atomic", turnId: next.body.mentorTurn.id }),
    }, mentorId);

    const before = (await request(address, "/api/session")).body;
    const invalid = await request(address, "/api/mentor/turn", {
      method: "POST",
      body: JSON.stringify({
        turnId: next.body.mentorTurn.id,
        baseRevision: next.body.mentorTurn.baseRevision,
        runId: "run-atomic",
        message: "Useful answer must survive a bad canvas proposal.",
        focus: "work",
        continuation: { kind: "action", text: "Inspect the visible cycle.", taskTitle: "Cycle", targetComponentId: "root", actionType: "inspect" },
        messages: [
          { version: "v0.9", createSurface: { surfaceId: "cycle", catalogId: "urn:learn-anything:catalog:v1" } },
          { version: "v0.9", updateComponents: { surfaceId: "cycle", components: [{ id: "root", component: "Column", children: ["root"] }] } },
        ],
      }),
    }, mentorId);
    assert.equal(invalid.response.status, 400);
    const afterInvalid = (await request(address, "/api/session")).body;
    assert.deepEqual(afterInvalid.transcript, before.transcript);
    assert.deepEqual(afterInvalid.canvas, before.canvas);
    assert.deepEqual(afterInvalid.continuation, before.continuation);
    assert.equal(afterInvalid.mentorRevision, before.mentorRevision);

    const committed = await request(address, "/api/mentor/turn", {
      method: "POST",
      body: JSON.stringify({
        turnId: next.body.mentorTurn.id,
        baseRevision: next.body.mentorTurn.baseRevision,
        runId: "run-atomic",
        initializeSession: true,
        message: "Декоратор отделяет повторяемое поведение от основной функции.",
        presentation: "chat",
        focus: "chat",
        continuation: { kind: "question", text: "Показать короткий пример?" },
        messages: [],
      }),
    }, mentorId);
    assert.equal(committed.response.status, 201);
    assert.equal(committed.body.committed, true);
    const current = (await request(address, "/api/session")).body;
    assert.equal(current.transcript.at(-1).content, "Декоратор отделяет повторяемое поведение от основной функции.");
    assert.equal(current.canvas.focus, "chat");
    assert.deepEqual(current.continuation, { kind: "question", text: "Показать короткий пример?" });
    assert.equal(current.mentorSessionInitialized, true);
    assert.equal(current.mentorState, "idle");
    assert.equal(current.mentorRevision, before.mentorRevision + 1);

    const duplicate = await request(address, "/api/mentor/turn", {
      method: "POST",
      body: JSON.stringify({ turnId: next.body.mentorTurn.id }),
    }, mentorId);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.idempotent, true);
    const persisted = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(persisted.transcript.filter((message) => message.id === committed.body.messageId).length, 1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operational mentor failures stay out of learner transcript and persist as diagnostics", async () => {
  const { root, constructed, runtime, address } = await fixture();
  const mentorId = "diagnostic-mentor";
  try {
    await request(address, "/api/mentor/register", { method: "POST", body: JSON.stringify({ mentorId, takeover: true }) });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const before = (await request(address, "/api/session")).body.transcript.length;
    const failed = await request(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({ type: "RUN_ERROR", code: "MENTOR_ERROR", message: "provider failed", runId: "run-failed" }),
    }, mentorId);
    assert.equal(failed.response.status, 202);
    assert.equal((await request(address, "/api/session")).body.transcript.length, before);
    const persisted = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(persisted.mentorDiagnostics.at(-1).message, "provider failed");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("server persists real A2UI v0.9 surface messages", async () => {
  const { root, constructed, runtime, address } = await fixture();
  const mentorId = "a2ui-test-mentor";
  try {
    const mentorReady = runtime.waitForMentor(1_000);
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    await mentorReady;
    const next = request(address, `/api/mentor/next?mentorId=${mentorId}`);

    const messages = [
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "lesson",
          catalogId: "urn:learn-anything:catalog:v1",
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "lesson",
          components: [
            { id: "root", component: "Column", children: ["intro", "editor"] },
            { id: "intro", component: "Markdown", content: { path: "/intro" } },
            { id: "editor", component: "Code", language: "python", value: "print('ready')", runnable: true },
          ],
        },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "lesson",
          path: "/",
          value: { intro: "Build the protocol, not a stage-shaped imitation." },
        },
      },
    ];

    const beforeValidation = (await request(address, "/api/session")).body.canvas;
    const validated = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages, continuation: { kind: "action", text: "Run the protocol example.", taskTitle: "Protocol example", targetComponentId: "editor", actionType: "run" } }),
    }, mentorId);
    assert.equal(validated.response.status, 200);
    assert.equal(validated.body.valid, true);
    assert.deepEqual((await request(address, "/api/session")).body.canvas, beforeValidation);

    const updated = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages, continuation: { kind: "action", text: "Run the protocol example.", taskTitle: "Protocol example", targetComponentId: "editor", actionType: "run" } }),
    }, mentorId);
    assert.equal(updated.response.status, 202);
    assert.equal(updated.body.surfaceId, "lesson");

    const sessionResponse = await request(address, "/api/session");
    assert.equal(sessionResponse.body.canvas.focus, "work");
    assert.equal(sessionResponse.body.canvas.activeSurfaceId, "lesson");
    assert.equal(sessionResponse.body.canvas.surfaces.lesson.components.editor.component, "Code");
    assert.equal(sessionResponse.body.canvas.surfaces.lesson.dataModel.intro, "Build the protocol, not a stage-shaped imitation.");
    assert.deepEqual(sessionResponse.body.continuation, { kind: "action", text: "Run the protocol example.", taskTitle: "Protocol example", targetComponentId: "editor", actionType: "run" });

    const repeatedVisibleState = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Copy this code into the visible editor.", taskTitle: "Protocol example", targetComponentId: "editor", actionType: "edit" } }),
    }, mentorId);
    assert.equal(repeatedVisibleState.response.status, 400);
    assert.match(repeatedVisibleState.body.error, /already visible/i);
    const customRepeatedVisibleState = await request(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({
        type: "CUSTOM",
        name: "a2ui",
        value: { focus: "work", messages: [], continuation: { kind: "action", text: "Copy this code into the visible editor.", taskTitle: "Protocol example", targetComponentId: "editor", actionType: "edit" } },
      }),
    }, mentorId);
    assert.equal(customRepeatedVisibleState.response.status, 400);
    assert.match(customRepeatedVisibleState.body.error, /already visible/i);

    const persisted = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(persisted.canvas.surfaces.lesson.components.root.component, "Column");
    assert.equal("stage" in persisted, false);

    await request(address, "/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "continue" }),
    });
    await next;
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic activity feedback cannot hide existing work in chat", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "activity-focus-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const messages = [
      { version: "v0.9", createSurface: { surfaceId: "lesson", catalogId: "urn:learn-anything:catalog:v1" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "lesson",
          components: [
            { id: "root", component: "Column", children: ["quiz"] },
            { id: "quiz", component: "Quiz", question: "Which value?", options: [{ id: "a", label: "A" }] },
          ],
        },
      },
    ];
    await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages, continuation: { kind: "action", text: "Answer the visible quiz.", taskTitle: "Quiz task", targetComponentId: "quiz", actionType: "answer" } }),
    }, mentorId);
    await request(address, "/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "quiz_answer", componentId: "quiz", optionId: "a" }),
    });
    const next = await request(address, `/api/mentor/next?mentorId=${mentorId}`);
    assert.equal(next.body.type, "stage_action");

    const missingContinuation = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [] }),
    }, mentorId);
    assert.equal(missingContinuation.response.status, 400);
    assert.match(missingContinuation.body.error, /requires continuation metadata/i);
    const missingTarget = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Answer the visible quiz.", taskTitle: "Quiz task", actionType: "answer" } }),
    }, mentorId);
    assert.equal(missingTarget.response.status, 400);
    assert.match(missingTarget.body.error, /targetComponentId/i);
    const layoutTarget = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Answer the visible quiz.", taskTitle: "Quiz task", targetComponentId: "root", actionType: "answer" } }),
    }, mentorId);
    assert.equal(layoutTarget.response.status, 400);
    assert.match(layoutTarget.body.error, /non-layout component/i);

    const vagueChat = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "chat", messages: [], continuation: { kind: "question", text: "Continue when ready" } }),
    }, mentorId);
    assert.equal(vagueChat.response.status, 400);
    assert.match(vagueChat.body.error, /meaningful direct question/i);
    const punctuationOnly = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "chat", messages: [], continuation: { kind: "question", text: "?" } }),
    }, mentorId);
    assert.equal(punctuationOnly.response.status, 400);
    assert.match(punctuationOnly.body.error, /meaningful direct question/i);

    for (const text of ["Continue.", "?", "Do it.", "Do the task.", "Сделай это.", "Выполни задание.", "Complete the next unfinished step in the visible activity using the mentor's guidance."]) {
      const invalidAction = await request(address, "/api/a2ui?validate=1", {
        method: "POST",
        body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text } }),
      }, mentorId);
      assert.equal(invalidAction.response.status, 400);
      assert.match(invalidAction.body.error, /concrete visible action/i);
    }

    for (const value of [undefined, null, { focus: "work", messages: [] }]) {
      const customMissing = await request(address, "/api/mentor/event", {
        method: "POST",
        body: JSON.stringify({ type: "CUSTOM", name: "a2ui", ...(value !== undefined ? { value } : {}) }),
      }, mentorId);
      assert.equal(customMissing.response.status, 400);
      assert.match(customMissing.body.error, value?.messages ? /requires continuation metadata/i : /must be an object/i);
    }
    for (const text of ["Continue.", "?", "Do it.", "Do the task.", "Сделай это.", "Выполни задание.", "Complete the next unfinished step in the visible activity using the mentor's guidance."]) {
      const customInvalidAction = await request(address, "/api/mentor/event", {
        method: "POST",
        body: JSON.stringify({ type: "CUSTOM", name: "a2ui", value: { focus: "work", messages: [], continuation: { kind: "action", text } } }),
      }, mentorId);
      assert.equal(customInvalidAction.response.status, 400);
      assert.match(customInvalidAction.body.error, /concrete visible action/i);
    }
    const customHidden = await request(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({
        type: "CUSTOM",
        name: "a2ui",
        value: { focus: "chat", messages: [], continuation: { kind: "question", text: "What did you notice?" } },
      }),
    }, mentorId);
    assert.equal(customHidden.response.status, 400);
    assert.match(customHidden.body.error, /must remain in work focus/i);

    const hidden = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "chat", messages: [], continuation: { kind: "question", text: "What did you notice?" } }),
    }, mentorId);
    assert.equal(hidden.response.status, 400);
    assert.match(hidden.body.error, /must remain in work focus/i);

    const visible = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Answer the visible quiz.", taskTitle: "Quiz task", targetComponentId: "quiz", actionType: "answer" } }),
    }, mentorId);
    assert.equal(visible.response.status, 200);
    const wrongTarget = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Run the visible code.", taskTitle: "Quiz task", targetComponentId: "quiz", actionType: "run" } }),
    }, mentorId);
    assert.equal(wrongTarget.response.status, 400);
    assert.match(wrongTarget.body.error, /incompatible/i);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inline work preserves canvas and explicitly updates continuation on both mentor ingresses", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "inline-continuation-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const messages = [
      { version: "v0.9", createSurface: { surfaceId: "lesson", catalogId: "urn:learn-anything:catalog:v1" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "lesson",
          components: [
            { id: "root", component: "Column", children: ["instruction", "code"] },
            { id: "instruction", component: "Markdown", content: "Change the visible value." },
            { id: "code", component: "Code", language: "javascript", value: "console.log(1);", runnable: true },
          ],
        },
      },
      { version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/", value: { title: "Original task" } } },
    ];
    await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages, continuation: { kind: "action", text: "Change the value, then run the code.", taskTitle: "Original task", targetComponentId: "code", actionType: "edit" } }),
    }, mentorId);
    await request(address, "/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "Why this value?", source: "work", surfaceId: "lesson", context: { componentId: "code", label: "visible code" } }),
    });
    const next = await request(address, `/api/mentor/next?mentorId=${mentorId}`);
    assert.equal(next.body.message.source, "work");

    const beforePreview = (await request(address, "/api/session")).body;
    const invalidPreview = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "chat", messages: [], continuation: { kind: "question", text: "What should we discuss?" } }),
    }, mentorId);
    assert.equal(invalidPreview.response.status, 400);
    assert.match(invalidPreview.body.error, /anchored work replies must preserve work focus/i);
    const validPreview = await request(address, "/api/a2ui?validate=1", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: [], continuation: { kind: "action", text: "Inspect the highlighted line, then retry.", taskTitle: "Original task", targetComponentId: "code", actionType: "inspect" } }),
    }, mentorId);
    assert.equal(validPreview.response.status, 200);
    const afterPreview = (await request(address, "/api/session")).body;
    assert.deepEqual(afterPreview.canvas, beforePreview.canvas);
    assert.deepEqual(afterPreview.continuation, beforePreview.continuation);

    const replacement = [{ version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/title", value: "Hidden replacement" } }];
    const preserved = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages: replacement, continuation: { kind: "action", text: "Inspect the highlighted line, then retry.", taskTitle: "Original task", targetComponentId: "code", actionType: "inspect" } }),
    }, mentorId);
    assert.equal(preserved.body.accepted, false);
    assert.equal(preserved.body.preservedWork, true);
    assert.equal(preserved.body.continuationUpdated, true);
    let current = (await request(address, "/api/session")).body;
    assert.equal(current.canvas.surfaces.lesson.dataModel.title, "Original task");
    assert.equal(current.continuation.text, "Inspect the highlighted line, then retry.");

    const customPreserved = await request(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({
        type: "CUSTOM",
        name: "a2ui",
        value: { focus: "work", messages: replacement, continuation: { kind: "action", text: "Edit only the highlighted value.", taskTitle: "Original task", targetComponentId: "code", actionType: "edit" } },
      }),
    }, mentorId);
    assert.equal(customPreserved.body.accepted, false);
    assert.equal(customPreserved.body.preservedWork, true);
    current = (await request(address, "/api/session")).body;
    assert.equal(current.canvas.surfaces.lesson.dataModel.title, "Original task");
    assert.equal(current.continuation.text, "Edit only the highlighted value.");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("mentor readiness resolves only after provider-qualified handshake", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const mentorId = "ready-mentor";
    const ready = runtime.waitForMentor(1_000);
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    const resolvedBeforeReady = await Promise.race([
      ready.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 30)),
    ]);
    assert.equal(resolvedBeforeReady, false);
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    assert.equal(await ready, mentorId);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt delegates to the active adapter and clears mentor readiness", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const mentorId = "interrupt-mentor";
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    let interrupted = 0;
    runtime.setInterruptHandler(async () => {
      interrupted += 1;
      return true;
    });

    const response = await request(address, "/api/interrupt", { method: "POST", body: "{}" });
    assert.equal(response.response.status, 202);
    assert.equal(interrupted, 1);
    assert.equal((await request(address, "/api/session")).body.mentorAttached, false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed A2UI graphs are rejected without replacing the last good canvas", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "graph-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const before = (await request(address, "/api/session")).body.canvas;
    const rejected = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({
        focus: "work",
        continuation: { kind: "action", text: "Inspect the graph.", taskTitle: "Graph", targetComponentId: "root", actionType: "inspect" },
        messages: [
          {
            version: "v0.9",
            createSurface: { surfaceId: "cycle", catalogId: "urn:learn-anything:catalog:v1" },
          },
          {
            version: "v0.9",
            updateComponents: {
              surfaceId: "cycle",
              components: [{ id: "root", component: "Column", children: ["root"] }],
            },
          },
        ],
      }),
    }, mentorId);
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /cycle/i);
    assert.deepEqual((await request(address, "/api/session")).body.canvas, before);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function reactiveCanvas() {
  return applyA2uiMessages(createInitialCanvas("Wave model"), [
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "lesson",
        components: [
          { id: "root", component: "Column", children: ["equation", "plot", "controls"] },
          { id: "equation", component: "Math", expression: { path: "/equation" } },
          { id: "plot", component: "Plot", x: { label: "x" }, y: { label: "P(x)" }, series: { path: "/series" } },
          {
            id: "controls",
            component: "Params",
            controls: [{
              id: "phase",
              label: "Phase",
              min: 0,
              max: 1,
              step: 0.5,
              value: 0,
              path: "/phase",
              frames: [
                { value: 0, updates: [{ path: "/equation", value: "P=0" }, { path: "/series", value: [{ id: "p", label: "P(x)", points: [[0, 0], [1, 1]] }] }] },
                { value: 0.5, updates: [{ path: "/equation", value: "P=1/2" }, { path: "/series", value: [{ id: "p", label: "P(x)", points: [[0, 0.5], [1, 0.5]] }] }] },
                { value: 1, updates: [{ path: "/equation", value: "P=1" }, { path: "/series", value: [{ id: "p", label: "P(x)", points: [[0, 1], [1, 0]] }] }] },
              ],
            }],
          },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "lesson",
        path: "/",
        value: { title: "Wave model", phase: 0, equation: "P=0", series: [{ id: "p", label: "P(x)", points: [[0, 0], [1, 1]] }] },
      },
    },
  ], { focus: "work" });
}

test("finite parameter frames update nested Math and Plot bindings locally", () => {
  const before = reactiveCanvas();
  const after = applyParameterFrame(before, "controls", "phase", 0.5);
  assert.equal(before.surfaces.lesson.dataModel.phase, 0);
  assert.equal(after.surfaces.lesson.components.controls.controls[0].value, 0.5);
  assert.equal(after.surfaces.lesson.dataModel.phase, 0.5);
  assert.equal(resolveDataBinding(after.surfaces.lesson.components.equation.expression, after.surfaces.lesson.dataModel), "P=1/2");
  assert.deepEqual(resolveDataBinding(after.surfaces.lesson.components.plot.series, after.surfaces.lesson.dataModel)[0].points, [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(resolveDataBinding({ nested: [{ path: "/equation" }] }, after.surfaces.lesson.dataModel), { nested: ["P=1/2"] });
});

test("malformed or oversized Plot data is rejected", () => {
  const canvas = createInitialCanvas("Invalid plot");
  const plotMessages = (plot) => [{
    version: "v0.9",
    updateComponents: {
      surfaceId: "lesson",
      components: [
        { id: "root", component: "Column", children: ["plot"] },
        { id: "plot", component: "Plot", ...plot },
      ],
    },
  }];
  assert.throws(() => applyA2uiMessages(canvas, plotMessages({ series: [{ id: "bad", points: [[0, "not-a-number"]] }] })), /finite number/i);
  assert.throws(() => applyA2uiMessages(canvas, plotMessages({ x: { min: 1, max: 1 }, series: [{ id: "bad", points: [[0, 0], [1, 1]] }] })), /min must be less than max/i);
  assert.throws(() => applyA2uiMessages(canvas, plotMessages({ y: { min: "zero", max: 1 }, series: [{ id: "bad", points: [[0, 0], [1, 1]] }] })), /finite number/i);
  assert.throws(() => applyA2uiMessages(canvas, plotMessages({ description: "x".repeat(2_001), series: [{ id: "bad", points: [[0, 0], [1, 1]] }] })), /no longer than 2000/i);
  assert.throws(() => applyA2uiMessages(canvas, plotMessages({ series: [{ id: "bad", points: Array.from({ length: 501 }, (_, index) => [index, index]) }] })), /between 1 and 500 points/i);

  assert.throws(() => applyA2uiMessages(canvas, [
    ...plotMessages({ x: { path: "/badAxis" }, series: [{ id: "bad", points: [[0, 0], [1, 1]] }] }),
    { version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/badAxis", value: { label: 7, min: "oops", max: 1 } } },
  ]), /axis label must be a string|axis min must be a finite number/i);
});

test("parameter frames cannot replace a bound Plot axis with malformed data", () => {
  let canvas = createInitialCanvas("Bound axis");
  canvas = applyA2uiMessages(canvas, [
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "lesson",
        components: [
          { id: "root", component: "Column", children: ["plot", "controls"] },
          { id: "plot", component: "Plot", x: { path: "/axis" }, series: [{ id: "line", points: [[0, 0], [1, 1]] }] },
          {
            id: "controls",
            component: "Params",
            controls: [{
              id: "state",
              label: "State",
              min: 0,
              max: 1,
              step: 1,
              value: 0,
              frames: [
                { value: 0, updates: [{ path: "/axis", value: { label: "Input", min: 0, max: 1 } }] },
                { value: 1, updates: [{ path: "/axis", value: { label: "Input", min: "oops", max: 1 } }] },
              ],
            }],
          },
        ],
      },
    },
    { version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/axis", value: { label: "Input", min: 0, max: 1 } } },
  ], { focus: "work" });

  assert.throws(() => applyParameterFrame(canvas, "controls", "state", 1), /axis min must be a finite number/i);
});

test("parameter frames reject blocked paths and contract overflows", () => {
  const canvas = createInitialCanvas("Invalid control");
  const messages = (control) => [{
    version: "v0.9",
    updateComponents: {
      surfaceId: "lesson",
      components: [
        { id: "root", component: "Column", children: ["controls"] },
        { id: "controls", component: "Params", controls: [control] },
      ],
    },
  }];
  const base = { id: "x", label: "x", min: 0, max: 1, step: 0.01, value: 0 };
  assert.throws(() => applyA2uiMessages(canvas, messages({ ...base, value: { path: "/x" } })), /value must be a finite number/i);
  assert.throws(() => applyA2uiMessages(canvas, messages({ ...base, frames: [{ value: 0, updates: [{ path: "/__proto__/x", value: true }] }] })), /blocked segment/i);
  assert.throws(() => applyA2uiMessages(canvas, messages({ ...base, frames: Array.from({ length: 102 }, (_, index) => ({ value: index / 101, updates: [{ path: "/x", value: index }] })) })), /between 1 and 101 entries/i);
});

test("parameter persistence updates the whole canvas without waking the mentor", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "parameter-mentor";
  try {
    await request(address, "/api/mentor/register", { method: "POST", body: JSON.stringify({ mentorId, takeover: true }) });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const payload = reactiveCanvas();
    const posted = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({
        focus: "work",
        continuation: { kind: "action", text: "Adjust the visible phase control.", taskTitle: "Adjust phase", targetComponentId: "controls", actionType: "adjust" },
        messages: [
          { version: "v0.9", createSurface: { surfaceId: "lesson", catalogId: "urn:learn-anything:catalog:v1" } },
          { version: "v0.9", updateComponents: { surfaceId: "lesson", components: Object.values(payload.surfaces.lesson.components) } },
          { version: "v0.9", updateDataModel: { surfaceId: "lesson", path: "/", value: payload.surfaces.lesson.dataModel } },
        ],
      }),
    }, mentorId);
    assert.equal(posted.response.status, 202);

    let delivered = false;
    const pollAbort = new AbortController();
    const poll = request(address, `/api/mentor/next?mentorId=${mentorId}`, { signal: pollAbort.signal }).then(() => { delivered = true; }).catch(() => {});
    const changed = await request(address, "/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "parameter_change", componentId: "controls", controlId: "phase", value: 0.5 }),
    });
    assert.equal(changed.response.status, 202);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    assert.equal(delivered, false);
    const session = (await request(address, "/api/session")).body;
    assert.equal(session.canvas.surfaces.lesson.dataModel.equation, "P=1/2");
    assert.deepEqual(session.canvas.surfaces.lesson.dataModel.series[0].points, [[0, 0.5], [1, 0.5]]);
    pollAbort.abort();
    await poll;
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
