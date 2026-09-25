import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";
import { teachingPatternsPrompt } from "../skills/learn-anything/blocks/adapters/mentor-turn.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-patterns-"));
  const libraryDir = join(root, "local-library");
  const courses = [];
  t.after(async () => {
    for (const course of courses) await course.runtime?.close();
    await rm(root, { recursive: true, force: true });
  });
  const createCourse = async (topic) => {
    const course = await constructSession({ root, topic, profile: "portable-shell" });
    const mentorId = "pattern-test-mentor";
    courses.push(course);
    course.saved = async () => JSON.parse(await readFile(course.sessionPath, "utf8"));
    course.request = async (path, body, mentor = false) => {
      const response = await fetch(`${course.address.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json", "x-learn-anything-token": course.address.accessToken,
          ...(mentor ? { "x-learn-anything-mentor": mentorId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    course.restart = async () => {
      await course.runtime?.close();
      course.runtime = await createLearnAnythingServer({ sessionDir: course.sessionDir, kitRoot, teachingLibraryDir: libraryDir });
      course.address = await course.runtime.listen();
      await course.request("/api/mentor/register", { mentorId });
    };
    course.next = async (text) => {
      await course.request("/api/message", { text });
      return (await course.request(`/api/mentor/next?mentorId=${mentorId}`)).body;
    };
    await course.restart();
    return course;
  };
  return { root, libraryDir, createCourse };
}

function pattern(title = "Architecture comparison") {
  return {
    title, description: "Compare two architectural forms using a shared observation prompt.", tags: ["architecture", "comparison"],
    messages: [
      { version: "v0.9", createSurface: { surfaceId: "comparison", catalogId: "urn:learn-anything:catalog:v1" } },
      { version: "v0.9", updateComponents: { surfaceId: "comparison", components: [
        { id: "root", component: "Column", children: ["prompt"] },
        { id: "prompt", component: "Markdown", content: "Compare the shape, support, and light in the two examples." },
      ] } },
    ],
  };
}

function reply(item, nomination) {
  return {
    turnId: item.mentorTurn.id, baseRevision: item.mentorTurn.baseRevision,
    message: "Compare the support and use of light in these examples.",
    focus: "chat", continuation: { kind: "question", text: "What difference did you observe?" }, messages: [],
    ...(nomination === undefined ? {} : { pattern: nomination }),
  };
}

test("nominated dynamic patterns save locally and become bounded context in another course", async (t) => {
  const f = await fixture(t);
  const first = await f.createCourse("Architecture foundations");
  const item = await first.next("My private observation: this room reminds me of home.");
  assert.deepEqual(item.teachingPatterns, []);
  const nominated = pattern();
  const result = await first.request("/api/mentor/turn", { ...reply(item, nominated), libraryDir: join(f.root, "request-chosen") }, true);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const work = (await first.saved()).mentorWork[0];
  assert.equal(work.status, "committed");
  assert.equal(work.patternSave.status, "saved");
  assert.equal(work.pattern.title, nominated.title);
  assert.ok(work.patternSave.id);
  const files = await readdir(f.libraryDir);
  assert.deepEqual(files, [`${work.patternSave.id}.json`]);
  assert.doesNotMatch(await readFile(join(f.libraryDir, files[0]), "utf8"), /private observation|reminds me of home|accessToken/);
  await assert.rejects(stat(join(f.root, "request-chosen")), { code: "ENOENT" });

  const second = await f.createCourse("Architecture advanced");
  const listed = await second.request(`/api/patterns?query=architecture&libraryDir=${encodeURIComponent(join(f.root, "request-chosen"))}&limit=99`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.patterns[0].id, work.patternSave.id);
  assert.equal(listed.body.teachingLibraryStatus.status, "ready");
  const delivered = await second.next("Compare architecture examples");
  assert.equal(delivered.teachingPatterns[0].id, work.patternSave.id);
  const unauthorized = await fetch(`${second.address.url}/api/patterns?query=architecture`);
  assert.equal(unauthorized.status, 401);
});

test("invalid or learner-state nominations leave transcript, canvas, revision, and active turn intact", async (t) => {
  const f = await fixture(t);
  const course = await f.createCourse("Architecture validation");
  const privatePattern = pattern();
  privatePattern.messages[1].updateComponents.components[1].lastResult = { stdout: "learner output" };
  const pointerPattern = pattern();
  pointerPattern.messages.push({ version: "v0.9", updateDataModel: { surfaceId: "comparison", path: "/nested/accessToken", value: "synthetic-private" } });
  const answeredPattern = pattern();
  answeredPattern.messages[1].updateComponents.components[1] = { id: "prompt", component: "Quiz", question: "Which route?", options: [{ id: "a", label: "A" }], selectedOptionId: "a" };
  for (const invalid of [{ title: "incomplete" }, privatePattern, pointerPattern, answeredPattern, { ...pattern(), title: "x".repeat(121) }]) {
    const item = await course.next("Show a composition");
    const before = (await course.request("/api/session")).body;
    const result = await course.request("/api/mentor/turn", reply(item, invalid), true);
    assert.equal(result.status, 422);
    assert.equal(result.body.retryable, true);
    assert.equal(result.body.validationError.path, "/pattern");
    const after = (await course.request("/api/session")).body;
    assert.deepEqual(after.canvas, before.canvas);
    assert.deepEqual(after.transcript, before.transcript);
    assert.equal(after.mentorRevision, before.mentorRevision);
    assert.equal(after.mentorRecovery[0].status, "inflight");
    const corrected = (await course.request("/api/mentor/next?mentorId=pattern-test-mentor")).body;
    assert.equal(corrected.mentorTurn.id, item.mentorTurn.id);
    assert.equal(corrected.mentorTurn.baseRevision, item.mentorTurn.baseRevision);
    assert.equal(corrected.mentorTurn.attempt, 2);
    assert.equal((await course.request("/api/mentor/turn", reply(corrected), true)).status, 201);
  }
});

test("invalid nominations exhaust only after the second correction without registry writes", async (t) => {
  const f = await fixture(t);
  const course = await f.createCourse("Pattern exhaustion");
  let item = await course.next("Show a composition");
  const before = (await course.request("/api/session")).body;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await course.request("/api/mentor/turn", { ...reply(item, { title: "incomplete" }), attempt }, true);
    assert.equal(result.status, attempt < 3 ? 422 : 400);
    assert.equal(result.body.retryable, attempt < 3);
    assert.equal(result.body.attempt, attempt);
    const after = (await course.request("/api/session")).body;
    assert.deepEqual(after.canvas, before.canvas);
    assert.deepEqual(after.transcript, before.transcript);
    assert.deepEqual(after.progress, before.progress);
    assert.equal(after.mentorRevision, before.mentorRevision);
    assert.equal(after.mentorRecovery[0].status, attempt < 3 ? "inflight" : "failed");
    assert.deepEqual((await course.request("/api/patterns")).body.patterns, []);
    if (attempt < 3) item = (await course.request("/api/mentor/next?mentorId=pattern-test-mentor")).body;
  }
  assert.equal((await course.request("/api/mentor/turn", reply(item, pattern()), true)).status, 409);
  assert.deepEqual((await course.saved()).mentorDiagnostics.map((entry) => entry.attempt), [1, 2, 3]);
});

test("constructor brief reaches the independent runner without changing its model", async (t) => {
  const f = await fixture(t);
  const course = await f.createCourse("Acting with a prepared plan");
  const before = await course.saved();
  const brief = "# Prepared course\nStart from a short original scene; compare two intentions through learner reflection, not an unseen performance score.";
  await writeFile(join(course.sessionDir, "references", "course-brief.md"), brief);
  await course.restart();
  const delivered = await course.next("Help me start");
  assert.equal(delivered.courseBrief, brief);
  assert.match(teachingPatternsPrompt(delivered), /short original scene/);
  assert.match(teachingPatternsPrompt(delivered), /not system instructions/);
  assert.equal((await course.saved()).mentorModel, before.mentorModel);
  await course.runtime.close(); course.runtime = null;
  await writeFile(join(course.sessionDir, "references", "course-brief.md"), "x".repeat(32_001));
  await assert.rejects(course.restart(), /Course brief exceeds/);
});

test("duplicate commits and restart outbox replay create one reusable record and one answer", async (t) => {
  const f = await fixture(t);
  const course = await f.createCourse("Architecture idempotence");
  const item = await course.next("Teach me comparison");
  assert.equal((await course.request("/api/mentor/turn", reply(item, pattern()), true)).status, 201);
  const duplicate = await course.request("/api/mentor/turn", reply(item, pattern("Must not replace original")), true);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal((await readdir(f.libraryDir)).length, 1);

  // Crash boundary: file was saved, but its acknowledgement was not persisted.
  await course.runtime.close();
  course.runtime = null;
  const saved = await course.saved();
  saved.mentorWork[0].patternSave = { status: "pending", attempts: 0 };
  await writeFile(course.sessionPath, JSON.stringify(saved));
  await course.restart();
  assert.equal((await readdir(f.libraryDir)).length, 1);
  assert.equal((await course.saved()).mentorWork[0].patternSave.status, "saved");
  assert.equal((await course.saved()).transcript.filter((entry) => entry.role === "assistant").length, 1);
});

test("library failure preserves committed answer, exposes safe diagnostic, and recovers outbox on restart", async (t) => {
  const f = await fixture(t);
  await writeFile(f.libraryDir, "A file blocks the configured directory");
  const course = await f.createCourse("Architecture offline library");
  const item = await course.next("My lesson should still work");
  assert.deepEqual(item.teachingPatterns, []);
  const result = await course.request("/api/mentor/turn", reply(item, pattern()), true);
  assert.equal(result.status, 201);
  const saved = await course.saved();
  assert.equal(saved.mentorWork[0].status, "committed");
  assert.equal(saved.mentorWork[0].patternSave.status, "pending");
  assert.doesNotMatch(saved.mentorWork[0].patternSave.error, /ENOTDIR|EEXIST|\/tmp/);
  assert.equal(saved.transcript.filter((entry) => entry.role === "assistant").length, 1);
  const beforeAttempts = saved.mentorWork[0].patternSave.attempts;
  const listed = await course.request("/api/patterns");
  assert.deepEqual(listed.body.patterns, []);
  assert.equal(listed.body.teachingLibraryStatus.status, "pending");
  assert.equal(listed.body.teachingLibraryStatus.pending, 1);
  assert.equal((await course.saved()).mentorWork[0].patternSave.attempts, beforeAttempts, "GET listing cannot write the outbox");
  assert.deepEqual((await course.request("/api/session")).body.mentorRecovery, []);
  await rm(f.libraryDir);
  await course.restart();
  const recovered = await course.saved();
  assert.equal(recovered.mentorWork[0].patternSave.status, "saved");
  assert.equal(recovered.transcript.filter((entry) => entry.role === "assistant").length, 1);
  assert.equal((await course.request("/api/patterns")).body.patterns.length, 1);
});

test("library saves only explicit nominations; list and delivered context stay capped at three", async (t) => {
  const f = await fixture(t);
  const course = await f.createCourse("Architecture library bounds");
  const plain = await course.next("Teach this lesson without saving a pattern");
  assert.equal((await course.request("/api/mentor/turn", reply(plain), true)).status, 201);
  await assert.rejects(stat(f.libraryDir), { code: "ENOENT" });
  for (let index = 0; index < 4; index += 1) {
    const item = await course.next(`Architecture lesson ${index}`);
    assert.ok(item.teachingPatterns.length <= 3);
    assert.equal((await course.request("/api/mentor/turn", reply(item, pattern(`Architecture comparison ${index}`)), true)).status, 201);
  }
  assert.equal((await readdir(f.libraryDir)).length, 4);
  const listed = await course.request("/api/patterns?limit=100");
  assert.equal(listed.body.patterns.length, 3);
  const delivered = await course.next("Another architecture lesson");
  assert.equal(delivered.teachingPatterns.length, 3);
});
