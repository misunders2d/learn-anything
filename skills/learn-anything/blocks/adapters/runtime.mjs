import { readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const MENTOR_PROTOCOL_VERSION = 1;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadBlockCatalog(kitRoot) {
  const catalog = await readJson(resolve(kitRoot, "blocks/catalog.json"));
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.blocks)) throw new Error("Invalid block catalog.");
  return catalog;
}

export async function loadProfiles(kitRoot) {
  const directory = resolve(kitRoot, "profiles");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const profiles = await Promise.all(files.map((name) => readJson(resolve(directory, name))));
  if (profiles.some((profile) => !profile?.id || !Array.isArray(profile.blocks))) throw new Error("Invalid profile metadata.");
  return profiles;
}

export function assemblyBlockVersionMismatch(session, catalog) {
  return (session.assembly?.blocks || []).some((id) => {
    const block = catalog.blocks.find((candidate) => candidate.id === id);
    return !block || Number(session.assembly?.blockVersions?.[id]) !== Number(block.version || 1);
  });
}

export function profileMatchesCapabilities(profile, capabilities) {
  const selection = profile.selection || {};
  if (selection.harnesses?.length && !selection.harnesses.includes(capabilities.harness)) return false;
  if (!(selection.requiredCommands || []).every((command) => Boolean(capabilities.commands?.[command]))) return false;
  return (selection.requiredCapabilities || []).every((capability) => capabilities.features?.[capability] === true);
}

function profileScore(profile, capabilities) {
  const selection = profile.selection || {};
  const preferred = selection.preferredHarnesses?.includes(capabilities.harness);
  return Number(selection.priority || 0) + (preferred ? Number(selection.preferenceBonus || 0) : 0);
}

export function selectProfile(profiles, capabilities) {
  const candidates = profiles
    .filter((profile) => profile.selection?.manualOnly !== true)
    .filter((profile) => profileMatchesCapabilities(profile, capabilities))
    .sort((left, right) => profileScore(right, capabilities) - profileScore(left, capabilities));
  const selected = candidates[0];
  if (!selected) throw new Error("No compatible learn-anything profile is available.");
  return selected;
}

function safeEntry(kitRoot, entry) {
  const root = resolve(kitRoot);
  const path = resolve(root, entry);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Mentor adapter entry escapes the kit root.");
  return path;
}

export function resolveMentorAdapter(session, catalog, kitRoot) {
  const blockIds = session?.assembly?.blocks || [];
  const adapters = catalog.blocks.filter((block) => block.kind === "mentor-adapter" && blockIds.includes(block.id));
  if (adapters.length !== 1) throw new Error(`Composition must select exactly one mentor adapter; found ${adapters.length}.`);
  const block = adapters[0];
  const runtime = block.runtime || {};
  const persistent = runtime.persistent !== false;
  if (persistent && (!runtime.entry || runtime.runtime !== "node")) throw new Error(`Mentor adapter ${block.id} has no supported runtime.`);
  return {
    id: block.id,
    protocolVersion: runtime.protocolVersion,
    runtime: runtime.runtime || null,
    entry: runtime.entry ? safeEntry(kitRoot, runtime.entry) : null,
    persistent,
    capabilities: { ...(runtime.capabilities || {}) },
  };
}

export class MentorSupervisor {
  constructor({
    spawnAdapter,
    waitUntilReady,
    onUnavailable = async () => {},
    sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    maxRestarts = 3,
    healthyMs = 60_000,
    now = Date.now,
    killTimeoutMs = 1_000,
  } = {}) {
    if (typeof spawnAdapter !== "function" || typeof waitUntilReady !== "function") {
      throw new Error("MentorSupervisor requires spawnAdapter and waitUntilReady.");
    }
    this.spawnAdapter = spawnAdapter;
    this.waitUntilReady = waitUntilReady;
    this.onUnavailable = onUnavailable;
    this.sleep = sleep;
    this.maxRestarts = maxRestarts;
    this.healthyMs = healthyMs;
    this.now = now;
    this.killTimeoutMs = killTimeoutMs;
    this.readyAt = null;
    this.recovery = null;
    this.child = null;
    this.stopping = false;
    this.interrupting = false;
    this.restarts = 0;
  }

  async terminate(child, signal = "SIGTERM") {
    if (!child || child.exitCode !== null || child.signalCode || child.spawnfile && !child.pid) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), this.killTimeoutMs);
      child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
      child.kill(signal);
    });
  }

  async launch() {
    const child = this.spawnAdapter();
    this.child = child;
    let ready = false;
    let rejectExit;
    const exited = new Promise((_, reject) => { rejectExit = reject; });
    const onExit = (code, signal) => {
      if (!ready) rejectExit(new Error(`Mentor exited before readiness: ${code ?? signal}`));
      else if (this.child === child) void this.handleExit();
    };
    child.once("exit", onExit);
    child.once("error", rejectExit);
    try {
      await Promise.race([this.waitUntilReady(), exited]);
      if (this.stopping || this.child !== child || child.exitCode !== null || child.signalCode) throw new Error("Mentor stopped before readiness.");
      ready = true;
      this.readyAt = this.now();
      return child;
    } catch (error) {
      if (this.child === child) this.child = null;
      await this.terminate(child);
      throw error;
    } finally {
      child.removeListener("error", rejectExit);
    }
  }

  async start() {
    this.stopping = false;
    this.restarts = 0;
    return this.launch();
  }

  async handleExit() {
    if (this.stopping) return;
    if (this.recovery) return this.recovery;
    this.recovery = this.recover();
    try { await this.recovery; } finally { this.recovery = null; }
  }

  async recover() {
    let reason = this.interrupting ? "interrupt" : "crash";
    this.interrupting = false;
    this.child = null;
    if (this.readyAt !== null && this.now() - this.readyAt >= this.healthyMs) this.restarts = 0;
    this.readyAt = null;
    while (!this.stopping) {
      await this.onUnavailable(reason);
      if (reason === "crash") {
        if (this.restarts >= this.maxRestarts) return;
        this.restarts += 1;
        await this.sleep(Math.min(2_000, this.restarts * 250));
      }
      if (this.stopping) return;
      try { await this.launch(); return; }
      catch { reason = "crash"; }
    }
  }

  async interrupt() {
    if (!this.child || this.child.exitCode !== null) return false;
    this.interrupting = true;
    await this.terminate(this.child, "SIGINT");
    return true;
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    await this.terminate(child);
    await this.recovery;
  }
}
