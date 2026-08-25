import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runSelectedCode, selectedRunners } from "../execution/runner.mjs";
import {
  A2UI_VERSION,
  activeSurface,
  applyA2uiMessages,
  applyParameterFrame,
  canvasEventValue,
  surfaceComponents,
} from "../a2ui/state.mjs";

const serverDir = dirname(fileURLToPath(import.meta.url));
const defaultKitRoot = resolve(serverDir, "../..");
const MAX_BODY = 1_000_000;
const MAX_PENDING_RUNS = 8;
const STALE_MENTOR = Symbol("stale-mentor");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large."), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function readSession(sessionPath) {
  return JSON.parse(await readFile(sessionPath, "utf8"));
}

async function atomicSession(sessionPath, session) {
  session.updatedAt = new Date().toISOString();
  const temp = `${sessionPath}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temp, sessionPath);
}

function agEvent(type, fields = {}) {
  return { type, timestamp: Date.now(), ...fields };
}

function canvasComponent(canvas, componentId) {
  if (!componentId) return null;
  return surfaceComponents(canvas).find((item) => item?.id === componentId) || null;
}

function updateCanvasFromAction(canvas, action) {
  const component = canvasComponent(canvas, action.componentId);
  if (!component) return null;
  if (action.action === "quiz_answer" && component.component === "Quiz") {
    component.selectedOptionId = action.optionId;
    return component;
  }
  if (action.action === "checklist_toggle" && component.component === "Checklist" && Array.isArray(component.items)) {
    const item = component.items.find((candidate) => candidate.id === action.itemId);
    if (!item) return null;
    item.done = Boolean(action.done);
    return component;
  }
  if (action.action === "code_change" && component.component === "Code" && typeof action.code === "string") {
    if (Buffer.byteLength(action.code) > 100_000) throw httpError("Code must be no larger than 100 KB.", 413);
    component.value = action.code;
    return component;
  }
  if (action.action === "parameter_change" && component.component === "Params" && Array.isArray(component.controls)) {
    const next = applyParameterFrame(canvas, action.componentId, action.controlId, action.value);
    if (!next) return null;
    Object.assign(canvas, next);
    return canvasComponent(canvas, action.componentId);
  }
  return null;
}

function updateEditorValue(canvas, componentId, code) {
  const component = canvasComponent(canvas, componentId);
  if (!component || component.component !== "Code") return null;
  component.value = code;
  return component;
}

function runnableComponent(canvas, componentId) {
  const component = canvasComponent(canvas, componentId);
  return component?.component === "Code" ? component : null;
}

function runResultKey(canvas, componentId) {
  return activeSurface(canvas)?.id && componentId ? `${activeSurface(canvas).id}:${componentId}` : null;
}

function hydrateRunResults(canvas, results = {}) {
  const surface = activeSurface(canvas);
  if (!surface) return canvas;
  for (const component of Object.values(surface.components || {})) {
    const key = runResultKey(canvas, component?.id);
    if (key && results[key]) component.lastResult = results[key];
  }
  return canvas;
}

function componentDelta(canvas, component) {
  const surface = activeSurface(canvas);
  return {
    focus: canvas.focus,
    activeSurfaceId: canvas.activeSurfaceId,
    messages: [{
      version: A2UI_VERSION,
      updateComponents: { surfaceId: surface.id, components: [component] },
    }],
  };
}


function hydratedMessages(canvas, messages) {
  return messages.map((message) => {
    if (!message?.updateComponents) return message;
    const surface = canvas.surfaces?.[message.updateComponents.surfaceId];
    if (!surface) return message;
    return {
      ...message,
      updateComponents: {
        ...message.updateComponents,
        components: message.updateComponents.components.map((component) => surface.components?.[component.id] || component),
      },
    };
  });
}
export async function createLearnAnythingServer({
  sessionDir,
  kitRoot = defaultKitRoot,
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (!sessionDir) throw new Error("sessionDir is required.");
  const resolvedSessionDir = resolve(sessionDir);
  const sessionPath = join(resolvedSessionDir, "session.json");
  const exercisesDir = join(resolvedSessionDir, "exercises");
  const webRoot = resolve(kitRoot, "blocks/web/dist");
  let session = await readSession(sessionPath);
  if (session.schemaVersion !== 3 || session.assembly?.schemaVersion !== 1 || !session.canvas) {
    throw new Error("Session requires explicit migration. Run learn-anything create for this topic with --migrate.");
  }
  if (!session.security?.accessToken) {
    session.security = { ...(session.security || {}), accessToken: randomBytes(32).toString("base64url") };
    await atomicSession(sessionPath, session);
  }
  const accessToken = session.security.accessToken;
  const clients = new Set();
  const mentorQueue = [];
  const mentorWaiters = [];
  const mentorReadyWaiters = new Set();
  const partialMessages = new Map();
  let activeMentorId = null;
  let activeMentorReady = false;
  let activeMentorSource = null;
  let activeMentorItemType = null;
  let mentorState = "idle";
  let runTail = Promise.resolve();
  let interruptHandler = null;
  let pendingRuns = 0;
  let persistTail = Promise.resolve();
  let browserDisconnectHandler = null;
  let browserDisconnectGraceMs = 5_000;
  let browserDisconnectTimer = null;
  let browserHasConnected = false;

  function cancelBrowserDisconnect() {
    clearTimeout(browserDisconnectTimer);
    browserDisconnectTimer = null;
  }

  function scheduleBrowserDisconnect() {
    if (!browserHasConnected || clients.size > 0 || !browserDisconnectHandler || browserDisconnectTimer) return;
    browserDisconnectTimer = setTimeout(() => {
      browserDisconnectTimer = null;
      if (clients.size === 0) void browserDisconnectHandler();
    }, browserDisconnectGraceMs);
    browserDisconnectTimer.unref?.();
  }

  function authorizeApi(request, url) {
    const origin = request.headers.origin;
    if (origin && origin !== url.origin) throw httpError("Cross-origin API request rejected.", 403);
    const supplied = request.headers["x-learn-anything-token"] || url.searchParams.get("token");
    if (supplied !== accessToken) throw httpError("Invalid workspace token.", 401);
    if (request.method === "POST" && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw httpError("POST requests require application/json.", 415);
    }
  }

  function claimMentor(mentorId, takeover = false) {
    if (!mentorId) throw httpError("mentorId is required.", 400);
    if (!activeMentorId) {
      activeMentorId = mentorId;
      activeMentorReady = false;
    } else if (activeMentorId !== mentorId) {
      if (!takeover) throw httpError("Another mentor owns this workspace.", 409);
      activeMentorId = mentorId;
      activeMentorReady = false;
      for (const waiter of [...mentorWaiters]) {
        if (waiter.mentorId !== mentorId) waiter.finish(STALE_MENTOR);
      }
    }
  }

  function markMentorReady(mentorId) {
    if (!mentorId || mentorId !== activeMentorId) throw httpError("Mentor lease is not active.", 409);
    activeMentorReady = true;
    for (const finish of [...mentorReadyWaiters]) finish(activeMentorId);
    broadcast(agEvent("CUSTOM", { name: "mentor_presence", value: { attached: true } }));
  }

  function markMentorUnavailable(reason = "unavailable") {
    activeMentorReady = false;
    activeMentorId = null;
    activeMentorSource = null;
    activeMentorItemType = null;
    partialMessages.clear();
    setMentorState(mentorQueue.length ? "waiting" : "idle");
    for (const waiter of [...mentorWaiters]) waiter.finish(STALE_MENTOR);
    broadcast(agEvent("CUSTOM", { name: "mentor_presence", value: { attached: false, reason } }));
  }

  function requireActiveMentor(request) {
    const mentorId = request.headers["x-learn-anything-mentor"];
    if (!mentorId || mentorId !== activeMentorId) throw httpError("Mentor lease is not active.", 409);
    return mentorId;
  }

  function waitForMentor(timeoutMs = 10_000) {
    if (activeMentorId && activeMentorReady) return Promise.resolve(activeMentorId);
    return new Promise((resolvePromise, reject) => {
      const finish = (mentorId) => {
        clearTimeout(timer);
        mentorReadyWaiters.delete(finish);
        if (mentorId) resolvePromise(mentorId);
        else reject(httpError("Mentor did not attach before launch.", 503));
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      mentorReadyWaiters.add(finish);
    });
  }

  async function scheduleRun(task) {
    if (pendingRuns >= MAX_PENDING_RUNS) throw httpError("Too many pending executions.", 429);
    pendingRuns += 1;
    const previous = runTail;
    let release;
    runTail = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await task();
    } finally {
      pendingRuns -= 1;
      release();
    }
  }

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  function setMentorState(state) {
    if (mentorState === state) return;
    mentorState = state;
    broadcast(agEvent("CUSTOM", { name: "mentor_state", value: { state } }));
  }

  function persist() {
    const task = persistTail.then(() => atomicSession(sessionPath, session));
    persistTail = task.catch(() => {});
    return task;
  }

  function enqueueMentor(item) {
    if (item?.type === "user_message") {
      for (let index = mentorQueue.length - 1; index >= 0; index -= 1) {
        if (mentorQueue[index]?.type !== "user_message") mentorQueue.splice(index, 1);
      }
    }
    const index = mentorWaiters.findIndex((waiter) => waiter.mentorId === activeMentorId);
    const waiter = index >= 0 ? mentorWaiters.splice(index, 1)[0] : null;
    if (waiter) waiter.finish(item);
    else mentorQueue.push(item);
  }

  function nextMentorMessage(mentorId, timeoutMs = 55_000) {
    if (mentorQueue.length) return Promise.resolve(mentorQueue.shift());
    return new Promise((resolvePromise) => {
      const waiter = { mentorId, finish: null };
      const finish = (value) => {
        clearTimeout(timer);
        const index = mentorWaiters.indexOf(waiter);
        if (index >= 0) mentorWaiters.splice(index, 1);
        resolvePromise(value);
      };
      waiter.finish = finish;
      const timer = setTimeout(() => finish(null), timeoutMs);
      mentorWaiters.push(waiter);
    });
  }

  async function applyMentorEvent(event) {
    if (!event || typeof event.type !== "string") throw Object.assign(new Error("Mentor event requires type."), { statusCode: 400 });
    if (event.type === "RUN_STARTED") {
      setMentorState("responding");
    } else if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      activeMentorSource = null;
      activeMentorItemType = null;
      if (partialMessages.size === 0) setMentorState(mentorQueue.length ? "waiting" : "idle");
    } else if (event.type === "TEXT_MESSAGE_START") {
      partialMessages.set(event.messageId, {
        role: event.role || "assistant",
        content: "",
        ...(event.source ? { source: event.source } : {}),
        ...(event.context ? { context: event.context } : {}),
      });
      if ((event.role || "assistant") === "assistant") setMentorState("responding");
    } else if (event.type === "TEXT_MESSAGE_CONTENT") {
      const pending = partialMessages.get(event.messageId);
      if (pending) pending.content += event.delta || "";
    } else if (event.type === "TEXT_MESSAGE_END") {
      const pending = partialMessages.get(event.messageId);
      if (pending) {
        session.transcript.push({
          id: event.messageId,
          role: pending.role,
          content: pending.content,
          ...(pending.source ? { source: pending.source } : {}),
          ...(pending.context ? { context: pending.context } : {}),
          createdAt: new Date().toISOString(),
        });
        partialMessages.delete(event.messageId);
        await persist();
        if (pending.role === "assistant") setMentorState("idle");
      }
    } else if (event.type === "CUSTOM" && event.name === "a2ui") {
      const payload = plainCanvasPayload(event.value);
      enforceAutomaticActivityFocus(payload);
      if (activeMentorSource === "work") return preserveInlineWorkContinuation(payload);
      session.canvas = payload.messages.length
        ? hydrateRunResults(applyA2uiMessages(session.canvas, payload.messages, { focus: payload.focus }), session.runResults)
        : { ...session.canvas, focus: payload.focus };
      session.continuation = payload.continuation;
      await persist();
    } else if (event.type === "CUSTOM" && event.name === "mentor_session" && event.value?.sessionId) {
      session.agentSessionId = event.value.sessionId;
      await persist();
    }
    broadcast(event);
    return { accepted: true };
  }

  function plainCanvasPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError("A2UI payload must be an object.", 400);
    if (!["chat", "work"].includes(value.focus)) throw httpError("A2UI payload focus must be chat or work.", 400);
    if (!Array.isArray(value.messages)) throw httpError("A2UI payload messages must be an array.", 400);
    const continuation = value.continuation;
    if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) throw httpError("A2UI payload requires continuation metadata.", 400);
    if (!["question", "action"].includes(continuation.kind)) throw httpError("Continuation kind must be question or action.", 400);
    const text = typeof continuation.text === "string" ? continuation.text.trim() : "";
    if (!text) throw httpError("Continuation text is required.", 400);
    if (value.focus === "chat" && continuation.kind !== "question") throw httpError("Chat focus requires a direct learner question.", 400);
    if (value.focus === "work" && continuation.kind !== "action") throw httpError("Work focus requires a concrete learner action.", 400);
    const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const genericContinuation = /^(?:continue|proceed|next|keep going|go on)(?: (?:with|to|the|this|your|visible|current|activity|lesson|course|work|mentor|guidance|applying))*$/;
    if (continuation.kind === "question" && (!text.includes("?") || !normalized || genericContinuation.test(normalized))) {
      throw httpError("Chat continuation must contain a meaningful direct question.", 400);
    }
    if (continuation.kind === "action" && (!normalized || genericContinuation.test(normalized))) {
      throw httpError("Work continuation must name a meaningful concrete action.", 400);
    }
    return { focus: value.focus, messages: value.messages, continuation: { kind: continuation.kind, text } };
  }

  function enforceAutomaticActivityFocus(payload) {
    if (payload.focus === "chat" && session.canvas?.activeSurfaceId && ["execution_result", "stage_action"].includes(activeMentorItemType)) {
      throw httpError("Automatic activity feedback must remain in work focus and show the learner's next action.", 400);
    }
  }

  async function preserveInlineWorkContinuation(payload) {
    if (payload.focus !== "work" || payload.continuation.kind !== "action") {
      throw httpError("Inline work replies must preserve work focus with a concrete action.", 400);
    }
    session.continuation = payload.continuation;
    await persist();
    broadcast(agEvent("CUSTOM", {
      name: "a2ui",
      value: {
        focus: session.canvas.focus,
        activeSurfaceId: session.canvas.activeSurfaceId,
        messages: [],
        continuation: session.continuation,
      },
    }));
    return { accepted: false, preservedWork: true, continuationUpdated: true, surfaceId: session.canvas?.activeSurfaceId || null };
  }

  async function serveStatic(pathname, response) {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = resolve(webRoot, relative);
    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) {
      sendJson(response, 403, { error: "Forbidden path." });
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw Object.assign(new Error("Not a file."), { code: "ENOENT" });
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
        "content-length": body.length,
        "cache-control": ["/", "/index.html", "/app.js", "/app.css"].includes(pathname)
          ? "no-store"
          : "public, max-age=3600",
      });
      response.end(body);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, { error: "Asset not found. Run npm run build in kit root." });
        return;
      }
      throw error;
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/healthz") {
        sendJson(response, 200, {
          ok: true,
          topic: session.topic,
          profile: session.assembly?.profile,
          degraded: session.assembly?.degraded || [],
          runners: selectedRunners(session.assembly?.execution),
          mentorAttached: Boolean(activeMentorId && activeMentorReady),
        });
        return;
      }

      if (pathname.startsWith("/api/")) authorizeApi(request, url);

      if (request.method === "GET" && pathname === "/api/session") {
        sendJson(response, 200, {
          topic: session.topic,
          transcript: session.transcript,
          canvas: session.canvas,
          continuation: session.continuation || null,
          progress: session.progress,
          assembly: session.assembly,
          mentorAttached: Boolean(activeMentorId && activeMentorReady),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(`data: ${JSON.stringify(agEvent("STATE_SNAPSHOT", {
          snapshot: {
            topic: session.topic,
            transcript: session.transcript,
            canvas: canvasEventValue(session.canvas),
            continuation: session.continuation || null,
            progress: session.progress,
            assembly: session.assembly,
            mentorAttached: Boolean(activeMentorId && activeMentorReady),
          },
        }))}\n\n`);
        clients.add(response);
        browserHasConnected = true;
        cancelBrowserDisconnect();
        const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(response);
          scheduleBrowserDisconnect();
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/message") {
        const body = await readBody(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw Object.assign(new Error("Message text is required."), { statusCode: 400 });
        const source = body.source === undefined ? "chat" : body.source;
        if (!['chat', 'work'].includes(source)) throw httpError("Message source must be chat or work.", 400);
        const surfaceId = source === "work" && typeof body.surfaceId === "string" ? body.surfaceId : null;
        const rawContext = source === "work" && body.context && typeof body.context === "object" ? body.context : null;
        const context = rawContext?.componentId && typeof rawContext.componentId === "string"
          ? {
              componentId: rawContext.componentId.slice(0, 200),
              ...(typeof rawContext.label === "string" ? { label: rawContext.label.slice(0, 200) } : {}),
              ...(typeof rawContext.quote === "string" ? { quote: rawContext.quote.slice(0, 2000) } : {}),
            }
          : null;
        const message = { id: randomUUID(), role: "user", content: text, source, surfaceId, ...(context ? { context } : {}), createdAt: new Date().toISOString() };
        session.transcript.push(message);
        setMentorState("waiting");
        await persist();
        broadcast(agEvent("TEXT_MESSAGE_START", { messageId: message.id, role: "user", source, surfaceId, ...(context ? { context } : {}) }));
        broadcast(agEvent("TEXT_MESSAGE_CONTENT", { messageId: message.id, delta: text }));
        broadcast(agEvent("TEXT_MESSAGE_END", { messageId: message.id }));
        enqueueMentor({ type: "user_message", message, ...(source === "work" ? { canvasContext: session.canvas } : {}) });
        sendJson(response, 202, { accepted: true, messageId: message.id });
        return;
      }
      if (request.method === "POST" && pathname === "/api/mentor/register") {
        const body = await readBody(request);
        claimMentor(body.mentorId, body.takeover === true);
        sendJson(response, 202, { accepted: true, mentorId: activeMentorId });
        return;
      }

      if (request.method === "POST" && pathname === "/api/mentor/ready") {
        markMentorReady(request.headers["x-learn-anything-mentor"]);
        sendJson(response, 202, { accepted: true });
        return;
      }
      if (request.method === "GET" && pathname === "/api/mentor/next") {
        const mentorId = url.searchParams.get("mentorId");
        if (!activeMentorId || activeMentorId !== mentorId || url.searchParams.get("takeover") === "1") {
          claimMentor(mentorId, url.searchParams.get("takeover") === "1");
        }
        const item = await nextMentorMessage(mentorId);
        if (item === STALE_MENTOR) throw httpError("Mentor lease was replaced.", 409);

        if (!item) {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } else {
          activeMentorSource = item.type === "user_message" ? item.message?.source || "chat" : null;
          activeMentorItemType = item.type || null;
          sendJson(response, 200, item);
        }
        return;
      }
      if (request.method === "POST" && pathname === "/api/interrupt") {
        if (mentorState === "waiting" && mentorQueue.length) {
          const queuedIndex = mentorQueue.findLastIndex((item) => item?.type === "user_message");
          if (queuedIndex >= 0) mentorQueue.splice(queuedIndex, 1);
          setMentorState("idle");
          broadcast(agEvent("RUN_ERROR", { message: "Queued mentor request cancelled.", code: "CANCELLED" }));
          sendJson(response, 202, { accepted: true, queued: true });
          return;
        }
        if (!activeMentorReady || typeof interruptHandler !== "function") throw httpError("Mentor cannot be interrupted.", 409);
        const interrupted = await interruptHandler();
        if (!interrupted) throw httpError("No active mentor turn to interrupt.", 409);
        markMentorUnavailable("interrupt");
        broadcast(agEvent("RUN_ERROR", { message: "Mentor response interrupted.", code: "INTERRUPTED" }));
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === "POST" && pathname === "/api/mentor/event") {
        requireActiveMentor(request);
        const event = await readBody(request);
        const result = await applyMentorEvent(event);
        sendJson(response, 202, result || { accepted: true });
        return;
      }

      if (request.method === "POST" && pathname === "/api/a2ui") {
        requireActiveMentor(request);
        const payload = plainCanvasPayload(await readBody(request));
        enforceAutomaticActivityFocus(payload);
        const candidateCanvas = payload.messages.length
          ? hydrateRunResults(applyA2uiMessages(session.canvas, payload.messages, { focus: payload.focus }), session.runResults)
          : { ...session.canvas, focus: payload.focus };
        if (url.searchParams.get("validate") === "1") {
          sendJson(response, 200, { valid: true, surfaceId: candidateCanvas.activeSurfaceId || null });
          return;
        }
        if (activeMentorSource === "work") {
          sendJson(response, 202, await preserveInlineWorkContinuation(payload));
          return;
        }
        session.canvas = candidateCanvas;
        session.continuation = payload.continuation;
        await persist();
        broadcast(agEvent("CUSTOM", {
          name: "a2ui",
          value: {
            focus: session.canvas.focus,
            activeSurfaceId: session.canvas.activeSurfaceId,
            messages: hydratedMessages(session.canvas, payload.messages),
            continuation: session.continuation,
          },
        }));
        setMentorState("idle");
        sendJson(response, 202, { accepted: true, surfaceId: session.canvas.activeSurfaceId || null });
        return;
      }

      if (request.method === "POST" && pathname === "/api/action") {
        const action = await readBody(request);
        const changedComponent = updateCanvasFromAction(session.canvas, action);
        if (changedComponent) {
          await persist();
          const value = action.action === "parameter_change"
            ? canvasEventValue(session.canvas)
            : componentDelta(session.canvas, changedComponent);
          broadcast(agEvent("CUSTOM", { name: "a2ui", value }));
        }
        if (action.action === "code_change" || action.action === "parameter_change") {
          sendJson(response, 202, { accepted: true, persisted: true });
          return;
        }
        const item = {
          type: "stage_action",
          id: randomUUID(),
          action,
          createdAt: new Date().toISOString(),
        };
        enqueueMentor(item);
        sendJson(response, 202, { accepted: true, actionId: item.id });
        return;
      }

      if (request.method === "POST" && pathname === "/api/run") {
        const body = await readBody(request);
        const component = runnableComponent(session.canvas, body.componentId);
        const language = component?.language || body.language;
        const runner = component?.run?.runner || language;
        const setup = component?.run?.setup || "";
        const resultKey = runResultKey(session.canvas, body.componentId);
        if (!language || typeof language !== "string") throw httpError("A learner-facing language is required.", 400);
        if (component && component.runnable === false) throw httpError("This activity is not runnable.", 400);
        const editedComponent = updateEditorValue(session.canvas, body.componentId, body.code);
        if (editedComponent) {
          await persist();
          broadcast(agEvent("CUSTOM", { name: "a2ui", value: componentDelta(session.canvas, editedComponent) }));
        }
        const toolCallId = randomUUID();
        const runId = randomUUID();
        broadcast(agEvent("RUN_STARTED", { threadId: session.slug, runId }));
        broadcast(agEvent("TOOL_CALL_START", { toolCallId, toolCallName: `run_${language}` }));
        broadcast(agEvent("TOOL_CALL_ARGS", { toolCallId, delta: JSON.stringify({ language }) }));
        broadcast(agEvent("TOOL_CALL_END", { toolCallId }));
        try {
          const result = await scheduleRun(() => runSelectedCode({
            execution: session.assembly?.execution,
            language,
            runner,
            code: body.code,
            setup,
            workDir: join(exercisesDir, `run-${runId}`),
            onChunk: ({ kind, text }) => broadcast(agEvent("CUSTOM", {
              name: "console_chunk",
              value: { toolCallId, kind, text },
            })),
          }));
          broadcast(agEvent("TOOL_CALL_RESULT", {
            messageId: randomUUID(),
            toolCallId,
            content: JSON.stringify(result),
            role: "tool",
          }));
          broadcast(agEvent("RUN_FINISHED", { threadId: session.slug, runId, outcome: { type: "success" } }));
          if (resultKey) {
            session.runResults = { ...(session.runResults || {}), [resultKey]: result };
            const activeComponent = resultKey === runResultKey(session.canvas, body.componentId) ? runnableComponent(session.canvas, body.componentId) : null;
            if (activeComponent) activeComponent.lastResult = result;
            await persist();
            if (activeComponent) broadcast(agEvent("CUSTOM", { name: "a2ui", value: componentDelta(session.canvas, activeComponent) }));
          }
          enqueueMentor({
            type: "execution_result",
            language,
            runner,
            componentId: body.componentId || null,
            result,
            createdAt: new Date().toISOString(),
          });
          sendJson(response, 200, result);
        } catch (error) {
          const failedResult = { error: error.message };
          if (resultKey) {
            session.runResults = { ...(session.runResults || {}), [resultKey]: failedResult };
            const activeComponent = resultKey === runResultKey(session.canvas, body.componentId) ? runnableComponent(session.canvas, body.componentId) : null;
            if (activeComponent) activeComponent.lastResult = failedResult;
            await persist();
            if (activeComponent) broadcast(agEvent("CUSTOM", { name: "a2ui", value: componentDelta(session.canvas, activeComponent) }));
          }
          broadcast(agEvent("RUN_ERROR", { message: error.message, code: "EXECUTION_ERROR" }));
          enqueueMentor({
            type: "execution_result",
            language,
            runner,
            componentId: body.componentId || null,
            result: failedResult,
            createdAt: new Date().toISOString(),
          });
          sendJson(response, error.statusCode || 400, { error: error.message });
        }
        return;
      }

      if (request.method === "GET") {
        await serveStatic(pathname, response);
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message });
      else response.end();
    }
  });

  return {
    server,
    sessionDir: resolvedSessionDir,
    accessToken,
    waitForMentor,
    markMentorUnavailable,
    setInterruptHandler(handler) {
      interruptHandler = typeof handler === "function" ? handler : null;
    },
    setBrowserDisconnectHandler(handler, { graceMs = 5_000 } = {}) {
      browserDisconnectHandler = typeof handler === "function" ? handler : null;
      browserDisconnectGraceMs = Math.max(0, Number(graceMs) || 0);
      if (!browserDisconnectHandler) cancelBrowserDisconnect();
    },
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolvePromise);
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      return { host, port: actualPort, url, launchUrl: `${url}/#token=${encodeURIComponent(accessToken)}`, accessToken };
    },
    async close() {
      cancelBrowserDisconnect();
      for (const client of clients) client.end();
      clients.clear();
      for (const waiter of [...mentorWaiters]) waiter.finish(null);
      for (const finish of [...mentorReadyWaiters]) finish(null);
      mentorReadyWaiters.clear();
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    },
  };
}
