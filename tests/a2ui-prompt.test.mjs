import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { A2UI_CATALOG_PROMPT } from "../skills/learn-anything/blocks/a2ui/prompt.mjs";

test("all persistent mentor adapters receive one exact reactive catalog contract", async () => {
  for (const path of [
    "../skills/learn-anything/blocks/adapters/codex-cli/adapter.mjs",
    "../skills/learn-anything/blocks/adapters/claude-agent-sdk/adapter.mjs",
    "../skills/learn-anything/blocks/adapters/pi-cli/adapter.mjs",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /import \{ A2UI_CATALOG_PROMPT \}/);
    assert.match(source, /\$\{A2UI_CATALOG_PROMPT\}/);
  }
  assert.match(A2UI_CATALOG_PROMPT, /"component":"Math"/);
  assert.match(A2UI_CATALOG_PROMPT, /"component":"Plot"/);
  assert.match(A2UI_CATALOG_PROMPT, /"component":"Params"/);
  assert.match(A2UI_CATALOG_PROMPT, /"frames":\[/);
  assert.match(A2UI_CATALOG_PROMPT, /"series":\{"path":"\/series"\}/);
  assert.match(A2UI_CATALOG_PROMPT, /"direction":"ltr\|rtl\|auto"/);
  assert.match(A2UI_CATALOG_PROMPT, /never formulas or executable UI/i);
  assert.match(A2UI_CATALOG_PROMPT, /Params control definitions are literal/i);
  assert.match(A2UI_CATALOG_PROMPT, /2,000 total points/);
  assert.match(A2UI_CATALOG_PROMPT, /instruction and first required interaction must both be visible without scrolling/i);
  assert.match(A2UI_CATALOG_PROMPT, /Automatic feedback after code execution or a canvas action stays in work focus/i);
  assert.match(A2UI_CATALOG_PROMPT, /Every turn ends with exactly one learner-visible continuation/i);
  assert.match(A2UI_CATALOG_PROMPT, /instead of asking the learner to type "continue"/i);
  const codexSchema = JSON.parse(await readFile(new URL("../skills/learn-anything/blocks/adapters/codex-cli/response.schema.json", import.meta.url), "utf8"));
  assert.ok(codexSchema.required.includes("continuation_kind"));
  assert.ok(codexSchema.required.includes("continuation"));
  assert.match(A2UI_CATALOG_PROMPT, /Never ask the learner to perform a state already shown as complete/i);
});

test("portable shell reference uses supported canvas command and continuation contract", async () => {
  const reference = await readFile(new URL("../skills/learn-anything/references/shell-mentor.md", import.meta.url), "utf8");
  assert.match(reference, /mentor\.mjs canvas /);
  assert.doesNotMatch(reference, /mentor\.mjs stage /);
  assert.match(reference, /"continuation"/);
});
