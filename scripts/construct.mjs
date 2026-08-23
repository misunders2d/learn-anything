import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeCapabilities } from "./probe.mjs";

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

function initialStage(topic) {
  return {
    version: "learn-anything/v1",
    surfaceId: "lesson",
    focus: "chat",
    title: topic,
    components: [],
  };
}

export async function constructSession({
  topic,
  root,
  general = false,
  profile = "auto",
  env = process.env,
} = {}) {
  if (!topic || !topic.trim()) throw new Error("Topic is required.");
  const capabilities = probeCapabilities({ env });
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!capabilities.commands.node || nodeMajor < 20) throw new Error("Node.js 20 or newer is required by bundled server block.");

  const selectedProfile = profile === "auto"
    ? capabilities.harness === "claude-code"
      ? "reference-streaming"
      : capabilities.harness === "codex" && capabilities.commands.codex
        ? "codex-cli"
        : "portable-shell"
    : profile;
  if (!["portable-shell", "reference-streaming", "codex-cli"].includes(selectedProfile)) {
    throw new Error(`Unknown profile: ${selectedProfile}`);
  }

  const base = general ? join(homedir(), "learnings") : resolve(root || process.cwd(), ".learnings");
  const sourceRoot = general ? null : resolve(root || process.cwd());
  const sessionDir = join(base, slugifyTopic(topic));
  const sessionPath = join(sessionDir, "session.json");
  await mkdir(join(sessionDir, "exercises"), { recursive: true });
  await mkdir(join(sessionDir, "references"), { recursive: true });

  let session;
  let resumed = false;
  try {
    session = await readJson(sessionPath);
    resumed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    session = {
      schemaVersion: 1,
      topic: topic.trim(),
      slug: slugifyTopic(topic),
      sourceRoot,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      security: { accessToken: randomBytes(32).toString("base64url") },
      transcript: [],
      stage: initialStage(topic.trim()),
      progress: { milestone: 0, status: "created" },
      assembly: {
        kitVersion: "0.1.0",
        profile: selectedProfile,
        blocks: selectedProfile === "portable-shell"
          ? ["server.node-sse", "web.dynamic-stage", "adapter.shell-long-poll", "execution.host-fixed-runners"]
          : selectedProfile === "codex-cli"
            ? ["server.node-sse", "web.dynamic-stage", "adapter.codex-cli", "execution.host-fixed-runners"]
            : ["server.node-sse", "web.dynamic-stage", "adapter.claude-agent-sdk", "execution.host-fixed-runners"],
        capabilities,
        degraded: [
          ...(selectedProfile === "portable-shell" ? ["mentor-output-may-arrive-per-turn"] : []),
          ...(selectedProfile === "codex-cli" ? ["mentor-output-arrives-after-headless-turn"] : []),
          "host-execution",
        ],
        validation: { status: "pending", checkedAt: null },
      },
    };
    await atomicJson(sessionPath, session);
    await writeFile(join(sessionDir, "journal.md"), `# ${topic.trim()} — learning journal\n\n`, { flag: "wx" });
    await writeFile(join(sessionDir, "notes.md"), `# ${topic.trim()} — notes\n\n`, { flag: "wx" });
  }

  if (!session.security?.accessToken) {
    session.security = { ...(session.security || {}), accessToken: randomBytes(32).toString("base64url") };
    await atomicJson(sessionPath, session);
  }

  return {
    resumed,
    sessionDir,
    sessionPath,
    profile: session.assembly?.profile ?? selectedProfile,
    capabilities,
    warnings: session.assembly?.degraded ?? [],
  };
}

export async function updateValidation(sessionDir, validation) {
  const sessionPath = join(resolve(sessionDir), "session.json");
  const session = await readJson(sessionPath);
  session.updatedAt = new Date().toISOString();
  session.assembly.validation = validation;
  await atomicJson(sessionPath, session);
}
