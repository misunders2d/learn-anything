import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constructSession, kitRoot } from "../scripts/construct.mjs";
import { smokeSession } from "../scripts/smoke.mjs";

test("isolated smoke proves assembled browser round trip without polluting transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-server-"));
  try {
    const constructed = await constructSession({ topic: "JavaScript closures", root });
    const result = await smokeSession(constructed.sessionDir, { kitRoot });
    assert.equal(result.ok, true);
    assert.ok(result.validation.checks.includes("dynamic-stage"));
    assert.ok(result.validation.checks.includes("origin-defense"));
    assert.ok(result.validation.checks.includes("mentor-lease"));
    assert.ok(result.validation.checks.includes("real-workspace-write"));
    assert.equal(result.validation.scope, "isolated-protocol-and-execution-plus-real-workspace-write");

    const original = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.deepEqual(original.transcript, []);
    assert.notEqual(original.stage.surfaceId, "smoke");
    assert.equal(original.assembly.validation.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
