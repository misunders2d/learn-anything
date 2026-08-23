import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(projectRoot, "skills/learn-anything/bin/learn-anything.mjs");

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid, timeout = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
}

test("workspace server exits when its owning launcher exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-owner-"));
  let serverPid = null;
  try {
    const created = await execFileAsync(process.execPath, [
      cli,
      "create",
      "Owner lifecycle",
      "--root",
      root,
      "--profile",
      "portable-shell",
      "--json",
    ]);
    const sessionDir = JSON.parse(created.stdout).sessionDir;
    const wrapperSource = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ${JSON.stringify([
        cli,
        "start",
        "--session",
        "__SESSION__",
        "--port",
        "0",
        "--no-open",
        "--no-mentor",
        "--json",
      ])}.map(value => value === "__SESSION__" ? process.argv[1] : value), {
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.stdout.once("data", chunk => {
        process.stdout.write(JSON.stringify({ pid: child.pid, address: JSON.parse(chunk.toString()) }));
        process.exit(0);
      });
    `;
    const wrapper = await execFileAsync(process.execPath, ["-e", wrapperSource, sessionDir]);
    const launched = JSON.parse(wrapper.stdout);
    serverPid = launched.pid;
    assert.equal(await waitForExit(serverPid), true, `server ${serverPid} survived its launcher`);
    serverPid = null;
  } finally {
    if (serverPid && processExists(serverPid)) process.kill(serverPid, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
