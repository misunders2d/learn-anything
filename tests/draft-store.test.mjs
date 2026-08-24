import assert from "node:assert/strict";
import test from "node:test";
import { clearDraft, loadDraft, saveDraft } from "../skills/learn-anything/blocks/web/src/draft-store.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("draft store restores local text and clears only the saved value", () => {
  const storage = memoryStorage();
  saveDraft(storage, "code:lesson:editor", "latest edit");
  assert.equal(loadDraft(storage, "code:lesson:editor", "server copy"), "latest edit");
  assert.equal(clearDraft(storage, "code:lesson:editor", "older edit"), false);
  assert.equal(loadDraft(storage, "code:lesson:editor", "server copy"), "latest edit");
  assert.equal(clearDraft(storage, "code:lesson:editor", "latest edit"), true);
  assert.equal(loadDraft(storage, "code:lesson:editor", "server copy"), "server copy");
});
