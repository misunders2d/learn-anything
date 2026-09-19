import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";

async function fixture(t, prepare) {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-reliability-"));
  const constructed = await constructSession({ topic: "Reliable learning", root, profile: "portable-shell" });
  const f = { root, ...constructed, mentorId: "test-mentor" };
  f.saved = async () => JSON.parse(await readFile(f.sessionPath, "utf8"));
  f.request = async (path, body, mentor = false) => {
    const response = await fetch(`${f.address.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json", "x-learn-anything-token": f.address.accessToken,
        ...(mentor ? { "x-learn-anything-mentor": f.mentorId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  f.snapshot = async () => (await f.request("/api/session")).body;
  f.next = async () => (await f.request(`/api/mentor/next?mentorId=${f.mentorId}`)).body;
  f.restart = async () => {
    await f.runtime?.close();
    f.runtime = await createLearnAnythingServer({ sessionDir: f.sessionDir, kitRoot, teachingLibraryDir: join(root, "patterns") });
    f.address = await f.runtime.listen();
    await f.request("/api/mentor/register", { mentorId: f.mentorId, takeover: true });
  };
  t.after(async () => { await f.runtime?.close(); await rm(root, { recursive: true, force: true }); });
  if (prepare) await prepare(f);
  await f.restart();
  return f;
}

const continuation = { kind: "action", text: "Run the code and inspect its output.", taskTitle: "Code experiment", targetComponentId: "code", actionType: "run" };
async function codeActivity(f, value = "console.log('A')", runner = "javascript") {
  const response = await f.request("/api/a2ui", {
    focus: "work", continuation,
    messages: [
      { version: "v0.9", createSurface: { surfaceId: "exercise", catalogId: "urn:learn-anything:catalog:v1" } },
      { version: "v0.9", updateComponents: { surfaceId: "exercise", components: [
        { id: "root", component: "Column", children: ["code"] },
        { id: "code", component: "Code", language: "javascript", runnable: true, run: { runner }, value },
      ] } },
    ],
  }, true);
  assert.equal(response.status, 202, JSON.stringify(response.body));
}
const reply = (item, fields = {}) => ({
  turnId: item.mentorTurn.id, baseRevision: item.mentorTurn.baseRevision,
  message: "A useful mentor answer.", focus: "chat", messages: [],
  continuation: { kind: "question", text: "Try another example?" }, ...fields,
});

test("accepted work and inflight identity survive restart; repeated next and commit are idempotent", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/api/message", { text: "Explain closures" });
  assert.equal(accepted.status, 202);
  const durable = (await f.saved()).mentorWork[0];
  assert.equal(durable.status, "pending");
  assert.equal(durable.item.message.id, accepted.body.messageId);
  await f.restart();
  const first = await f.next();
  assert.equal(first.mentorTurn.id, durable.turnId);
  assert.equal((await f.saved()).mentorWork[0].status, "inflight");
  const duplicateDelivery = await f.next();
  assert.deepEqual(duplicateDelivery, first);
  assert.equal((await f.saved()).mentorWork[0].attempts, 1);
  await f.restart();
  const replay = await f.next();
  assert.equal(replay.mentorTurn.id, first.mentorTurn.id);
  assert.ok(replay.mentorTurn.baseRevision > first.mentorTurn.baseRevision);
  assert.equal((await f.request("/api/mentor/turn", reply(first), true)).status, 409);
  const results = await Promise.all([f.request("/api/mentor/turn", reply(replay), true), f.request("/api/mentor/turn", reply(replay), true)]);
  assert.deepEqual(results.map((entry) => entry.status).sort(), [200, 201]);
  await f.restart();
  const repeated = await f.request("/api/mentor/turn", { turnId: replay.mentorTurn.id }, true);
  assert.equal(repeated.body.idempotent, true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.transcript.filter((entry) => entry.role === "assistant").length, 1);
  assert.deepEqual(snapshot.mentorRecovery, []);
});

test("restart replay is bounded, failed work can retry or dismiss, active work cannot", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Keep my question" });
  let first;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const item = await f.next();
    first ||= item;
    assert.equal((await f.snapshot()).mentorRecovery[0].attempts, attempt);
    assert.equal((await f.request("/api/mentor/recovery", { turnId: item.mentorTurn.id, action: "dismiss" })).status, 409);
    await f.restart();
  }
  assert.equal((await f.snapshot()).mentorRecovery[0].status, "failed");
  assert.equal((await f.request("/api/mentor/recovery", { turnId: first.mentorTurn.id, action: "retry" })).status, 202);
  const retry = await f.next();
  assert.equal(retry.mentorTurn.id, first.mentorTurn.id);
  assert.ok(retry.retryRequestedAt);
  assert.equal((await f.request("/api/mentor/turn", reply(first), true)).status, 409);
  assert.equal((await f.request("/api/mentor/event", { type: "RUN_ERROR", turnId: retry.mentorTurn.id, baseRevision: first.mentorTurn.baseRevision, message: "stale error" }, true)).status, 409);
  assert.equal((await f.request("/api/mentor/event", { type: "RUN_ERROR", turnId: retry.mentorTurn.id, message: "legacy stale error" }, true)).status, 409);
  assert.equal((await f.snapshot()).mentorRecovery[0].status, "inflight");
  await f.request("/api/mentor/event", { type: "RUN_ERROR", turnId: retry.mentorTurn.id, baseRevision: retry.mentorTurn.baseRevision, message: "provider secret trace" }, true);
  const failed = (await f.snapshot()).mentorRecovery[0];
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /secret|trace/);
  assert.equal((await f.request("/api/mentor/recovery", { turnId: retry.mentorTurn.id, action: "dismiss" })).status, 202);
  assert.equal((await f.request("/api/mentor/turn", reply(retry), true)).status, 409);
  await f.restart();
  assert.deepEqual((await f.snapshot()).mentorRecovery, []);
  assert.equal((await f.saved()).mentorWork[0].status, "dismissed");
});

test("SIGKILL after delivery replays durable work once without a graceful shutdown", async (t) => {
  const f = await fixture(t);
  await f.runtime.close();
  f.runtime = null;
  const moduleUrl = new URL("../skills/learn-anything/blocks/server/server.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createLearnAnythingServer } from ${JSON.stringify(moduleUrl)};
    const runtime = await createLearnAnythingServer(${JSON.stringify({ sessionDir: f.sessionDir, kitRoot, teachingLibraryDir: join(f.root, "patterns") })});
    console.log(JSON.stringify(await runtime.listen()));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const lines = createInterface({ input: child.stdout });
  const [address] = await once(lines, "line");
  f.address = JSON.parse(address);
  await f.request("/api/mentor/register", { mentorId: f.mentorId });
  await f.request("/api/message", { text: "Recover after an actual crash" });
  const first = await f.next();
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  lines.close();
  await f.restart();
  const replay = await f.next();
  assert.equal(replay.mentorTurn.id, first.mentorTurn.id);
  assert.equal((await f.request("/api/mentor/turn", reply(replay), true)).status, 201);
  assert.equal((await f.snapshot()).transcript.filter((entry) => entry.role === "assistant").length, 1);
});

test("run A, edit B, refresh, submit B is rejected until B runs with exact server evidence", async (t) => {
  const f = await fixture(t);
  const a = "console.log('A')", b = "console.log('B')";
  await codeActivity(f, a);
  const runA = await f.request("/api/run", { componentId: "code", code: a, codeHash: "forged" });
  assert.equal(runA.status, 200);
  assert.equal(runA.body.executedCode, a);
  assert.equal(runA.body.codeHash, createHash("sha256").update(a).digest("hex"));
  await f.request("/api/action", { action: "code_change", componentId: "code", code: b });
  await f.restart();
  const component = (await f.snapshot()).canvas.surfaces.exercise.components.code;
  assert.equal(component.value, b);
  assert.equal(component.lastResult.executedCode, a);
  assert.equal((await f.request("/api/action", { action: "submit_code", componentId: "code", code: b })).status, 409);
  const runB = await f.request("/api/run", { componentId: "code", code: b });
  assert.equal(runB.body.executedCode, b);
  assert.equal((await f.request("/api/action", { action: "submit_code", componentId: "code", code: b })).status, 202);
  await f.restart();
  const submitted = await f.next();
  assert.equal(submitted.code, b);
  assert.equal(submitted.result.stdout, "B\n");
  assert.equal(submitted.result.codeHash, runB.body.codeHash);
});

test("failed runner records carry exact code evidence too", async (t) => {
  const f = await fixture(t);
  await codeActivity(f, "bad runner", "unsupported-runner");
  const result = await f.request("/api/run", { componentId: "code", code: "bad runner" });
  assert.ok(result.status >= 400);
  assert.equal(result.body.executedCode, "bad runner");
  assert.equal(result.body.codeHash, createHash("sha256").update("bad runner").digest("hex"));
  assert.equal((await f.snapshot()).canvas.surfaces.exercise.components.code.lastResult.codeHash, result.body.codeHash);
});

test("concurrent learner edit retains draft and question; explicit retry uses fresh context", async (t) => {
  const f = await fixture(t);
  await codeActivity(f);
  await f.request("/api/message", { text: "Explain this code", source: "work", context: { componentId: "code" } });
  const first = await f.next();
  await f.request("/api/action", { action: "code_change", componentId: "code", code: "console.log('new draft')" });
  const staleReply = reply(first, { focus: "work", continuation });
  assert.equal((await f.request("/api/mentor/turn", staleReply, true)).status, 409);
  let snapshot = await f.snapshot();
  assert.equal(snapshot.canvas.surfaces.exercise.components.code.value, "console.log('new draft')");
  assert.equal(snapshot.mentorRecovery[0].status, "failed");
  assert.equal(snapshot.transcript.filter((entry) => entry.role === "assistant").length, 0);
  await f.request("/api/mentor/recovery", { turnId: first.mentorTurn.id, action: "retry" });
  const retry = await f.next();
  assert.equal(retry.canvasContext.surfaces.exercise.components.code.value, "console.log('new draft')");
  assert.equal((await f.request("/api/mentor/turn", staleReply, true)).status, 409);
  assert.equal((await f.request("/api/mentor/turn", reply(retry, { focus: "work", continuation }), true)).status, 201);
  snapshot = await f.snapshot();
  assert.equal(snapshot.canvas.surfaces.exercise.components.code.value, "console.log('new draft')");
  assert.deepEqual(snapshot.mentorRecovery, []);
});

test("localized prose accepts structural actions and rejects invalid target and type", async (t) => {
  const f = await fixture(t);
  await codeActivity(f);
  for (const text of ["Ejecuta el código y comprueba el resultado.", "Führe den Code aus und prüfe die Ausgabe.", "コードを実行して出力を確認してください。"] ) {
    const payload = { focus: "work", messages: [], continuation: { ...continuation, text } };
    assert.equal((await f.request("/api/a2ui", payload, true)).status, 202);
    await f.restart();
    assert.equal((await f.snapshot()).continuation.text, text);
    assert.deepEqual((await f.snapshot()).mentorRecovery, []);
    for (const patch of [{ targetComponentId: "missing" }, { targetComponentId: "root" }, { actionType: "answer" }, { actionType: "invented" }, { text: " " }]) {
      assert.equal((await f.request("/api/a2ui", { ...payload, continuation: { ...payload.continuation, ...patch } }, true)).status, 400);
    }
  }
});

test("milestone commits deduplicate; progress, journal, and notes reconstruct after restart", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "I can explain closures now" });
  const item = await f.next();
  const milestone = { title: "Closures", takeaway: "Functions retain lexical scope.", nextStep: "Compare two counters.", concepts: ["lexical scope"], misconceptions: ["Closure is not a copied value"] };
  assert.equal((await f.request("/api/mentor/turn", reply(item, { milestone: { title: "broken" } }), true)).status, 400);
  assert.equal((await f.snapshot()).progress.milestone, 0);
  assert.equal((await f.request("/api/mentor/turn", reply(item, { milestone }), true)).status, 201);
  assert.equal((await f.request("/api/mentor/turn", reply(item, { milestone }), true)).body.idempotent, true);
  let snapshot = await f.snapshot();
  assert.equal(snapshot.progress.milestone, 1);
  assert.equal(snapshot.progress.milestones.length, 1);
  assert.equal(snapshot.progress.nextStep, milestone.nextStep);
  assert.equal(snapshot.progress.milestones[0].turnId, item.mentorTurn.id);
  const journal = await readFile(join(f.sessionDir, "journal.md"), "utf8");
  const notes = await readFile(join(f.sessionDir, "notes.md"), "utf8");
  assert.match(journal, /Functions retain lexical scope/);
  assert.match(notes, /Closure is not a copied value/);
  await rm(join(f.sessionDir, "journal.md"));
  await writeFile(join(f.sessionDir, "notes.md"), "Personal note survives.\n");
  await f.restart();
  assert.equal(await readFile(join(f.sessionDir, "journal.md"), "utf8"), journal);
  assert.match(await readFile(join(f.sessionDir, "notes.md"), "utf8"), /Personal note survives/);
  assert.match(await readFile(join(f.sessionDir, "notes.md"), "utf8"), /lexical scope/);
  snapshot = await f.snapshot();
  assert.equal(snapshot.progress.milestone, 1);
  const controller = new AbortController();
  const stream = await fetch(`${f.address.url}/api/events?token=${f.address.accessToken}`, { signal: controller.signal });
  const frame = new TextDecoder().decode((await stream.body.getReader().read()).value);
  controller.abort();
  const event = JSON.parse(frame.split("\n")[0].slice(6));
  assert.deepEqual(event.snapshot.progress, snapshot.progress);
  assert.deepEqual(event.snapshot.mentorRecovery, []);
});

test("legacy unanswered questions migrate to bounded explicit recovery without automatic replay", async (t) => {
  const f = await fixture(t, async (prepared) => {
    const saved = await prepared.saved();
    saved.transcript = [{ id: "answer", role: "assistant", content: "Earlier answer" }, ...Array.from({ length: 25 }, (_, index) => ({ id: `question-${index}`, role: "user", content: `Question ${index}` }))];
    await writeFile(prepared.sessionPath, JSON.stringify(saved));
  });
  let snapshot = await f.snapshot();
  assert.equal(snapshot.mentorRecovery.length, 20);
  assert.ok(snapshot.mentorRecovery.every((entry) => entry.status === "failed"));
  await f.restart();
  snapshot = await f.snapshot();
  assert.equal(snapshot.mentorRecovery.length, 20);
  assert.equal(new Set(snapshot.mentorRecovery.map((entry) => entry.turnId)).size, 20);
});

test("new learner question takes priority over queued activity without losing recoverable feedback", async (t) => {
  const f = await fixture(t);
  await f.request("/api/action", { action: "lesson_check", componentId: "reading" });
  const activityId = (await f.snapshot()).mentorRecovery[0].turnId;
  await f.request("/api/message", { text: "A more important question" });
  const item = await f.next();
  assert.equal(item.type, "user_message");
  assert.equal(item.message.content, "A more important question");
  assert.equal((await f.snapshot()).mentorRecovery.find((entry) => entry.turnId === activityId).status, "failed");
  assert.ok((await f.saved()).mentorWork.find((entry) => entry.turnId === activityId).item);
});

test("explicit retry can answer an older question after a newer question was completed", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "First question" });
  const first = await f.next();
  await f.request("/api/message", { text: "Second question" });
  assert.equal((await f.request("/api/mentor/turn", reply(first), true)).status, 409);
  const second = await f.next();
  assert.equal((await f.request("/api/mentor/turn", reply(second), true)).status, 201);
  assert.equal((await f.request("/api/mentor/recovery", { turnId: first.mentorTurn.id, action: "retry" })).status, 202);
  const retry = await f.next();
  assert.equal(retry.message.content, "First question");
  assert.equal((await f.request("/api/mentor/turn", reply(retry), true)).status, 201);
  assert.deepEqual((await f.snapshot()).mentorRecovery, []);
});
