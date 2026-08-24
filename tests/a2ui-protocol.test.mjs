import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLearnAnythingServer } from "../skills/learn-anything/blocks/server/server.mjs";
import { constructSession, kitRoot } from "../skills/learn-anything/scripts/construct.mjs";

async function request(address, path, options = {}, mentorId = null) {
  const response = await fetch(`${address.url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": address.accessToken,
      ...(mentorId ? { "x-learn-anything-mentor": mentorId } : {}),
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "learn-anything-a2ui-"));
  const constructed = await constructSession({ topic: "Python protocols", root, profile: "portable-shell" });
  const runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0 });
  const address = await runtime.listen();
  return { root, constructed, runtime, address };
}

test("server persists real A2UI v0.9 surface messages", async () => {
  const { root, constructed, runtime, address } = await fixture();
  const mentorId = "a2ui-test-mentor";
  try {
    const mentorReady = runtime.waitForMentor(1_000);
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    await mentorReady;
    const next = request(address, `/api/mentor/next?mentorId=${mentorId}`);

    const messages = [
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "lesson",
          catalogId: "urn:learn-anything:catalog:v1",
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "lesson",
          components: [
            { id: "root", component: "Column", children: ["intro", "editor"] },
            { id: "intro", component: "Markdown", content: { path: "/intro" } },
            { id: "editor", component: "Code", language: "python", value: "print('ready')", runnable: true },
          ],
        },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "lesson",
          path: "/",
          value: { intro: "Build the protocol, not a stage-shaped imitation." },
        },
      },
    ];

    const updated = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({ focus: "work", messages }),
    }, mentorId);
    assert.equal(updated.response.status, 202);
    assert.equal(updated.body.surfaceId, "lesson");

    const sessionResponse = await request(address, "/api/session");
    assert.equal(sessionResponse.body.canvas.focus, "work");
    assert.equal(sessionResponse.body.canvas.activeSurfaceId, "lesson");
    assert.equal(sessionResponse.body.canvas.surfaces.lesson.components.editor.component, "Code");
    assert.equal(sessionResponse.body.canvas.surfaces.lesson.dataModel.intro, "Build the protocol, not a stage-shaped imitation.");

    const persisted = JSON.parse(await readFile(constructed.sessionPath, "utf8"));
    assert.equal(persisted.canvas.surfaces.lesson.components.root.component, "Column");
    assert.equal("stage" in persisted, false);

    await request(address, "/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "continue" }),
    });
    await next;
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("mentor readiness resolves only after provider-qualified handshake", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const mentorId = "ready-mentor";
    const ready = runtime.waitForMentor(1_000);
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    const resolvedBeforeReady = await Promise.race([
      ready.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 30)),
    ]);
    assert.equal(resolvedBeforeReady, false);
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    assert.equal(await ready, mentorId);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt delegates to the active adapter and clears mentor readiness", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const mentorId = "interrupt-mentor";
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    let interrupted = 0;
    runtime.setInterruptHandler(async () => {
      interrupted += 1;
      return true;
    });

    const response = await request(address, "/api/interrupt", { method: "POST", body: "{}" });
    assert.equal(response.response.status, 202);
    assert.equal(interrupted, 1);
    assert.equal((await request(address, "/api/session")).body.mentorAttached, false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed A2UI graphs are rejected without replacing the last good canvas", async () => {
  const { root, runtime, address } = await fixture();
  const mentorId = "graph-mentor";
  try {
    await request(address, "/api/mentor/register", {
      method: "POST",
      body: JSON.stringify({ mentorId, takeover: true }),
    });
    await request(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);
    const before = (await request(address, "/api/session")).body.canvas;
    const rejected = await request(address, "/api/a2ui", {
      method: "POST",
      body: JSON.stringify({
        focus: "work",
        messages: [
          {
            version: "v0.9",
            createSurface: { surfaceId: "cycle", catalogId: "urn:learn-anything:catalog:v1" },
          },
          {
            version: "v0.9",
            updateComponents: {
              surfaceId: "cycle",
              components: [{ id: "root", component: "Column", children: ["root"] }],
            },
          },
        ],
      }),
    }, mentorId);
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /cycle/i);
    assert.deepEqual((await request(address, "/api/session")).body.canvas, before);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
