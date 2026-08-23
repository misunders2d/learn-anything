import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLearnAnythingServer } from "../blocks/server/server.mjs";
import { updateValidation } from "./construct.mjs";
import { canvasEventValue, canvasFromStage } from "../blocks/a2ui/state.mjs";

async function jsonFetch(url, options = {}, { token, mentorId } = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-learn-anything-token": token } : {}),
      ...(mentorId ? { "x-learn-anything-mentor": mentorId } : {}),
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
}

export async function smokeSession(sessionDir, { kitRoot } = {}) {
  const sourceSession = resolve(sessionDir);
  const temp = await mkdtemp(join(tmpdir(), "learn-anything-smoke-"));
  const isolatedSession = join(temp, "session");
  const realWriteProbe = join(sourceSession, "exercises", `.smoke-write-${process.pid}`);
  await mkdir(join(isolatedSession, "exercises"), { recursive: true });
  await cp(join(sourceSession, "session.json"), join(isolatedSession, "session.json"));
  const runtime = await createLearnAnythingServer({ sessionDir: isolatedSession, kitRoot, port: 0 });
  let address;

  try {
    await writeFile(realWriteProbe, "workspace-write-ok\n", "utf8");
    if ((await readFile(realWriteProbe, "utf8")) !== "workspace-write-ok\n") throw new Error("Real learning directory write check failed.");
    await rm(realWriteProbe);

    address = await runtime.listen();
    const auth = { token: address.accessToken };
    const mentorId = "smoke-mentor";
    const mentorAuth = { ...auth, mentorId };
    const health = await jsonFetch(`${address.url}/healthz`);
    if (!health.body.ok) throw new Error("Health check did not return ok=true.");

    const page = await fetch(`${address.url}/`);
    const pageText = await page.text();
    if (!page.ok || !pageText.includes("id=\"root\"")) throw new Error("Browser index asset failed smoke check.");
    if (!pageText.includes("id=\"mentor-rescue\"") || !pageText.includes("learn-anything:rescue-chat")) {
      throw new Error("Browser-owned mentor rescue path is missing.");
    }
    if (page.headers.get("cache-control") !== "no-store") throw new Error("Browser index must not be cached.");
    if (pageText.includes("/vendor/monaco/vs/loader.js")) throw new Error("Monaco AMD loader must not run before the module application.");
    const app = await fetch(`${address.url}/app.js`);
    const appText = await app.text();
    if (!app.ok || !appText.length) throw new Error("Browser application asset failed smoke check.");
    if (app.headers.get("cache-control") !== "no-store") throw new Error("Unversioned browser application must not be cached.");
    if (!appText.includes("code-fallback")) throw new Error("Browser application does not include a usable code editor.");

    const unauthenticated = await fetch(`${address.url}/api/session`);
    if (unauthenticated.status !== 401) throw new Error("API accepted a request without workspace token.");
    const crossOrigin = await fetch(`${address.url}/api/run`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.invalid" },
      body: JSON.stringify({ language: "javascript", code: "console.log('unsafe')" }),
    });
    if (crossOrigin.status !== 403) throw new Error("API accepted a cross-origin execution request.");
    const wrongContentType = await fetch(`${address.url}/api/run`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-learn-anything-token": address.accessToken },
      body: JSON.stringify({ language: "javascript", code: "console.log('unsafe')" }),
    });
    if (wrongContentType.status !== 415) throw new Error("API accepted a non-JSON execution request.");

    const userText = "smoke-message";
    await jsonFetch(`${address.url}/api/message`, {
      method: "POST",
      headers: { origin: address.url },
      body: JSON.stringify({ text: userText }),
    }, auth);
    const mentorQuery = new URLSearchParams({ token: address.accessToken, mentorId, takeover: "1" });
    const queued = await jsonFetch(`${address.url}/api/mentor/next?${mentorQuery}`);
    if (queued.body?.message?.content !== userText) throw new Error("Mentor queue round trip failed.");
    const competingMentor = new URLSearchParams({ token: address.accessToken, mentorId: "other-mentor" });
    const competingResponse = await fetch(`${address.url}/api/mentor/next?${competingMentor}`);
    if (competingResponse.status !== 409) throw new Error("Competing mentor was not rejected.");

    for (const [path, body] of [
      ["/api/a2ui", { focus: "work", messages: [null] }],
      ["/api/mentor/event", { type: "CUSTOM", name: "a2ui", value: { focus: "work", messages: [null] } }],
    ]) {
      const malformed = await fetch(`${address.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-learn-anything-token": address.accessToken,
          "x-learn-anything-mentor": mentorId,
        },
        body: JSON.stringify(body),
      });
      if (malformed.status !== 400) throw new Error(`${path} accepted malformed A2UI.`);
    }

    const messageId = "smoke-assistant";
    for (const event of [
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "smoke-reply" },
      { type: "TEXT_MESSAGE_END", messageId },
    ]) {
      await jsonFetch(`${address.url}/api/mentor/event`, { method: "POST", body: JSON.stringify(event) }, mentorAuth);
    }

    const stage = {
      version: "learn-anything/v1",
      surfaceId: "smoke",
      focus: "work",
      title: "Smoke stage",
      components: [
        { id: "smoke-copy", type: "markdown", content: "smoke-stage" },
        { id: "smoke-quiz", type: "quiz", question: "Ready?", options: [{ id: "yes", label: "Yes" }] },
        { id: "smoke-list", type: "checklist", items: [{ id: "first", label: "First", done: false }] },
        { id: "smoke-code", type: "code", language: "javascript", value: "", runnable: true },
        { id: "smoke-draft", type: "code", language: "javascript", value: "", runnable: false },
      ],
    };
    await jsonFetch(`${address.url}/api/a2ui`, { method: "POST", body: JSON.stringify(canvasEventValue(canvasFromStage(stage, stage.title))) }, mentorAuth);

    await jsonFetch(`${address.url}/api/action`, {
      method: "POST",
      body: JSON.stringify({ action: "checklist_toggle", componentId: "smoke-list", itemId: "first", done: true }),
    }, auth);
    await jsonFetch(`${address.url}/api/action`, {
      method: "POST",
      body: JSON.stringify({ action: "code_change", componentId: "smoke-draft", code: "const unsaved = true;" }),
    }, auth);

    const execution = await jsonFetch(`${address.url}/api/run`, {
      method: "POST",
      body: JSON.stringify({ componentId: "smoke-code", language: "javascript", code: "console.log('smoke-exec')" }),
    }, auth);
    if (execution.body.exitCode !== 0 || !execution.body.stdout.includes("smoke-exec")) {
      throw new Error("JavaScript execution runner failed.");
    }
    const [parallelOne, parallelTwo] = await Promise.all([
      jsonFetch(`${address.url}/api/run`, {
        method: "POST",
        body: JSON.stringify({ language: "javascript", code: "await new Promise((resolve) => setTimeout(resolve, 40)); console.log('parallel-one')" }),
      }, auth),
      jsonFetch(`${address.url}/api/run`, {
        method: "POST",
        body: JSON.stringify({ language: "javascript", code: "console.log('parallel-two')" }),
      }, auth),
    ]);
    if (!parallelOne.body.stdout.includes("parallel-one") || !parallelTwo.body.stdout.includes("parallel-two")) {
      throw new Error("Concurrent execution isolation failed.");
    }

    const persisted = JSON.parse(await readFile(join(isolatedSession, "session.json"), "utf8"));
    if (!persisted.transcript.some((message) => message.content === "smoke-reply")) throw new Error("Mentor reply did not persist.");
    const smokeSurface = persisted.canvas?.surfaces?.smoke;
    if (!smokeSurface) throw new Error("A2UI canvas did not persist.");
    if (persisted.canvas?.focus !== "work") throw new Error("Flow-driven workspace focus did not persist.");
    if (!smokeSurface.components["smoke-list"].items[0].done) throw new Error("Canvas action did not persist.");
    if (!smokeSurface.components["smoke-code"].value.includes("smoke-exec")) throw new Error("Editor state did not persist.");
    if (!smokeSurface.components["smoke-draft"].value.includes("unsaved")) throw new Error("Unexecuted editor state did not persist.");
    const runDirectories = (await readdir(join(isolatedSession, "exercises"))).filter((name) => name.startsWith("run-"));
    if (runDirectories.length !== 3) throw new Error("Executions did not use isolated run directories.");

    const nextQuery = new URLSearchParams({ token: address.accessToken, mentorId });
    const stageAction = await jsonFetch(`${address.url}/api/mentor/next?${nextQuery}`);
    const executionFeedback = await jsonFetch(`${address.url}/api/mentor/next?${nextQuery}`);
    if (stageAction.body?.type !== "stage_action") throw new Error("Stage action did not reach mentor.");
    if (executionFeedback.body?.type !== "execution_result" || !executionFeedback.body.result.stdout.includes("smoke-exec")) {
      throw new Error("Execution feedback did not reach mentor.");
    }

    await jsonFetch(`${address.url}/api/action`, {
      method: "POST",
      body: JSON.stringify({ action: "quiz_answer", componentId: "smoke-quiz", optionId: "yes" }),
    }, auth);
    await jsonFetch(`${address.url}/api/run`, {
      method: "POST",
      body: JSON.stringify({ componentId: "smoke-code", language: "javascript", code: "console.log('stale-feedback')" }),
    }, auth);
    const priorityText = "new learner topic";
    await jsonFetch(`${address.url}/api/message`, {
      method: "POST",
      headers: { origin: address.url },
      body: JSON.stringify({ text: priorityText }),
    }, auth);
    const priorityItem = await jsonFetch(`${address.url}/api/mentor/next?${nextQuery}`);
    if (priorityItem.body?.type !== "user_message" || priorityItem.body.message?.content !== priorityText) {
      throw new Error("Latest learner message did not supersede queued automatic feedback.");
    }

    const validation = {
      status: "passed",
      checkedAt: new Date().toISOString(),
      scope: "isolated-protocol-and-execution-plus-real-workspace-write",
      checks: ["health", "browser-assets", "browser-rescue", "code-editor", "api-auth", "origin-defense", "content-type-defense", "mentor-lease", "malformed-a2ui-rejection", "message-queue", "learner-message-priority", "mentor-events", "a2ui-canvas", "agent-driven-focus", "adaptive-actions", "editor-persistence", "execution-feedback", "isolated-run-directory", "serialized-execution", "real-workspace-write", "persistence", "javascript-runner"],
    };
    await updateValidation(sourceSession, validation);
    return { ok: true, url: address.url, validation };
  } finally {
    if (address) await runtime.close();
    await rm(realWriteProbe, { force: true });
    await rm(temp, { recursive: true, force: true });
  }
}
