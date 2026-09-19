import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";

const execute = promisify(execFile);
test("manual next/turn commits once and advances to the next learner question", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-manual-"));
  let server;
  try {
    const course = await constructSession({ topic: "Acting", root, profile: "portable-shell", capabilityProbe: () => ({ harness: "shell", commands: { node: process.execPath }, features: {} }) });
    server = await createLearnAnythingServer({ sessionDir: course.sessionDir, kitRoot, teachingLibraryDir: join(root, "patterns"), port: 0 });
    const address = await server.listen();
    const args = ["--url", address.url, "--token", address.accessToken, "--mentor-id", "manual-test"];
    async function command(name, extra = []) {
      const { stdout } = await execute(process.execPath, [join(kitRoot, "scripts/mentor.mjs"), name, ...args, ...extra]);
      return JSON.parse(stdout);
    }
    async function question(text) {
      const response = await fetch(`${address.url}/api/message`, { method: "POST", headers: { "content-type": "application/json", "x-learn-anything-token": address.accessToken }, body: JSON.stringify({ text }) });
      assert.equal(response.status, 202);
    }
    await question("How does an objective change a line?");
    const first = await command("next", ["--takeover"]);
    const payload = join(root, "turn.json");
    await writeFile(payload, JSON.stringify({ turnId: first.mentorTurn.id, baseRevision: first.mentorTurn.baseRevision, message: "An objective changes what you try to achieve with the same words.", focus: "chat", messages: [], continuation: { kind: "question", text: "What might the speaker want?" } }));
    assert.equal((await command("turn", ["--file", payload])).committed, true);
    assert.equal((await command("turn", ["--file", payload])).idempotent, true);
    await question("Could the speaker want reassurance?");
    const second = await command("next");
    assert.notEqual(second.mentorTurn.id, first.mentorTurn.id);
    assert.equal(second.message.content, "Could the speaker want reassurance?");
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
