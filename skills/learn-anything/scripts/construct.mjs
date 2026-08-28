import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeCapabilities } from "./probe.mjs";
import { canvasFromStage, createInitialCanvas } from "../blocks/a2ui/state.mjs";
import { assemblyBlockVersionMismatch, loadBlockCatalog, loadProfiles, profileMatchesCapabilities, selectProfile } from "../blocks/adapters/runtime.mjs";
import { selectExecution } from "../blocks/execution/runner.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const kitRoot = resolve(scriptsDir, "..");

export function slugifyTopic(topic) {
  const slug = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "learning-session";
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function writeMigrationBackup(sessionPath, previousVersion, session) {
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `.${index}`;
    const backupPath = `${sessionPath}.v${previousVersion}${suffix}.backup`;
    try {
      await writeFile(backupPath, `${JSON.stringify(session, null, 2)}\n`, { flag: "wx" });
      return backupPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

const SESSION_SCHEMA_VERSION = 3;
const ASSEMBLY_SCHEMA_VERSION = 1;
const KIT_VERSION = "0.1.5";

function capabilityFingerprint(capabilities, execution) {
  const stable = {
    platform: capabilities.platform,
    arch: capabilities.arch,
    nodeMajor: Number.parseInt(String(capabilities.node).replace(/^v/, "").split(".", 1)[0], 10),
    harness: capabilities.harness,
    executionMode: execution.mode,
    executionRuntime: execution.runtime,
    features: capabilities.features || {},
    commands: Object.fromEntries(Object.entries(capabilities.commands || {})
      .filter(([name]) => execution.mode === "container" || (name !== "docker" && name !== "podman"))
      .map(([name, path]) => [name, Boolean(path)])),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function assertProfileCompatibility(profile, capabilities) {
  if (profileMatchesCapabilities(profile, capabilities)) return;
  if (profile.id === "pi-cli" && !capabilities.features?.piPersistentMentor) {
    throw new Error("Profile pi-cli requires a Pi version with persistent RPC, explicit typed tools, --session-id, and per-course model selection support. Update Pi, then retry.");
  }
  throw new Error(`Profile ${profile.id} is not compatible with the detected capabilities.`);
}

export function validateSessionForStart(session, { capabilities, profiles, catalog }) {
  const profile = profiles.find((candidate) => candidate.id === session.assembly?.profile);
  if (!profile) throw new Error("Saved session profile is unavailable. Run learn-anything create for this topic with --migrate.");
  assertProfileCompatibility(profile, capabilities);
  if (session.schemaVersion !== SESSION_SCHEMA_VERSION
    || session.assembly?.schemaVersion !== ASSEMBLY_SCHEMA_VERSION
    || session.assembly?.kitVersion !== KIT_VERSION
    || assemblyBlockVersionMismatch(session, catalog)) {
    throw new Error("Saved session requires explicit migration. Run learn-anything create for this topic with --migrate.");
  }
  return profile;
}

function buildAssembly(profile, capabilities, catalog, execution) {
  const blocks = [...profile.blocks, execution.blockId];
  const versions = Object.fromEntries(blocks.map((id) => {
    const block = catalog.blocks.find((candidate) => candidate.id === id);
    if (!block) throw new Error(`Profile ${profile.id} references unknown block ${id}.`);
    return [id, Number(block.version || 1)];
  }));
  return {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    profile: profile.id,
    blocks,
    blockVersions: versions,
    capabilityFingerprint: capabilityFingerprint(capabilities, execution),
    capabilities,
    execution,
    degraded: [...(profile.degraded || []), ...execution.degraded],
    validation: { status: "pending", checkedAt: null },
  };
}


export async function constructSession({
  topic,
  root,
  general = false,
  profile = "auto",
  env = process.env,
  migrate = false,
  execution = "host",
  capabilityProbe = probeCapabilities,
} = {}) {
  if (!topic || !topic.trim()) throw new Error("Topic is required.");
  const capabilities = capabilityProbe({ env });
  const selectedExecution = selectExecution(capabilities, { mode: execution });
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!capabilities.commands.node || nodeMajor < 20) throw new Error("Node.js 20 or newer is required by bundled server block.");

  const [profiles, catalog] = await Promise.all([loadProfiles(kitRoot), loadBlockCatalog(kitRoot)]);
  const automaticallySelected = selectProfile(profiles, capabilities);
  const requestedProfile = profile === "auto"
    ? automaticallySelected
    : profiles.find((candidate) => candidate.id === profile);
  if (!requestedProfile) throw new Error(`Unknown profile: ${profile}`);
  if (profile !== "auto") assertProfileCompatibility(requestedProfile, capabilities);

  const base = general ? join(homedir(), "learnings") : resolve(root || process.cwd(), ".learnings");
  const sourceRoot = general ? null : resolve(root || process.cwd());
  const sessionDir = join(base, slugifyTopic(topic));
  const sessionPath = join(sessionDir, "session.json");
  await mkdir(join(sessionDir, "exercises"), { recursive: true });
  await mkdir(join(sessionDir, "references"), { recursive: true });

  let session;
  let resumed = false;
  let migrated = false;
  try {
    session = await readJson(sessionPath);
    resumed = true;
    const existingProfile = profiles.find((candidate) => candidate.id === session.assembly?.profile);
    const targetProfile = profile === "auto" && existingProfile ? existingProfile : requestedProfile;
    assertProfileCompatibility(targetProfile, capabilities);
    const blockVersionMismatch = assemblyBlockVersionMismatch(session, catalog);
    const migrationRequired = session.schemaVersion !== SESSION_SCHEMA_VERSION
      || session.assembly?.schemaVersion !== ASSEMBLY_SCHEMA_VERSION
      || session.assembly?.kitVersion !== KIT_VERSION
      || blockVersionMismatch
      || session.assembly?.execution?.mode !== selectedExecution.mode
      || (profile !== "auto" && session.assembly?.profile !== targetProfile.id);
    if (migrationRequired && !migrate) {
      throw new Error(`Existing session requires explicit migration; rerun create with --migrate (current profile: ${session.assembly?.profile || "unknown"}).`);
    }
    if (migrationRequired) {
      const previousVersion = Number(session.schemaVersion || 1);
      await writeMigrationBackup(sessionPath, previousVersion, session);
      if (!session.canvas) session.canvas = canvasFromStage(session.stage, session.topic);
      delete session.stage;
      session.schemaVersion = SESSION_SCHEMA_VERSION;
      session.assembly = buildAssembly(targetProfile, capabilities, catalog, selectedExecution);
      await atomicJson(sessionPath, session);
      migrated = true;
    } else if (session.assembly.capabilityFingerprint !== capabilityFingerprint(capabilities, selectedExecution)) {
      session.assembly.validation = {
        status: "stale",
        checkedAt: null,
        reason: "capabilities-changed",
      };
      await atomicJson(sessionPath, session);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      topic: topic.trim(),
      slug: slugifyTopic(topic),
      sourceRoot,
      createdAt: now,
      updatedAt: now,
      agentSessionId: requestedProfile.id === "pi-cli" ? randomUUID() : null,
      mentorSessionInitialized: false,
      mentorModel: null,
      security: { accessToken: randomBytes(32).toString("base64url") },
      transcript: [],
      canvas: createInitialCanvas(topic.trim()),
      progress: { milestone: 0, status: "created" },
      assembly: buildAssembly(requestedProfile, capabilities, catalog, selectedExecution),
    };
    await atomicJson(sessionPath, session);
    await writeFile(join(sessionDir, "journal.md"), `# ${topic.trim()} — learning journal\n\n`, { flag: "wx" });
    await writeFile(join(sessionDir, "notes.md"), `# ${topic.trim()} — notes\n\n`, { flag: "wx" });
  }

  let sessionChanged = false;
  if (session.assembly?.profile === "pi-cli" && !session.agentSessionId) {
    session.agentSessionId = randomUUID();
    session.mentorSessionInitialized = false;
    sessionChanged = true;
  }
  if (session.mentorSessionInitialized === undefined) {
    session.mentorSessionInitialized = false;
    sessionChanged = true;
  }
  if (session.mentorModel === undefined) {
    session.mentorModel = null;
    sessionChanged = true;
  }
  if (!session.security?.accessToken) {
    session.security = { ...(session.security || {}), accessToken: randomBytes(32).toString("base64url") };
    sessionChanged = true;
  }
  if (sessionChanged) await atomicJson(sessionPath, session);

  return {
    resumed,
    migrated,
    sessionDir,
    sessionPath,
    profile: session.assembly.profile,
    capabilities,
    warnings: session.assembly.degraded || [],
    requiresRevalidation: session.assembly.validation?.status !== "passed",
  };
}

export async function updateValidation(sessionDir, validation) {
  const sessionPath = join(resolve(sessionDir), "session.json");
  const session = await readJson(sessionPath);
  session.updatedAt = new Date().toISOString();
  session.assembly.validation = validation;
  await atomicJson(sessionPath, session);
}
