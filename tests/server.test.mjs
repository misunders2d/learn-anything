import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import { smokeSession } from "../skills/learn-anything/scripts/smoke.mjs";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";

test("isolated smoke proves assembled browser round trip without polluting transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-server-"));
  try {
    const constructed = await constructSession({ topic: "JavaScript closures", root });
    const result = await smokeSession(constructed.sessionDir, { kitRoot });
    assert.equal(result.ok, true);
    assert.ok(result.validation.checks.includes("a2ui-canvas"));
    assert.ok(result.validation.checks.includes("origin-defense"));
    assert.ok(result.validation.checks.includes("mentor-lease"));
    assert.ok(result.validation.checks.includes("real-workspace-write"));
    assert.equal(result.validation.scope, "isolated-protocol-and-execution-plus-real-workspace-write");

    const original = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.deepEqual(original.transcript, []);
    assert.notEqual(original.canvas.activeSurfaceId, "smoke");
    assert.equal(original.assembly.validation.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server signals shutdown after the final browser connection closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-browser-lifecycle-"));
  let runtime;
  try {
    const constructed = await constructSession({ topic: "Browser lifecycle", root });
    runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot });
    let resolveDisconnected;
    const disconnected = new Promise((resolvePromise) => { resolveDisconnected = resolvePromise; });
    runtime.setBrowserDisconnectHandler(resolveDisconnected, { graceMs: 10 });
    const address = await runtime.listen();
    const controller = new AbortController();
    const response = await fetch(`${address.url}/api/events?token=${encodeURIComponent(address.accessToken)}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    await response.body.getReader().read();
    controller.abort();
    await Promise.race([
      disconnected,
      new Promise((_, reject) => setTimeout(() => reject(new Error("browser disconnect was not observed")), 1_000)),
    ]);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
