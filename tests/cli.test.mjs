import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(projectRoot, "bin/learn-anything.mjs");

test("public CLI probes, constructs, resumes, and smoke-validates a workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-cli-"));
  try {
    const probe = await execFileAsync(process.execPath, [cli, "probe", "--json"]);
    assert.equal(JSON.parse(probe.stdout).schemaVersion, 1);

    const created = await execFileAsync(process.execPath, [
      cli,
      "create",
      "Rust lifetimes",
      "--root",
      root,
      "--profile",
      "portable-shell",
      "--json",
    ]);
    const first = JSON.parse(created.stdout);
    assert.equal(first.resumed, false);
    assert.equal(first.profile, "portable-shell");

    const smoke = await execFileAsync(process.execPath, [
      cli,
      "smoke",
      "--session",
      first.sessionDir,
      "--json",
    ]);
    assert.equal(JSON.parse(smoke.stdout).ok, true);

    const resumed = await execFileAsync(process.execPath, [
      cli,
      "create",
      "Rust lifetimes",
      "--root",
      root,
      "--profile",
      "portable-shell",
      "--json",
    ]);
    assert.equal(JSON.parse(resumed.stdout).resumed, true);

    const session = JSON.parse(await readFile(first.sessionPath, "utf8"));
    assert.equal(session.assembly.validation.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public CLI start serves the assembled workspace and shuts down cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-cli-start-"));
  let child;
  try {
    const created = await execFileAsync(process.execPath, [
      cli,
      "create",
      "Event loops",
      "--root",
      root,
      "--profile",
      "portable-shell",
      "--json",
    ]);
    const sessionDir = JSON.parse(created.stdout).sessionDir;
    child = spawn(process.execPath, [cli, "start", "--session", sessionDir, "--port", "0", "--no-open", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const address = await new Promise((resolveAddress, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error(`CLI start timed out: ${stderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        try {
          const parsed = JSON.parse(stdout);
          clearTimeout(timeout);
          resolveAddress(parsed);
        } catch {
          // JSON output may span several chunks.
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        if (code && !stdout) {
          clearTimeout(timeout);
          reject(new Error(`CLI start exited ${code}: ${stderr}`));
        }
      });
    });

    const health = await fetch(`${address.url}/healthz`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.match(address.accessToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(address.launchUrl, `${address.url}/#token=${address.accessToken}`);
    assert.equal(address.mentorAttached, false);
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    child = null;
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
