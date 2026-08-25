import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPartialDelta,
  createPartialMessage,
  mergeSnapshotMessages,
  upsertMessage,
} from "../skills/learn-anything/blocks/web/src/message-state.mjs";
import { connectionIssueFor, firstLearnerComponentId, resolveFocus, shouldReleaseRescue, workTaskKey } from "../skills/learn-anything/blocks/web/src/workspace-state.mjs";

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
    title: "Workspace stopped",
    message: "Your work is saved locally. Restart the workspace from your coding agent, then reload this page.",
  });
});
