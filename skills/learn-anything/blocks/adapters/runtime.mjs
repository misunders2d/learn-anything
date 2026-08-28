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
  } = {}) {
    if (typeof spawnAdapter !== "function" || typeof waitUntilReady !== "function") {
      throw new Error("MentorSupervisor requires spawnAdapter and waitUntilReady.");
    }
    this.spawnAdapter = spawnAdapter;
    this.waitUntilReady = waitUntilReady;
    this.onUnavailable = onUnavailable;
    this.sleep = sleep;
    this.maxRestarts = maxRestarts;
    this.child = null;
    this.stopping = false;
    this.interrupting = false;
    this.restarts = 0;
  }

  async launch() {
    const child = this.spawnAdapter();
    this.child = child;
    child.once("exit", (code, signal) => {
      if (this.child === child) void this.handleExit(code, signal);
    });
    await this.waitUntilReady();
    return child;
  }

  async start() {
    this.stopping = false;
    return this.launch();
  }

  async handleExit() {
    if (this.stopping) return;
    const reason = this.interrupting ? "interrupt" : "crash";
    this.interrupting = false;
    this.child = null;
    await this.onUnavailable(reason);
    if (reason === "crash") {
      if (this.restarts >= this.maxRestarts) return;
      this.restarts += 1;
      await this.sleep(Math.min(2_000, this.restarts * 250));
    }
    if (this.stopping) return;
    try {
      await this.launch();
    } catch {
      await this.handleExit();
    }
  }

  async interrupt() {
    if (!this.child || this.child.exitCode !== null) return false;
    this.interrupting = true;
    this.child.kill("SIGINT");
    return true;
  }

  async stop() {
    this.stopping = true;
    if (this.child?.exitCode === null) this.child.kill("SIGTERM");
    this.child = null;
  }
}
