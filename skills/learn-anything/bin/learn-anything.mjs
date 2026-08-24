#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { constructSession, kitRoot } from "../scripts/construct.mjs";
import { probeCapabilities } from "../scripts/probe.mjs";
import { smokeSession } from "../scripts/smoke.mjs";
import { watchOwnerProcess } from "../scripts/process-lifecycle.mjs";
import { loadBlockCatalog, MentorSupervisor, resolveMentorAdapter } from "../blocks/adapters/runtime.mjs";
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

async function loadMentorDescriptor(sessionDir) {
  const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
  const catalog = await loadBlockCatalog(kitRoot);
  return resolveMentorAdapter(session, catalog, kitRoot);
}

function spawnMentor(descriptor, sessionDir, url) {
  return spawn(process.execPath, [descriptor.entry, "--url", url, "--session", resolve(sessionDir)], {
    cwd: resolve(sessionDir),
    stdio: ["ignore", "inherit", "inherit"],
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
      execution: option(args, "--execution", "host"),
      migrate: has(args, "--migrate"),
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
    const savedSession = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8"));
    if (savedSession.assembly?.validation?.status !== "passed") {
      await smokeSession(sessionDir, { kitRoot });
    }
    const runtime = await createLearnAnythingServer({ sessionDir: resolve(sessionDir), kitRoot, host, port: requestedPort });
    let supervisor = null;
    let mentorDescriptor = null;
    let clearOwnerWatch = () => {};
    let cleanupPromise = null;
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        clearOwnerWatch();
        await supervisor?.stop();
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
      mentorDescriptor = noMentor ? null : await loadMentorDescriptor(sessionDir);
      if (!noMentor && !mentorDescriptor?.persistent) {
        throw new Error("Selected composition has no persistent mentor. Choose a compatible adapter, or pass --no-mentor for explicit manual mode.");
      }
      if (mentorDescriptor) {
        supervisor = new MentorSupervisor({
          spawnAdapter: () => spawnMentor(mentorDescriptor, sessionDir, address.url),
          waitUntilReady: () => runtime.waitForMentor(30_000),
          onUnavailable: (reason) => runtime.markMentorUnavailable(reason),
        });
        runtime.setInterruptHandler(() => supervisor.interrupt());
        await supervisor.start();
      }
      clearOwnerWatch = watchOwnerProcess({ ownerPid, onOwnerExit: stop });
      runtime.setBrowserDisconnectHandler(stop);
      const capabilities = probeCapabilities();
      const shouldOpen = has(args, "--open") && !has(args, "--no-open");
      const opened = shouldOpen ? openBrowser(address.launchUrl, capabilities.browserOpener) : false;
      output({ ...address, opened, mentorAttached: Boolean(supervisor?.child), mentorCapabilities: mentorDescriptor?.capabilities || null, sessionDir: resolve(sessionDir) }, json);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
      return;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  process.stdout.write(`learn-anything constructor\n\nCommands:\n  probe [--json]\n  create <topic> [--root path|--general] [--profile id] [--execution host|container] [--migrate] [--json]\n  start --session path [--host 127.0.0.1] [--port 0] [--open|--no-open] [--no-mentor] [--json]\n  smoke --session path [--json]\n`);
}

main().catch((error) => {
  process.stderr.write(`learn-anything: ${error.message}\n`);
  process.exitCode = 1;
});
