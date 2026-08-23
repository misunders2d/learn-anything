import assert from "node:assert/strict";
import test from "node:test";
import { indentWithTab } from "../skills/learn-anything/blocks/web/src/editor-input.mjs";

test("Tab inserts four spaces and keeps the caret in the code editor", () => {
  const result = indentWithTab("def send():\npass", 12, 12);
  assert.deepEqual(result, {
    value: "def send():\n    pass",
    selectionStart: 16,
    selectionEnd: 16,
  });
});
