import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_REPLAY_ATTEMPTS = 3;

export function initializeRecovery(session) {
  if (!Array.isArray(session.mentorWork)) {
    // Older versions persisted the question but not its queue entry. Ambiguous
    // historical work needs explicit retry, never an automatic duplicate answer.
    const transcript = session.transcript || [];
    const lastAnswer = transcript.findLastIndex((entry) => entry.role === "assistant");
    session.mentorWork = transcript.slice(lastAnswer + 1).filter((entry) => entry.role === "user").slice(-20).map((message) => ({
      turnId: `recovered-${message.id}`, type: "user_message", status: "failed", attempts: 0,
      error: "Previous question needs retry.",
      item: { type: "user_message", message, mentorTurn: { id: `recovered-${message.id}` } },
    }));
  }
  for (const work of session.mentorWork) {
    if ((session.mentorCommittedTurnIds || []).includes(work.turnId)) work.status = "committed";
    if (work.status === "inflight") {
      work.status = work.attempts < MAX_REPLAY_ATTEMPTS ? "pending" : "failed";
      work.error = "Mentor stopped before completing this request.";
    }
  }
  session.progress = { milestone: 0, status: "created", ...(session.progress || {}) };
  session.progress.milestones ||= [];
}

export function recoverySnapshot(session) {
  return session.mentorWork.filter((work) => ["pending", "inflight", "failed"].includes(work.status)).map((work) => ({
    turnId: work.turnId, type: work.type, status: work.status, attempts: work.attempts,
    summary: work.type === "user_message" ? "Your question" : work.type === "execution_result" ? "Submitted code" : "Activity feedback",
    ...(work.error ? { error: work.error } : {}),
  }));
}

export function validateMilestone(value) {
  if (value == null) return null;
  const invalid = () => { throw Object.assign(new Error("Milestone requires title, takeaway, nextStep, and optional concept lists."), { statusCode: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = {};
  for (const [key, max] of [["title", 200], ["takeaway", 4_000], ["nextStep", 1_000]]) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > max) invalid();
    result[key] = value[key].trim();
  }
  for (const key of ["concepts", "misconceptions"]) {
    if (value[key] == null) continue;
    if (!Array.isArray(value[key]) || value[key].length > 30 || value[key].some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 500)) invalid();
    result[key] = value[key].map((entry) => entry.trim());
  }
  return result;
}

export function commitMilestone(session, milestone, turnId) {
  if (!milestone || session.progress.milestones.some((entry) => entry.turnId === turnId)) return;
  const entry = { ...milestone, turnId, createdAt: new Date().toISOString() };
  session.progress.milestones.push(entry);
  session.progress.milestone += 1;
  session.progress.status = "learning";
  session.progress.nextStep = entry.nextStep;
}

export async function reconcileLearningFiles(sessionDir, session) {
  const milestones = session.progress?.milestones || [];
  const line = (value) => String(value).replace(/[\r\n]+/g, " ");
  const journal = milestones.map((entry, index) => `### ${index + 1}. ${line(entry.title)}\n\n${line(entry.takeaway)}\n\nNext: ${line(entry.nextStep)}\n`).join("\n");
  const notes = milestones.map((entry) => `### ${line(entry.title)}\n\n${line(entry.takeaway)}\n${(entry.concepts || []).map((item) => `- Concept: ${line(item)}`).join("\n")}\n${(entry.misconceptions || []).map((item) => `- Clarified: ${line(item)}`).join("\n")}\n`).join("\n");
  for (const [file, title, content] of [["journal.md", "learning journal", journal], ["notes.md", "notes", notes]]) {
    const path = join(sessionDir, file);
    const start = "<!-- learn-anything:derived:start -->";
    const end = "<!-- learn-anything:derived:end -->";
    let existing;
    try { existing = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    existing ||= `# ${line(session.topic)} — ${title}\n\n`;
    const generated = `${start}\n${content}\n${end}`;
    const startIndex = existing.indexOf(start);
    const endIndex = existing.indexOf(end, startIndex);
    const next = startIndex >= 0 && endIndex >= startIndex
      ? `${existing.slice(0, startIndex)}${generated}${existing.slice(endIndex + end.length)}`
      : `${existing.trimEnd()}\n\n${generated}\n`;
    if (next === existing) continue;
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, next, "utf8");
    await rename(temp, path);
  }
}
