import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import {
  loadBlockCatalog,
  loadProfiles,
  MentorSupervisor,
  resolveMentorAdapter,
  selectProfile,
} from "../skills/learn-anything/blocks/adapters/runtime.mjs";

test("profile selection prefers verified capabilities rather than harness branches", async () => {
  const profiles = await loadProfiles(kitRoot);
  const claude = selectProfile(profiles, {
    harness: "claude-code",
    commands: { claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
  });
  const omp = selectProfile(profiles, {
    harness: "omp",
    commands: { claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
  });
  const pi = selectProfile(profiles, {
    harness: "pi",
    commands: { pi: "/usr/bin/pi", claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
    features: { piPersistentMentor: true },
  });
  const legacyPi = selectProfile(profiles, {
    harness: "pi",
    commands: { pi: "/usr/bin/pi", codex: "/usr/bin/codex" },
    features: { piPersistentMentor: false },
  });
  const codexOnly = selectProfile(profiles, {
    harness: "future-agent",
    commands: { codex: "/usr/bin/codex" },
  });
  assert.throws(() => selectProfile(profiles, {
    harness: "future-agent",
    commands: {},
  }), /No compatible learn-anything profile/i);

  assert.equal(claude.id, "reference-streaming");
  assert.equal(omp.id, "reference-streaming");
  assert.equal(pi.id, "pi-cli");
  assert.equal(legacyPi.id, "codex-cli");
  assert.equal(codexOnly.id, "codex-cli");
  assert.equal(profiles.find((profile) => profile.id === "portable-shell").selection.manualOnly, true);
});

test("all persistent and manual adapters expose the same work activity metadata", async () => {
  const codexSchema = JSON.parse(await readFile(resolve(kitRoot, "blocks/adapters/codex-cli/response.schema.json"), "utf8"));
  assert.ok(codexSchema.required.includes("task_title"));
  assert.ok(codexSchema.required.includes("target_component_id"));
  assert.ok(codexSchema.required.includes("action_type"));
  const claudeAdapter = await readFile(resolve(kitRoot, "blocks/adapters/claude-agent-sdk/adapter.mjs"), "utf8");
  assert.match(claudeAdapter, /taskTitle: z\.string/);
  assert.match(claudeAdapter, /targetComponentId: z\.string/);
  assert.match(claudeAdapter, /actionType: z\.enum/);
  const manualReference = await readFile(resolve(kitRoot, "references/shell-mentor.md"), "utf8");
  assert.match(manualReference, /taskTitle.*targetComponentId/s);
});

test("mentor runtime resolves the adapter declared by the composition", async () => {
  const catalog = await loadBlockCatalog(kitRoot);
  const descriptor = resolveMentorAdapter({
    assembly: {
      blocks: ["server.node-sse", "web.a2ui-canvas", "adapter.codex-cli"],
    },
  }, catalog, kitRoot);

  assert.equal(descriptor.id, "adapter.codex-cli");
  assert.equal(descriptor.protocolVersion, 1);
  assert.equal(descriptor.runtime, "node");
  assert.match(descriptor.entry, /blocks\/adapters\/codex-cli\/adapter\.mjs$/);
  assert.equal(descriptor.capabilities.resume, true);
  assert.equal(descriptor.capabilities.streaming, false);
  assert.equal(descriptor.capabilities.interrupt, "process");
});

test("mentor runtime resolves the native Pi adapter", async () => {
  const catalog = await loadBlockCatalog(kitRoot);
  const descriptor = resolveMentorAdapter({
    assembly: { blocks: ["server.node-sse", "web.a2ui-canvas", "adapter.pi-cli"] },
  }, catalog, kitRoot);

  assert.equal(descriptor.id, "adapter.pi-cli");
  assert.equal(descriptor.protocolVersion, 2);
  assert.match(descriptor.entry, /blocks\/adapters\/pi-cli\/adapter\.mjs$/);
  assert.equal(descriptor.capabilities.resume, true);
  assert.equal(descriptor.capabilities.streaming, false);
  assert.equal(descriptor.capabilities.interrupt, "rpc");
  assert.equal(descriptor.capabilities.structuredTurns, true);
  assert.equal(descriptor.capabilities.atomicCommit, true);
});

test("manual adapter is not misrepresented as a persistent mentor", async () => {
  const catalog = await loadBlockCatalog(kitRoot);
  const descriptor = resolveMentorAdapter({
    assembly: { blocks: ["adapter.shell-long-poll"] },
  }, catalog, kitRoot);
  assert.equal(descriptor.persistent, false);
  assert.equal(descriptor.entry, null);
});

test("mentor supervisor restarts crashes, interrupts the active adapter, and stops cleanly", async () => {
  const children = [];
  const unavailable = [];
  const supervisor = new MentorSupervisor({
    spawnAdapter: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.killedWith = signal;
        child.exitCode = signal === "SIGINT" ? 130 : 143;
        queueMicrotask(() => child.emit("exit", child.exitCode, signal));
      };
      children.push(child);
      return child;
    },
    waitUntilReady: async () => "mentor-ready",
    onUnavailable: async (reason) => unavailable.push(reason),
    sleep: async () => {},
    maxRestarts: 2,
  });

  await supervisor.start();
  assert.equal(children.length, 1);
  children[0].exitCode = 1;
  children[0].emit("exit", 1, null);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(children.length, 2);
  assert.equal(unavailable[0], "crash");

  await supervisor.interrupt();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(children[1].killedWith, "SIGINT");
  assert.equal(children.length, 3);
  assert.equal(unavailable[1], "interrupt");

  await supervisor.stop();
  assert.equal(children[2].killedWith, "SIGTERM");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(children.length, 3);
});
