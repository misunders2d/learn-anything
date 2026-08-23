import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPartialDelta,
  createPartialMessage,
  mergeSnapshotMessages,
  upsertMessage,
} from "../skills/learn-anything/blocks/web/src/message-state.mjs";
import { resolveFocus, shouldReleaseRescue } from "../skills/learn-anything/blocks/web/src/workspace-state.mjs";

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
  assert.equal(resolveFocus({ focus: "chat", components: [{ type: "code", runnable: true }] }), "chat");
  assert.equal(resolveFocus({ components: [{ type: "code", runnable: true }] }), "work");
  assert.equal(resolveFocus({ components: [{ type: "markdown" }] }), "chat");
});

test("rescue yields only to an explicit chat stage or a new surface", () => {
  assert.equal(shouldReleaseRescue({ surfaceId: "same", focus: "work" }, "same"), false);
  assert.equal(shouldReleaseRescue({ surfaceId: "same", focus: "chat" }, "same"), true);
  assert.equal(shouldReleaseRescue({ surfaceId: "next", focus: "work" }, "same"), true);
});
