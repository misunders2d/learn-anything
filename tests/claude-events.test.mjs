import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeEventState, mapClaudeMessage, missingStructuredContinuationError } from "../skills/learn-anything/blocks/adapters/claude-agent-sdk/events.mjs";

test("Claude missing structured continuation stays operational instead of publishing vague learner guidance", () => {
  const error = missingStructuredContinuationError();
  assert.equal(error.type, "RUN_ERROR");
  assert.equal(error.code, "MISSING_STRUCTURED_CONTINUATION");
  assert.match(error.message, /concrete learner continuation/i);
});

test("Claude partial text maps to AG-UI text lifecycle", () => {
  const state = createClaudeEventState();
  const base = { type: "stream_event", uuid: "u1", session_id: "s1" };
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "message_start", message: { id: "m1" } } }, state), []);
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, state), [
    { type: "TEXT_MESSAGE_START", messageId: "m1:text:0", role: "assistant" },
  ]);
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } }, state), [
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1:text:0", delta: "Hello" },
  ]);
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_stop", index: 0 } }, state), [
    { type: "TEXT_MESSAGE_END", messageId: "m1:text:0" },
  ]);
});

test("Claude tool stream and session id map without losing identifiers", () => {
  const state = createClaudeEventState();
  assert.deepEqual(mapClaudeMessage({ type: "system", subtype: "init", session_id: "session-1" }, state), [
    { type: "CUSTOM", name: "mentor_session", value: { sessionId: "session-1" } },
  ]);
  const base = { type: "stream_event", uuid: "u2", session_id: "session-1" };
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "render_canvas" } } }, state), [
    { type: "TOOL_CALL_START", toolCallId: "tool-1", toolCallName: "render_canvas" },
  ]);
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"" } } }, state), [
    { type: "TOOL_CALL_ARGS", toolCallId: "tool-1", delta: "{\"" },
  ]);
  assert.deepEqual(mapClaudeMessage({ ...base, event: { type: "content_block_stop", index: 1 } }, state), [
    { type: "TOOL_CALL_END", toolCallId: "tool-1" },
  ]);
});
