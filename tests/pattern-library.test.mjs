import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTeachingLibraryDir, validateTeachingPattern, saveTeachingPattern, loadTeachingPatterns } from "../skills/learn-anything/blocks/a2ui/pattern-library.mjs";

function pattern(title = "Two interpretations") {
  return { title, description: "Compare two interpretations of an original line, then reflect.", tags: ["acting"], messages: [
    { version: "v0.9", createSurface: { surfaceId: "practice", catalogId: "urn:learn-anything:catalog:v1" } },
    { version: "v0.9", updateComponents: { surfaceId: "practice", components: [
      { id: "root", component: "Column", children: ["line", "steps"] },
      { id: "line", component: "Passage", text: "You came back.", source: "Original exercise" },
      { id: "steps", component: "Checklist", items: [{ id: "rehearse", label: "Try two intentions", done: false }] },
    ] } },
    { version: "v0.9", updateDataModel: { surfaceId: "practice", path: "/", value: { title } } },
  ] };
}

test("reusable compositions validate standalone graphs and reject learner evidence", () => {
  assert.equal(validateTeachingPattern(pattern()).title, "Two interpretations");
  const missing = pattern(); missing.messages.shift();
  assert.throws(() => validateTeachingPattern(missing), /does not exist/);
  const result = pattern(); result.messages[1].updateComponents.components[1].lastResult = { stdout: "private" };
  assert.throws(() => validateTeachingPattern(result), /private or runtime/);
  const completed = pattern(); completed.messages[1].updateComponents.components[2].items[0].done = true;
  assert.throws(() => validateTeachingPattern(completed), /completed learner/);
  const pointer = pattern(); pointer.messages[2].updateDataModel = { surfaceId: "practice", path: "/nested/accessToken", value: "synthetic-private" };
  assert.throws(() => validateTeachingPattern(pointer), /private or runtime/);
  const escaped = pattern(); escaped.messages[2].updateDataModel = { surfaceId: "practice", path: "/nested~1path/accessToken", value: "synthetic-private" };
  assert.throws(() => validateTeachingPattern(escaped), /private or runtime/);
  const quiz = pattern(); quiz.messages[1].updateComponents.components[1] = { id: "line", component: "Quiz", question: "Which intention?", options: [{ id: "b", label: "Reassure" }], selectedOptionId: "b" };
  assert.throws(() => validateTeachingPattern(quiz), /completed learner/);
  quiz.messages[1].updateComponents.components[1].selectedOptionId = { path: "/answer" };
  quiz.messages[2].updateDataModel.value.answer = "b";
  assert.throws(() => validateTeachingPattern(quiz), /completed learner/);
  const script = pattern(); script.messages[1].updateComponents.components[1].component = "CustomJavaScript";
  assert.throws(() => validateTeachingPattern(script), /supported renderer/);
  const huge = pattern(); huge.description = "a".repeat(30_000);
  assert.throws(() => validateTeachingPattern(huge), /maximum size/);
});

test("library writes deduplicate concurrently and survive a new course reader", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "learn-patterns-"));
  try {
    const records = await Promise.all(Array.from({ length: 3 }, () => saveTeachingPattern(pattern(), { libraryDir })));
    assert.equal(new Set(records.map((record) => record.id)).size, 1);
    assert.equal((await readdir(libraryDir)).length, 1);
    const loaded = await loadTeachingPatterns({ libraryDir, query: "acting" });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, records[0].id);
    const saved = await readFile(join(libraryDir, `${loaded[0].id}.json`), "utf8");
    assert.ok(!saved.includes("mentorWork"));
  } finally { await rm(libraryDir, { recursive: true, force: true }); }
});

test("library selects relevant examples and ignores corrupt or altered entries", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "learn-patterns-"));
  try {
    await saveTeachingPattern(pattern(), { libraryDir });
    const architecture = pattern("Architecture circulation"); architecture.tags = ["architecture"];
    const record = await saveTeachingPattern(architecture, { libraryDir });
    assert.equal((await loadTeachingPatterns({ libraryDir, query: "architecture", limit: 1 }))[0].id, record.id);
    await writeFile(join(libraryDir, `${record.id}.json`), JSON.stringify({ ...record, title: "tampered" }));
    await writeFile(join(libraryDir, `${"f".repeat(64)}.json`), "{");
    assert.equal((await loadTeachingPatterns({ libraryDir })).length, 1);
    assert.deepEqual(await loadTeachingPatterns({ libraryDir, limit: 0 }), []);
  } finally { await rm(libraryDir, { recursive: true, force: true }); }
});

test("library location is host configuration and missing library is empty", async () => {
  assert.equal(defaultTeachingLibraryDir({ LEARN_ANYTHING_LIBRARY_DIR: "/tmp/course-patterns" }), "/tmp/course-patterns");
  assert.equal(defaultTeachingLibraryDir({ XDG_DATA_HOME: "/tmp/learn-data" }), "/tmp/learn-data/learn-anything/patterns");
  assert.deepEqual(await loadTeachingPatterns({ libraryDir: "/tmp/no-learn-pattern-library-exists" }), []);
});
