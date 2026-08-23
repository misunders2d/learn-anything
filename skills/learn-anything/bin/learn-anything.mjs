#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { constructSession, kitRoot } from "../scripts/construct.mjs";
import { probeCapabilities } from "../scripts/probe.mjs";
import { smokeSession } from "../scripts/smoke.mjs";
import { watchOwnerProcess } from "../scripts/process-lifecycle.mjs";
import { createLearnAnythingServer } from "../blocks/server/server.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(args, name) {
  return args.includes(name);
}

function output(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${format(value)}\n`);
}

function format(value) {
  if (typeof value === "string") return value;
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(", ") : typeof item === "object" && item !== null ? JSON.stringify(item) : item}`)
    .join("\n");
}

function openBrowser(url, opener) {
  if (!opener) return false;
  let command = opener;
  let args = [url];
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (opener.endsWith("gio")) args = ["open", url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.unref();
  return true;
}

async function startMentor(sessionDir, url) {
  const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
  const adapter = session.assembly?.profile === "codex-cli"
    ? "blocks/adapters/codex-cli/adapter.mjs"
    : session.assembly?.profile === "reference-streaming"
      ? "blocks/adapters/claude-agent-sdk/adapter.mjs"
      : null;
  if (!adapter) return null;
  return spawn(process.execPath, [resolve(kitRoot, adapter), "--url", url, "--session", resolve(sessionDir)], {
    cwd: resolve(sessionDir),
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function mentorExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(`Mentor exited before attaching (${code ?? signal ?? "unknown"}).`));
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const ownerPid = process.ppid;
  const json = has(args, "--json");

  if (command === "probe") {
    output(probeCapabilities(), json);
    return;
  }

  if (command === "create") {
    const topic = args[0] && !args[0].startsWith("--") ? args[0] : option(args, "--topic");
    const result = await constructSession({
      topic,
      root: option(args, "--root", process.cwd()),
      general: has(args, "--general"),
      profile: option(args, "--profile", "auto"),
    });
    output(result, json);
    return;
  }

  if (command === "smoke") {
    const sessionDir = option(args, "--session");
    if (!sessionDir) throw new Error("--session is required.");
    output(await smokeSession(sessionDir, { kitRoot }), json);
    return;
  }

  if (command === "start") {
    const sessionDir = option(args, "--session");
    if (!sessionDir) throw new Error("--session is required.");
    const host = option(args, "--host", "127.0.0.1");
    const requestedPort = Number(option(args, "--port", "0"));
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("--port must be an integer from 0 through 65535.");
    const runtime = await createLearnAnythingServer({ sessionDir: resolve(sessionDir), kitRoot, host, port: requestedPort });
    let mentor = null;
    let clearOwnerWatch = () => {};
    let cleanupPromise = null;
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        clearOwnerWatch();
        if (mentor?.exitCode === null) mentor.kill("SIGTERM");
        await runtime.close();
      })();
      return cleanupPromise;
    };
    const stop = async () => {
      await cleanup();
      process.exit(0);
    };

    try {
      const address = await runtime.listen();
      const noMentor = has(args, "--no-mentor");
      mentor = noMentor ? null : await startMentor(sessionDir, address.url);
      if (!noMentor && !mentor) {
        throw new Error("Selected profile has no persistent mentor. Recreate with codex-cli or reference-streaming, or pass --no-mentor for explicit manual mode.");
      }
      if (mentor) {
        await Promise.race([runtime.waitForMentor(15_000), mentorExit(mentor)]);
        mentor.once("exit", () => void stop());
      }
      clearOwnerWatch = watchOwnerProcess({ ownerPid, onOwnerExit: stop });
      const capabilities = probeCapabilities();
      const shouldOpen = has(args, "--open") && !has(args, "--no-open");
      const opened = shouldOpen ? openBrowser(address.launchUrl, capabilities.browserOpener) : false;
      output({ ...address, opened, mentorAttached: Boolean(mentor), sessionDir: resolve(sessionDir) }, json);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
      return;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  process.stdout.write(`learn-anything constructor\n\nCommands:\n  probe [--json]\n  create <topic> [--root path|--general] [--profile portable-shell|reference-streaming|codex-cli] [--json]\n  start --session path [--host 127.0.0.1] [--port 0] [--open|--no-open] [--no-mentor] [--json]\n  smoke --session path [--json]\n`);
}

main().catch((error) => {
  process.stderr.write(`learn-anything: ${error.message}\n`);
  process.exitCode = 1;
});
