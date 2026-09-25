import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMPONENT_NAMES } from "./catalog.mjs";
import { applyA2uiMessages, replayA2uiMessages, resolveDataBinding } from "./state.mjs";

const MAX_BYTES = 24_000;
const COMPONENTS = new Set(COMPONENT_NAMES);
const PRIVATE_KEYS = new Set(["lastResult", "executedCode", "codeHash", "accessToken", "transcript", "agentSessionId", "mentorSessionId", "mentorWork", "security", "password", "apiKey", "privateKey"]);
const invalid = (message) => { throw Object.assign(new Error(`Teaching pattern: ${message}`), { statusCode: 400 }); };

export function defaultTeachingLibraryDir(env = process.env) {
  return resolve(env.LEARN_ANYTHING_LIBRARY_DIR || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "learn-anything", "patterns"));
}

function cleanText(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${label} requires 1–${max} characters.`);
  return value.trim();
}

function rejectLearnerState(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) invalid("private or runtime state is not reusable lesson content.");
    if (key === "done" && child !== false || ["selected", "selectedOptionId"].includes(key) && child !== null && child !== false) invalid("completed learner answers must not be saved.");
    rejectLearnerState(child);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function validateTeachingPattern(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) invalid("expected an object.");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid(`maximum size is ${MAX_BYTES} bytes.`);
  const title = cleanText(value.title, 120, "title");
  const description = cleanText(value.description, 1_000, "description");
  const tags = value.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 12) invalid("use at most 12 tags.");
  const normalizedTags = [...new Set(tags.map((tag) => cleanText(tag, 40, "tag").toLowerCase()))].sort();
  if (!Array.isArray(value.messages) || !value.messages.length) invalid("standalone A2UI messages are required.");
  rejectLearnerState(value.messages);
  const canvas = applyA2uiMessages({ focus: "work", activeSurfaceId: null, surfaces: {} }, value.messages, { focus: "work" });
  const surfaces = Object.values(canvas.surfaces);
  if (surfaces.length !== 1) invalid("save one standalone composition.");
  // JSON pointers can introduce keys absent from the original message objects.
  rejectLearnerState(canvas);
  for (const surface of surfaces) rejectLearnerState(resolveDataBinding(surface.components, surface.dataModel));
  const components = Object.values(surfaces[0].components);
  if (components.length < 2 || components.some((component) => !COMPONENTS.has(component.component))) invalid("use supported renderer primitives in a nonempty composition.");
  const pattern = { title, description, tags: normalizedTags, messages: replayA2uiMessages(canvas) };
  if (Buffer.byteLength(JSON.stringify(pattern)) > MAX_BYTES) invalid(`maximum normalized size is ${MAX_BYTES} bytes.`);
  return pattern;
}

function patternId(pattern) {
  return createHash("sha256").update(JSON.stringify(stable(pattern))).digest("hex");
}

export async function saveTeachingPattern(value, { libraryDir = defaultTeachingLibraryDir() } = {}) {
  const pattern = validateTeachingPattern(value);
  if (!pattern) invalid("cannot save an empty pattern.");
  const record = { schemaVersion: 1, id: patternId(pattern), ...pattern };
  await mkdir(libraryDir, { recursive: true, mode: 0o700 });
  const path = join(libraryDir, `${record.id}.json`);
  const temporary = join(libraryDir, `.${record.id}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export async function loadTeachingPatterns({ libraryDir = defaultTeachingLibraryDir(), query = "", limit = 3 } = {}) {
  let entries;
  try { entries = await readdir(libraryDir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const words = String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const matches = [];
  for (const name of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, 512)) {
    try {
      const path = join(libraryDir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_BYTES * 3) continue;
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.schemaVersion !== 1 || `${record.id}.json` !== name) continue;
      const pattern = validateTeachingPattern({ title: record.title, description: record.description, tags: record.tags, messages: record.messages });
      if (patternId(pattern) !== record.id) continue;
      const searchable = `${pattern.title} ${pattern.description} ${pattern.tags.join(" ")}`.toLowerCase();
      const score = words.reduce((total, word) => total + Number(searchable.includes(word)), 0);
      matches.push({ score, record: { schemaVersion: 1, id: record.id, ...pattern } });
    } catch {
      // A corrupt or obsolete entry must not prevent a lesson from starting.
    }
  }
  const result = [];
  let bytes = 0;
  for (const { record } of matches.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (result.length >= Math.max(0, Math.min(3, limit)) || bytes + size > 48_000) break;
    result.push(record);
    bytes += size;
  }
  return result;
}
