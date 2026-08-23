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
    const next = request(address, `/api/mentor/next?mentorId=${mentorId}&takeover=1`);
    await mentorReady;

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

test("mentor readiness resolves only after an adapter claims the lease", async () => {
  const { root, runtime, address } = await fixture();
  try {
    const ready = runtime.waitForMentor(1_000);
    const next = request(address, "/api/mentor/next?mentorId=ready-mentor&takeover=1");
    assert.equal(await ready, "ready-mentor");
    await request(address, "/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "wake" }),
    });
    await next;
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
