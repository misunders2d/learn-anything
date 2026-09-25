import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import { createLearnAnythingServer, MAX_RUN_RESULT_KEYS } from "../skills/learn-anything/blocks/server/server.mjs";
import { reconcileMentorTurn, teachingPatternsPrompt } from "../skills/learn-anything/blocks/adapters/mentor-turn.mjs";

async function fixture(t, prepare) {
  const root = await mkdtemp(join(tmpdir(), "learn-validation-"));
  const f = { root, ...await constructSession({ topic: "Validation split", root, profile: "portable-shell" }) };
  f.saved = async () => JSON.parse(await readFile(f.sessionPath, "utf8"));
  f.request = async (path, body, mentor = false) => {
    const response = await fetch(`${f.address.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-learn-anything-token": f.address.accessToken,
        ...(mentor ? { "x-learn-anything-mentor": "mentor" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  f.snapshot = async () => (await f.request("/api/session")).body;
  f.next = async () => (await f.request("/api/mentor/next?mentorId=mentor")).body;
  f.restart = async () => {
    await f.runtime?.close();
    f.runtime = await createLearnAnythingServer({ sessionDir: f.sessionDir, kitRoot, teachingLibraryDir: join(root, "patterns") });
    f.address = await f.runtime.listen();
    await f.request("/api/mentor/register", { mentorId: "mentor", takeover: true });
  };
  t.after(async () => { await f.runtime?.close(); await rm(root, { recursive: true, force: true }); });
  if (prepare) await prepare(f);
  await f.restart();
  return f;
}

function reply(item, extra = {}) {
  return { turnId: item.mentorTurn.id, baseRevision: item.mentorTurn.baseRevision, attempt: item.mentorTurn.attempt,
    message: "A useful answer.", focus: "chat", messages: [],
    continuation: { kind: "question", text: "What did you observe?" }, ...extra };
}

function activity(count = 1, value = "console.log('ready')") {
  return { focus: "work", continuation: { kind: "action", text: "Run the code", taskTitle: "Run the example", targetComponentId: "code0", actionType: "run" },
    messages: [
      { version: "v0.9", createSurface: { surfaceId: "exercise", catalogId: "urn:learn-anything:catalog:v1" } },
      { version: "v0.9", updateComponents: { surfaceId: "exercise", components: [
        { id: "root", component: "Column", children: Array.from({ length: count }, (_, i) => `code${i}`) },
        ...Array.from({ length: count }, (_, i) => ({ id: `code${i}`, component: "Code", language: "javascript", runnable: true, value })),
      ] } },
    ] };
}

async function streamEvents(f, t) {
  const controller = new AbortController();
  const response = await fetch(`${f.address.url}/api/events?token=${f.address.accessToken}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const events = [];
  let buffer = "";
  const pumping = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += new TextDecoder().decode(chunk.value);
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  t.after(async () => { controller.abort(); await pumping; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return events;
}

// A question is recognised by a question mark in any script, not by English punctuation.
for (const text of ["Что изменилось?", "ما الذي تغيّر؟", "Τι άλλαξε\u037E", "何が変わりましたか？"]) {
  test(`native question accepted: ${text}`, async (t) => {
    const f = await fixture(t);
    await f.request("/api/message", { text: "Explain" });
    const item = await f.next();
    const result = await f.request("/api/mentor/turn", reply(item, { continuation: { kind: "question", text } }), true);
    assert.equal(result.status, 201);
    assert.equal((await f.snapshot()).continuation.text, text);
  });
}

test("a chat continuation with no question mark in any script is rejected for correction", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Explain" });
  const item = await f.next();
  const result = await f.request("/api/mentor/turn", reply(item, { continuation: { kind: "question", text: "Расскажи, что изменилось" } }), true);
  assert.equal(result.status, 422);
  assert.equal(result.body.validationError.code, "GENERIC_CONTINUATION");
});

test("hard rejection has no candidate side effects, delivers two corrections on the same fence, then fails", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Explain" });
  let item = await f.next();
  await f.request("/api/mentor/event", { type: "RUN_STARTED", turnId: item.mentorTurn.id, baseRevision: item.mentorTurn.baseRevision }, true);
  const before = await f.snapshot();
  const events = await streamEvents(f, t);
  const initialCount = events.length;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(item.mentorTurn.attempt, attempt);
    const bad = reply(item, { ...activity(), continuation: { kind: "action", text: "Inspect the missing panel", taskTitle: "Inspect", targetComponentId: "missing", actionType: "inspect" },
      milestone: { title: "Never published", takeaway: "Not committed", nextStep: "No write" } });
    const rejected = await f.request("/api/mentor/turn", bad, true);
    assert.equal(rejected.status, attempt < 3 ? 422 : 400);
    assert.equal(rejected.body.validationError.code, "INVALID_TARGET");
    assert.equal(rejected.body.validationError.path, "/continuation/targetComponentId");
    assert.equal(rejected.body.retryable, attempt < 3);
    const after = await f.snapshot();
    assert.deepEqual(after.canvas, before.canvas);
    assert.deepEqual(after.transcript, before.transcript);
    assert.deepEqual(after.progress, before.progress);
    assert.equal(after.mentorRevision, before.mentorRevision);
    assert.deepEqual((await f.request("/api/patterns")).body.patterns, []);
    assert.equal(after.mentorRecovery[0].status, attempt < 3 ? "inflight" : "failed");
    if (attempt < 3) {
      // Older adapters send RUN_ERROR after a rejected HTTP commit.
      await f.request("/api/mentor/event", { type: "RUN_ERROR", turnId: item.mentorTurn.id, baseRevision: item.mentorTurn.baseRevision }, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(events.length, initialCount, "rejected candidate must not broadcast");
      const next = await f.next();
      assert.equal(next.mentorTurn.id, item.mentorTurn.id);
      assert.equal(next.mentorTurn.baseRevision, item.mentorTurn.baseRevision);
      assert.match(teachingPatternsPrompt(next), /INVALID_TARGET/);
      item = next;
    }
  }
  assert.equal((await f.request("/api/mentor/turn", reply(item), true)).status, 409);
  const diagnostics = (await f.saved()).mentorDiagnostics.filter((entry) => entry.severity === "hard");
  assert.deepEqual(diagnostics.map((entry) => entry.attempt), [1, 2, 3]);
  assert.ok(diagnostics.every((entry) => entry.code === "INVALID_TARGET"));
  assert.equal(events.filter((event) => event.name === "mentor_turn").length, 0);
});

test("corrected candidate commits once and settled turn returns prior message and revision", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Explain" });
  const original = await f.next();
  assert.equal((await f.request("/api/mentor/turn", reply(original, { messages: [null] }), true)).status, 422);
  const corrected = await f.next();
  assert.equal(corrected.mentorTurn.attempt, 2);
  assert.equal((await f.request("/api/mentor/turn", reply(original), true)).status, 409);
  const accepted = await f.request("/api/mentor/turn", reply(corrected), true);
  assert.equal(accepted.status, 201);
  await f.restart();
  const duplicate = await f.request("/api/mentor/turn", { turnId: corrected.mentorTurn.id }, true);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.messageId, accepted.body.messageId);
  assert.equal(duplicate.body.revision, accepted.body.revision);
  assert.equal((await f.snapshot()).transcript.filter((entry) => entry.role === "assistant").length, 1);
});

test("pedagogy rules are enforced: generic, missing, and incompatible continuations are rejected", async (t) => {
  const f = await fixture(t);
  const generic = activity();
  generic.continuation = { ...generic.continuation, text: "Продолжай" };
  const genericResult = await f.request("/api/a2ui", generic, true);
  assert.equal(genericResult.status, 400);
  assert.match(genericResult.body.error, /concrete visible action/);

  const missing = activity();
  delete missing.continuation;
  assert.equal((await f.request("/api/a2ui", missing, true)).status, 400);

  const untitled = activity();
  delete untitled.continuation.taskTitle;
  assert.equal((await f.request("/api/a2ui", untitled, true)).status, 400);

  // A Code target cannot be "answered"; the catalog decides compatibility.
  const incompatible = activity();
  incompatible.continuation = { ...incompatible.continuation, text: "Answer the question in the editor", actionType: "answer" };
  const incompatibleResult = await f.request("/api/a2ui", incompatible, true);
  assert.equal(incompatibleResult.status, 400);
  assert.match(incompatibleResult.body.error, /incompatible with target component Code/);

  assert.equal((await f.request("/api/a2ui", activity(), true)).status, 202);
});

test("five saturated runs stay outside canvas and a subsequent mentor turn commits", async (t) => {
  const f = await fixture(t);
  const code = "process.stdout.write('x'.repeat(200000));\n//".padEnd(100_000, "p");
  assert.equal((await f.request("/api/a2ui", activity(5), true)).status, 202);
  const fullResults = {};
  const events = await streamEvents(f, t);
  for (let i = 0; i < 5; i += 1) {
    const result = await f.request("/api/run", { componentId: `code${i}`, code });
    assert.equal(result.status, 200);
    assert.equal(Buffer.byteLength(result.body.stdout), 200_000);
    fullResults[`exercise:code${i}`] = result.body;
  }
  const after = await f.snapshot();
  const legacyCanvas = structuredClone(after.canvas);
  for (let i = 0; i < 5; i += 1) legacyCanvas.surfaces.exercise.components[`code${i}`].lastResult = fullResults[`exercise:code${i}`];
  const beforeBytes = Buffer.byteLength(JSON.stringify(legacyCanvas));
  const afterBytes = Buffer.byteLength(JSON.stringify(after.canvas));
  t.diagnostic(`Five saturated runs: legacy hydrated canvas ${beforeBytes} bytes; separated canvas ${afterBytes} bytes.`);
  assert.ok(beforeBytes > 1_000_000);
  assert.ok(afterBytes < 1_000_000);
  assert.ok(!JSON.stringify(after.canvas).includes('"lastResult"'));
  assert.ok(Buffer.byteLength(after.runResults["exercise:code0"].stdout) < 8_000);
  assert.equal(after.runResults["exercise:code4"].stdout.length, 200_000);
  assert.equal(after.runResults["exercise:code0"].executedCode, code);
  assert.equal((await f.request("/api/action", { action: "submit_code", componentId: "code0", code })).status, 202);
  const item = await f.next();
  assert.equal((await f.request("/api/mentor/turn", reply(item, { focus: "work", continuation: activity().continuation }), true)).status, 201);
  assert.ok(events.some((event) => event.name === "run_results"));
  assert.ok(events.filter((event) => event.name === "a2ui").every((event) => !JSON.stringify(event.value).includes('"lastResult"')));
});

test("legacy embedded results migrate with bounded keys and retained execution evidence", async (t) => {
  const f = await fixture(t, async (f) => {
    const saved = await f.saved();
    const code = "console.log('legacy')";
    const result = { stdout: "x".repeat(200_000), stderr: "", executedCode: code, codeHash: createHash("sha256").update(code).digest("hex") };
    saved.canvas.surfaces.lesson.components.legacy = { id: "legacy", component: "Code", value: code, lastResult: result, executedCode: code, codeHash: result.codeHash };
    saved.canvas.surfaces.lesson.components.root.children.push("legacy");
    saved.runResults = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`lesson:old${i}`, result]));
    await writeFile(f.sessionPath, JSON.stringify(saved));
  });
  const snapshot = await f.snapshot();
  assert.equal(Object.keys(snapshot.runResults).length, MAX_RUN_RESULT_KEYS);
  assert.equal(snapshot.runResults["lesson:legacy"].stdout.length, 200_000);
  assert.equal(snapshot.runResults["lesson:legacy"].executedCode, "console.log('legacy')");
  assert.equal(snapshot.canvas.surfaces.lesson.components.legacy.lastResult, undefined);
  assert.equal(snapshot.canvas.surfaces.lesson.components.legacy.executedCode, undefined);
  assert.equal(snapshot.canvas.surfaces.lesson.components.legacy.codeHash, undefined);
  assert.ok(Buffer.byteLength(snapshot.runResults["lesson:old39"].stdout) < 8_000);
  await f.restart();
  assert.deepEqual((await f.snapshot()).runResults, snapshot.runResults);
});

test("restart preserves correction budget and explicit recovery resets it", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Keep trying" });
  let item = await f.next();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(item.mentorTurn.attempt, attempt);
    const response = await f.request("/api/mentor/turn", reply(item, { messages: [null] }), true);
    assert.equal(response.body.retryable, attempt < 3);
    if (attempt < 3) {
      const old = item;
      await f.restart();
      item = await f.next();
      assert.equal(item.mentorTurn.id, old.mentorTurn.id);
      assert.ok(item.mentorTurn.baseRevision > old.mentorTurn.baseRevision);
      assert.equal(item.validationError.path, "/messages");
    }
  }
  assert.equal((await f.snapshot()).mentorRecovery[0].status, "failed");
  await f.request("/api/mentor/recovery", { turnId: item.mentorTurn.id, action: "retry" });
  const explicit = await f.next();
  assert.equal(explicit.mentorTurn.attempt, 1);
  assert.equal(explicit.validationError, undefined);
  assert.equal((await f.request("/api/mentor/turn", reply(explicit), true)).status, 201);
});

test("correction retries preserve one logical AG-UI run boundary", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Explain" });
  const item = await f.next();
  const events = await streamEvents(f, t);
  const start = (current, runId) => f.request("/api/mentor/event", {
    type: "RUN_STARTED", turnId: current.mentorTurn.id, baseRevision: current.mentorTurn.baseRevision, runId,
  }, true);
  await start(item, "logical-run");
  await f.request("/api/mentor/turn", reply(item, { messages: [null], runId: "logical-run" }), true);
  const corrected = await f.next();
  await start(corrected, "provider-correction-run");
  assert.equal((await f.request("/api/mentor/turn", reply(corrected, { runId: "provider-correction-run" }), true)).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events.filter((event) => event.type === "RUN_STARTED").map((event) => event.runId), ["logical-run"]);
  assert.deepEqual(events.filter((event) => event.type === "RUN_FINISHED").map((event) => event.runId), ["logical-run"]);
});

test("malformed and stale envelopes keep hard HTTP codes; oversized candidates retain 413 with correction metadata", async (t) => {
  const f = await fixture(t);
  await f.request("/api/message", { text: "Explain" });
  const item = await f.next();
  const before = await f.snapshot();
  assert.equal((await f.request("/api/mentor/turn", null, true)).status, 400);
  assert.equal((await f.request("/api/mentor/turn", {}, true)).status, 400);
  assert.equal((await f.request("/api/mentor/turn", { ...reply(item), baseRevision: -1 }, true)).status, 409);
  assert.equal((await f.next()).mentorTurn.attempt, 1);
  const tooLarge = await f.request("/api/mentor/turn", reply(item, { message: "x".repeat(100_001) }), true);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.retryable, true);
  assert.equal(tooLarge.body.validationError.code, "PAYLOAD_SIZE");
  assert.equal(tooLarge.body.validationError.path, "/message");
  assert.deepEqual((await f.snapshot()).transcript, before.transcript);
  assert.deepEqual((await f.snapshot()).canvas, before.canvas);
  const corrected = await f.next();
  assert.equal(corrected.mentorTurn.attempt, 2);
  assert.equal((await f.request("/api/mentor/turn", reply(corrected), true)).status, 201);
});

test("a compatible action type still cannot enable host interactions a component does not support", async (t) => {
  const f = await fixture(t);
  const value = activity();
  value.messages[1].updateComponents.components[1].runnable = false;
  // "run" is compatible with Code, but a non-runnable excerpt still refuses execution.
  assert.equal((await f.request("/api/a2ui", value, true)).status, 202);
  const before = await f.snapshot();
  for (const componentId of ["missing", "root", "code0"]) {
    assert.equal((await f.request("/api/run", { componentId, language: "javascript", code: "console.log('no')" })).status, 400);
    assert.equal((await f.request("/api/action", { action: "quiz_answer", componentId, optionId: "a" })).status, 400);
  }
  assert.equal((await f.request("/api/action", { action: "submit_code", componentId: "code0", code: "console.log('no')" })).status, 400);
  const after = await f.snapshot();
  assert.deepEqual(after.canvas, before.canvas);
  assert.deepEqual(after.mentorRecovery, before.mentorRecovery);
  assert.deepEqual(after.runResults, before.runResults);
});

test("adapter keeps a native question mark instead of appending an ASCII one", () => {
  const item = { type: "user_message", message: { text: "Explain" }, mentorTurn: { id: "turn", baseRevision: 1, attempt: 1 } };
  for (const text of ["Что изменилось?", "ما الذي تغيّر؟", "Τι άλλαξε\u037E", "何が変わりましたか？"]) {
    const value = reconcileMentorTurn(item, { message: "An answer", presentation: "chat", continuation: { kind: "question", text } }, { canvas: {} });
    assert.equal(value.continuation.text, text);
    assert.equal(value.attempt, 1);
    assert.equal("interactionModel" in value, false);
  }
  const bare = reconcileMentorTurn(item, { message: "An answer", presentation: "chat", continuation: { kind: "question", text: "Tell me what changed." } }, { canvas: {} });
  assert.equal(bare.continuation.text, "Tell me what changed?");
});
