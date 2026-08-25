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
  assert.ok("pi" in result.commands);
  assert.ok(Array.isArray(result.warnings));
});
test("probe does not treat missing containers as a degradation", () => {
  const result = probeCapabilities({
    env: {},
    platform: "linux",
    resolveCommand: (command) => command === "node" ? "/usr/bin/node" : null,
  });
  assert.equal(result.commands.python3, null);
  assert.equal(result.containerRuntime, null);
  assert.equal(result.warnings.some((warning) => /Docker|Podman|container/i.test(warning)), false);
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
    assert.equal(initial.schemaVersion, 3);
    assert.equal(initial.assembly.schemaVersion, 1);
    assert.equal(initial.assembly.blockVersions["web.a2ui-canvas"], 2);
    assert.equal(initial.assembly.execution.mode, "host");

    const second = await constructSession({ topic: "Rust lifetimes", root, env: {}, profile: "portable-shell" });
    assert.equal(second.resumed, true);
    const resumed = JSON.parse(await readFile(second.sessionPath, "utf8"));
    assert.equal(resumed.createdAt, initial.createdAt);
    assert.deepEqual(resumed.transcript, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile changes require explicit migration and preserve a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-migration-"));
  try {
    const first = await constructSession({ topic: "Migration", root, profile: "portable-shell", env: {} });
    const session = JSON.parse(await readFile(first.sessionPath, "utf8"));
    session.transcript.push({ id: "kept", role: "user", content: "preserve me" });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(first.sessionPath, `${JSON.stringify(session, null, 2)}\n`));

    await assert.rejects(
      constructSession({ topic: "Migration", root, profile: "codex-cli", env: {} }),
      /--migrate/,
    );
    const migrated = await constructSession({ topic: "Migration", root, profile: "codex-cli", env: {}, migrate: true });
    assert.equal(migrated.profile, "codex-cli");
    const current = JSON.parse(await readFile(first.sessionPath, "utf8"));
    const backup = JSON.parse(await readFile(`${first.sessionPath}.v3.backup`, "utf8"));
    assert.equal(current.transcript[0].content, "preserve me");
    assert.equal(current.assembly.profile, "codex-cli");
    assert.equal(current.assembly.validation.status, "pending");
    assert.equal(backup.assembly.profile, "portable-shell");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed capabilities mark a resumed composition for revalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-revalidation-"));
  try {
    const first = await constructSession({ topic: "Revalidate", root, profile: "portable-shell", env: {} });
    const session = JSON.parse(await readFile(first.sessionPath, "utf8"));
    session.assembly.capabilityFingerprint = "stale-fingerprint";
    session.assembly.validation = { status: "passed", checkedAt: new Date().toISOString() };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(first.sessionPath, `${JSON.stringify(session, null, 2)}\n`));

    const resumed = await constructSession({ topic: "Revalidate", root, profile: "portable-shell", env: {} });
    assert.equal(resumed.requiresRevalidation, true);
    const current = JSON.parse(await readFile(first.sessionPath, "utf8"));
    assert.equal(current.assembly.validation.status, "stale");
    assert.equal(current.assembly.validation.reason, "capabilities-changed");
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

test("auto profile selects the highest-capability streaming adapter in OMP", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-omp-profile-"));
  try {
    const result = await constructSession({
      topic: "Python",
      root,
      env: { OMPCODE: "1", CLAUDECODE: "1" },
    });
    assert.equal(result.profile, "reference-streaming");
    const session = JSON.parse(await readFile(result.sessionPath, "utf8"));
    assert.ok(session.assembly.blocks.includes("adapter.claude-agent-sdk"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto profile selects the native Pi adapter in Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-pi-profile-"));
  try {
    const result = await constructSession({
      topic: "Java",
      root,
      env: { PI_CODING_AGENT: "1" },
    });
    assert.equal(result.profile, "pi-cli");
    const session = JSON.parse(await readFile(result.sessionPath, "utf8"));
    assert.ok(session.assembly.blocks.includes("adapter.pi-cli"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("construct rejects unknown execution modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-execution-"));
  try {
    await assert.rejects(
      constructSession({ topic: "Databases", root, profile: "portable-shell", execution: "virtual-machine" }),
      /Unknown execution mode/,
    );
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
