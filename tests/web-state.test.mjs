import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../skills/learn-anything/blocks/web/src/i18n.mjs";
import {
  appendPartialDelta,
  createPartialMessage,
  mergeSnapshotMessages,
  upsertMessage,
} from "../skills/learn-anything/blocks/web/src/message-state.mjs";
import { connectionIssueFor, firstLearnerComponentId, learningProgress, recoveryCanAct, resultMatchesCode, resolveFocus, shouldReleaseRescue, workTaskKey } from "../skills/learn-anything/blocks/web/src/workspace-state.mjs";

test("execution evidence survives refresh without attaching run A output to edited code B", () => {
  const executedCode = "console.log('A');";
  const editedCode = "console.log('B');";
  const result = { stdout: "A\n", executedCode, codeHash: "server-hash-A" };
  assert.equal(resultMatchesCode(result, executedCode), true);
  assert.equal(resultMatchesCode(result, editedCode), false);
  const restored = JSON.parse(JSON.stringify({ value: editedCode, lastResult: result }));
  assert.equal(resultMatchesCode(restored.lastResult, restored.value), false);
  assert.equal(resultMatchesCode({ stdout: "legacy output" }, editedCode), false);
  assert.equal(resultMatchesCode({ executedCode, codeHash: "" }, executedCode), false);
  assert.equal(resultMatchesCode({ error: "Request failed" }, editedCode), false);
  assert.equal(resultMatchesCode({ error: "SyntaxError", executedCode, codeHash: "server-hash-A" }, executedCode), true);
  assert.equal(resultMatchesCode({ executedCode: "", codeHash: "empty-code-hash" }, ""), true);
  assert.equal(resultMatchesCode(result, `${executedCode}\n`), false);
});

test("recovery exposes actions only for failed work, never queued or active requests", () => {
  for (const status of ["pending", "inflight", "completed", "dismissed", "unknown", undefined]) {
    assert.equal(recoveryCanAct({ turnId: "turn", status }), false);
  }
  assert.equal(recoveryCanAct({ turnId: "turn", status: "failed" }), true);
  assert.equal(recoveryCanAct({ status: "failed" }), false);
  assert.equal(recoveryCanAct(null), false);
});

test("learning progress shows durable milestones without inferring mastery from activity", () => {
  assert.deepEqual(learningProgress(null), { count: 0, milestones: [], nextStep: "" });
  assert.equal(learningProgress({ status: "activity_complete" }).count, 0);
  const milestone = { title: "First loop", takeaway: "Repeat a step", nextStep: "Try a condition" };
  assert.deepEqual(learningProgress({ milestone: 1, milestones: [milestone], nextStep: "Try a condition" }), {
    count: 1, milestones: [milestone], nextStep: "Try a condition",
  });
  assert.deepEqual(learningProgress({ milestone: -1, milestones: [null, {}, milestone], nextStep: 42 }), {
    count: 1, milestones: [milestone], nextStep: "",
  });
});

test("message start keeps a stable object after the partial map is cleared", () => {
  const event = { messageId: "message-1", role: "user" };
  const partial = new Map();
  const pending = createPartialMessage(event);
  partial.set(event.messageId, pending);
  partial.delete(event.messageId);

  const messages = upsertMessage([], pending);
  assert.deepEqual(messages, [{ id: "message-1", role: "user", content: "" }]);
});

test("message content creates a partial when start was missed", () => {
  const partial = new Map();
  const pending = appendPartialDelta(partial, {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "message-2",
    role: "assistant",
    delta: "Recovered",
  });

  assert.deepEqual(pending, { id: "message-2", role: "assistant", content: "Recovered" });
});

test("snapshot reconciliation keeps an in-flight partial", () => {
  const partial = new Map([
    ["streaming", { id: "streaming", role: "assistant", content: "Still typing" }],
  ]);
  const messages = mergeSnapshotMessages([{ id: "saved", role: "user", content: "Hello" }], partial);

  assert.deepEqual(messages.map((message) => message.id), ["saved", "streaming"]);
});

test("workspace focus is explicit with an interactive fallback", () => {
  const canvas = (focus, components) => ({
    ...(focus ? { focus } : {}),
    activeSurfaceId: "lesson",
    surfaces: {
      lesson: {
        components: Object.fromEntries(components.map((component, index) => [`component-${index}`, component])),
      },
    },
  });
  assert.equal(resolveFocus(canvas("chat", [{ component: "Code", runnable: true }])), "chat");
  assert.equal(resolveFocus(canvas(null, [{ component: "Code", runnable: true }])), "work");
  assert.equal(resolveFocus(canvas(null, [{ component: "Markdown" }])), "chat");
});

test("work task key changes for a new instruction but not execution output", () => {
  const canvas = {
    focus: "work",
    activeSurfaceId: "lesson",
    surfaces: {
      lesson: {
        dataModel: { title: "Numbers" },
        components: {
          root: { id: "root", component: "Column", children: ["instruction", "code"] },
          instruction: { id: "instruction", component: "Markdown", content: "Change quantity to 3." },
          code: { id: "code", component: "Code", value: "const quantity = 2;" },
        },
      },
    },
  };
  const initial = workTaskKey(canvas);
  assert.equal(firstLearnerComponentId(canvas), "instruction");
  canvas.surfaces.lesson.components.code.lastResult = { stdout: "2" };
  assert.equal(workTaskKey(canvas), initial);
  canvas.surfaces.lesson.components.instruction.content = "Change price to 7.";
  assert.notEqual(workTaskKey(canvas), initial);

  canvas.surfaces.lesson.components.instruction.content = { path: "/instruction" };
  canvas.surfaces.lesson.dataModel.instruction = "First bound task";
  const boundInitial = workTaskKey(canvas);
  canvas.surfaces.lesson.dataModel.instruction = "Second bound task";
  assert.notEqual(workTaskKey(canvas), boundInitial);

  canvas.surfaces.lesson.components.root.children = ["nested-row"];
  canvas.surfaces.lesson.components["nested-row"] = { id: "nested-row", component: "Row", children: ["nested-instruction"] };
  canvas.surfaces.lesson.components["nested-instruction"] = { id: "nested-instruction", component: "Markdown", content: { path: "/nestedInstruction" } };
  canvas.surfaces.lesson.dataModel.nestedInstruction = "First nested task";
  assert.equal(firstLearnerComponentId(canvas), "nested-instruction");
  const nestedInitial = workTaskKey(canvas);
  canvas.surfaces.lesson.dataModel.nestedInstruction = "Second nested task";
  assert.notEqual(workTaskKey(canvas), nestedInitial);
});

test("rescue stays open during a question, then yields to the mentor's next focus", () => {
  assert.equal(shouldReleaseRescue({ activeSurfaceId: "same", focus: "work" }, "same"), false);
  assert.equal(shouldReleaseRescue({ activeSurfaceId: "same", focus: "work" }, "same", true), true);
  assert.equal(shouldReleaseRescue({ activeSurfaceId: "same", focus: "chat" }, "same"), false);
  assert.equal(shouldReleaseRescue({ activeSurfaceId: "next", focus: "work" }, "same"), true);
});

test("failed fetch reports a stopped workspace instead of raw network text", () => {
  assert.deepEqual(connectionIssueFor(new TypeError("Failed to fetch")), {
    titleKey: "connection.stopped.title",
    messageKey: "connection.restart.message",
  });
});

test("all connection failures provide localizable titles and recovery instructions", () => {
  for (const [error, title] of [
    [{ status: 401 }, "connection.earlier.title"],
    [new TypeError("Failed to fetch"), "connection.stopped.title"],
    [new Error("Failed to fetch"), "connection.stopped.title"],
    [new Error("offline"), "connection.lost.title"],
  ]) {
    const issue = connectionIssueFor(error);
    assert.equal(issue.titleKey, title);
    for (const key of [issue.titleKey, issue.messageKey]) {
      assert.notEqual(translate("en", key), key);
      assert.notEqual(translate("ru", key), translate("en", key));
    }
  }
});
