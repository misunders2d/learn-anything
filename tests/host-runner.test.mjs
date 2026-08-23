import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { availableRunners, runCode } from "../skills/learn-anything/blocks/execution/host-runner.mjs";

test("JavaScript runner executes fixed command without shell", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "learn-anything-runner-"));
  try {
    const chunks = [];
    const result = await runCode({
      language: "javascript",
      code: "console.log('runner-ok')",
      workDir,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /runner-ok/);
    assert.ok(chunks.some((chunk) => chunk.kind === "stdout"));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("runner rejects arbitrary language and oversized input", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "learn-anything-runner-reject-"));
  try {
    await assert.rejects(runCode({ language: "shell", code: "echo unsafe", workDir }), /Unsupported language/);
    await assert.rejects(runCode({ language: "javascript", code: "x".repeat(100_001), workDir }), /100 KB/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("runner capability map always exposes supported catalog keys", () => {
  assert.deepEqual(Object.keys(availableRunners()).sort(), ["c", "javascript", "python", "rust", "sqlite"]);
});

test("SQLite runner keeps setup hidden and returns structured rows", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "learn-anything-sql-runner-"));
  try {
    const result = await runCode({
      language: "sql",
      runner: "sqlite",
      setup: "CREATE TABLE books(title TEXT, author TEXT); INSERT INTO books VALUES ('Kindred', 'Octavia Butler'), ('A Wizard of Earthsea', 'Ursula Le Guin');",
      code: "SELECT author FROM books ORDER BY title;",
      workDir,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.table.columns, ["author"]);
    assert.deepEqual(result.table.rows, [["Ursula Le Guin"], ["Octavia Butler"]]);
    assert.doesNotMatch(result.stdout, /python|sqlite3|CREATE TABLE/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("SQLite mistakes return database-native guidance without wrapper leakage", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "learn-anything-sql-error-"));
  try {
    const result = await runCode({
      language: "sql",
      runner: "sqlite",
      setup: "CREATE TABLE books(title TEXT); INSERT INTO books VALUES ('Kindred');",
      code: "SELECT titel FROM books;",
      workDir,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no such column: titel/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Traceback|sql_runner|sqlite3\.|\/tmp\//i);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("runner bounds generated output and terminates the process", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "learn-anything-runner-output-"));
  try {
    const result = await runCode({
      language: "javascript",
      code: "process.stdout.write('x'.repeat(300_000))",
      workDir,
    });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 200_000);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
