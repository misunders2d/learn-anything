import assert from "node:assert/strict";
import test from "node:test";
import { parsePiResponse } from "../skills/learn-anything/blocks/adapters/pi-cli/adapter.mjs";

test("Pi mentor response parser accepts the exact browser contract", () => {
  assert.deepEqual(parsePiResponse(JSON.stringify({
    message: "Ready in the browser.",
    focus: "chat",
    a2ui_jsonl: null,
    target_component_id: null,
    target_quote: null,
    continuation_kind: "question",
    continuation: "What should we explore next?",
  })), {
    message: "Ready in the browser.",
    focus: "chat",
    a2ui_jsonl: null,
    target_component_id: null,
    target_quote: null,
    continuation_kind: "question",
    continuation: "What should we explore next?",
  });
});

test("Pi mentor response parser rejects prose and invalid focus", () => {
  assert.throws(() => parsePiResponse("I will answer later"), /no JSON mentor response/);
  assert.throws(() => parsePiResponse(JSON.stringify({
    message: "Wrong surface",
    focus: "terminal",
    a2ui_jsonl: null,
    target_component_id: null,
    target_quote: null,
    continuation_kind: "question",
    continuation: "What should we explore next?",
  })), /invalid focus/);
  assert.throws(() => parsePiResponse(JSON.stringify({
    message: "No next step",
    focus: "work",
    a2ui_jsonl: null,
    target_component_id: null,
    target_quote: null,
  })), /invalid continuation_kind/);
});
