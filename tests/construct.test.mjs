import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constructSession, slugifyTopic } from "../skills/learn-anything/scripts/construct.mjs";
import { probeCapabilities } from "../skills/learn-anything/scripts/probe.mjs";

test("slugifyTopic creates stable bounded session names", () => {
  assert.equal(slugifyTopic(" Rust: Ownership & Lifetimes! "), "rust-ownership-lifetimes");
  assert.equal(slugifyTopic("---"), "learning-session");
  assert.ok(slugifyTopic("x".repeat(100)).length <= 64);
});

test("probe reports constructor-relevant capabilities", () => {
  const result = probeCapabilities({ env: {}, platform: process.platform });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.node, process.version);
  assert.equal(typeof result.languages.javascript, "boolean");
  assert.equal(typeof result.languages.sql, "boolean");
  assert.ok("containerRuntime" in result);
  assert.ok(Array.isArray(result.warnings));
});

test("probe identifies OMP before compatibility environment markers", () => {
  const result = probeCapabilities({
    env: { OMPCODE: "1", CLAUDECODE: "1" },
    platform: process.platform,
  });
  assert.equal(result.harness, "omp");
});

test("construct creates and resumes without replacing session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-construct-"));
  try {
    const first = await constructSession({ topic: "Rust lifetimes", root, env: {}, profile: "portable-shell" });
    assert.equal(first.resumed, false);
    assert.equal(first.profile, "portable-shell");
    const initial = JSON.parse(await readFile(first.sessionPath, "utf8"));
    assert.equal(initial.topic, "Rust lifetimes");
    assert.ok(initial.assembly.blocks.includes("adapter.shell-long-poll"));
    assert.equal(initial.assembly.validation.status, "pending");
    assert.match(initial.security.accessToken, /^[A-Za-z0-9_-]{40,}$/);

    const second = await constructSession({ topic: "Rust lifetimes", root, env: {}, profile: "portable-shell" });
    assert.equal(second.resumed, true);
    const resumed = JSON.parse(await readFile(second.sessionPath, "utf8"));
    assert.equal(resumed.createdAt, initial.createdAt);
    assert.deepEqual(resumed.transcript, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto profile selects the known streaming adapter in Claude Code", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-auto-profile-"));
  try {
    const result = await constructSession({ topic: "TypeScript", root, env: { CLAUDECODE: "1" } });
    assert.equal(result.profile, "reference-streaming");
    const session = JSON.parse(await readFile(result.sessionPath, "utf8"));
    assert.ok(session.assembly.blocks.includes("adapter.claude-agent-sdk"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto profile selects the bundled Codex CLI adapter in Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-codex-profile-"));
  try {
    const result = await constructSession({ topic: "Rust", root, env: { CODEX_THREAD_ID: "test" } });
    assert.equal(result.profile, "codex-cli");
    const session = JSON.parse(await readFile(result.sessionPath, "utf8"));
    assert.ok(session.assembly.blocks.includes("adapter.codex-cli"));
    assert.ok(session.assembly.degraded.includes("mentor-output-arrives-after-headless-turn"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto profile selects the persistent Codex adapter in OMP", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-omp-profile-"));
  try {
    const result = await constructSession({
      topic: "Python",
      root,
      env: { OMPCODE: "1", CLAUDECODE: "1" },
    });
    assert.equal(result.profile, "codex-cli");
    const session = JSON.parse(await readFile(result.sessionPath, "utf8"));
    assert.ok(session.assembly.blocks.includes("adapter.codex-cli"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("construct rejects unknown profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-profile-"));
  try {
    await assert.rejects(
      constructSession({ topic: "Databases", root, profile: "imaginary" }),
      /Unknown profile/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
