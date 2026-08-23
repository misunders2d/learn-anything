import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { constructSession, kitRoot } from "./construct.mjs";
import { createLearnAnythingServer } from "../blocks/server/server.mjs";
import { canvasEventValue, canvasFromStage } from "../blocks/a2ui/state.mjs";

const checks = [];
const record = (name) => checks.push(name);

async function waitFor(check, label, timeout = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function browserBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome or Chromium is required. Set CHROME_BIN to its executable path.");
}

async function api(address, path, options = {}, mentorId = null) {
  const response = await fetch(`${address.url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: address.url,
      "x-learn-anything-token": address.accessToken,
      ...(mentorId ? { "x-learn-anything-mentor": mentorId } : {}),
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function renderCanvas(address, stage, mentorId) {
  const payload = canvasEventValue(canvasFromStage(stage, stage.title || "Learning canvas"));
  return api(address, "/api/a2ui", { method: "POST", body: JSON.stringify(payload) }, mentorId);
}

function sessionComponent(session, componentId) {
  const surface = session.canvas?.surfaces?.[session.canvas.activeSurfaceId];
  return surface?.components?.[componentId] || null;
}

class ChromeHarness {
  constructor(binary, profile, launchUrl) {
    this.binary = binary;
    this.profile = profile;
    this.launchUrl = launchUrl;
    this.chrome = null;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.exceptions = [];
  }

  async start() {
    let devtoolsUrl;
    this.chrome = spawn(this.binary, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1280,800",
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profile}`,
      this.launchUrl,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    this.chrome.stderr.setEncoding("utf8");
    this.chrome.stderr.on("data", (chunk) => {
      const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) devtoolsUrl = match[1];
    });
    await waitFor(() => devtoolsUrl, "Chrome DevTools endpoint");

    const port = new URL(devtoolsUrl).port;
    const target = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      return targets.find((item) => item.type === "page" && item.url.startsWith(new URL(this.launchUrl).origin));
    }, "workspace browser target");

    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    await this.call("Runtime.enable");
    await this.call("Page.enable");
    await waitFor(() => this.evaluate("Boolean(document.querySelector('.workspace'))"), "React workspace mount");
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async stop() {
    this.socket?.close();
    if (this.chrome?.exitCode === null) {
      this.chrome.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => this.chrome.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
}

function viewExpression() {
  return `(() => {
    const workspace = document.querySelector('.workspace');
    const mentor = document.querySelector('.mentor-pane');
    const stage = document.querySelector('.stage-pane');
    const rescue = document.getElementById('mentor-rescue');
    const workComposer = document.querySelector('.work-question-input');
    const mentorRect = mentor.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const mentorStyle = getComputedStyle(mentor);
    const stageStyle = getComputedStyle(stage);
    return {
      bodyFocus: document.body.dataset.focus,
      rescueState: document.body.dataset.rescue || '',
      crashed: document.body.dataset.crashed || '',
      workspace: Boolean(workspace),
      viewport: innerWidth,
      mentorWidth: mentorRect.width,
      mentorOpacity: mentorStyle.opacity,
      mentorPointerEvents: mentorStyle.pointerEvents,
      stageWidth: stageRect.width,
      stageOpacity: stageStyle.opacity,
      stagePointerEvents: stageStyle.pointerEvents,
      rescueDisplay: getComputedStyle(rescue).display,
      composerVisible: Boolean(mentor.querySelector('textarea')),
      workComposerWidth: workComposer?.getBoundingClientRect().width || 0,
      rootText: document.getElementById('root').innerText.slice(0, 2000)
    };
  })()`;
}

async function assertView(browser, expected, { rescued = false, mobile = false } = {}) {
  await waitFor(async () => {
    const state = await browser.evaluate(viewExpression());
    const primaryWidth = expected === "chat" ? state.mentorWidth : state.stageWidth;
    const secondaryWidth = expected === "chat" ? state.stageWidth : state.mentorWidth;
    const primaryOpacity = expected === "chat" ? state.mentorOpacity : state.stageOpacity;
    const secondaryOpacity = expected === "chat" ? state.stageOpacity : state.mentorOpacity;
    return state.workspace
      && primaryWidth > state.viewport * 0.9
      && secondaryWidth < 10
      && primaryOpacity === "1"
      && secondaryOpacity === "0";
  }, `${expected} computed visibility${mobile ? " on mobile" : ""}`, 4000);

  const state = await browser.evaluate(viewExpression());
  assert.equal(state.bodyFocus, rescued ? "work" : expected);
  assert.equal(state.rescueState, rescued ? "1" : "");
  assert.equal(expected === "chat" ? state.mentorPointerEvents : state.stagePointerEvents, "auto");
  assert.equal(expected === "chat" ? state.stagePointerEvents : state.mentorPointerEvents, "none");
  assert.equal(state.rescueDisplay, expected === "work" ? "block" : "none");
  assert.equal(state.crashed, "");
  if (expected === "work") assert.ok(state.workComposerWidth > 100, "work question composer must stay visible");
  assert.ok(state.rootText.trim().length > 0, "primary workspace must not be blank");
  return state;
}

async function waitForEditor(browser) {
  await waitFor(
    () => browser.evaluate("Boolean(document.querySelector('.monaco-editor, .code-fallback'))"),
    "usable code editor",
    12_000,
  );
  return browser.evaluate("document.querySelector('.monaco-editor') ? 'monaco' : 'fallback'");
}

async function setEditor(browser, value) {
  await browser.evaluate(`(() => {
    const model = window.monaco?.editor?.getModels?.()[0];
    if (model) model.setValue(${JSON.stringify(value)});
    else {
      const input = document.querySelector('.code-fallback');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
}

function editorValueExpression() {
  return "window.monaco?.editor?.getModels?.()[0]?.getValue() || document.querySelector('.code-fallback')?.value || ''";
}

async function setComposer(browser, value, selector = ".mentor-pane textarea") {
  await browser.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
}

const temp = await mkdtemp(join(tmpdir(), "learn-anything-browser-acceptance-"));
const profile = await mkdtemp(join(tmpdir(), "learn-anything-browser-profile-"));
let runtime;
let listening = false;
let browser;

try {
  const constructed = await constructSession({
    topic: "Browser acceptance",
    root: temp,
    profile: "portable-shell",
    env: {},
  });
  runtime = await createLearnAnythingServer({ sessionDir: constructed.sessionDir, kitRoot, port: 0 });
  const address = await runtime.listen();
  listening = true;
  const mentorId = "browser-acceptance-mentor";

  browser = new ChromeHarness(await browserBinary(), profile, address.launchUrl);
  await browser.start();
  await waitFor(() => browser.evaluate("document.body.dataset.focus === 'chat'"), "initial chat focus");
  await waitFor(() => browser.evaluate("document.querySelector('.workspace-status')?.innerText.includes('Mentor unavailable')"), "initial workspace connection");
  await assertView(browser, "chat");
  record("initial-chat-visible");
  assert.ok(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('Mentor unavailable')"));
  assert.equal(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('mentor-output-may-arrive-per-turn')"), false);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.console-output'))"), false);
  record("learner-facing-capability-labels");
  record("non-code-stage-hides-console");

  const mentorPoll = fetch(`${address.url}/api/mentor/next?${new URLSearchParams({ token: address.accessToken, mentorId, takeover: "1" })}`)
    .then(async (response) => ({ response, body: await response.json() }));
  const firstRequest = "Teach me Rust from scratch";
  await setComposer(browser, firstRequest);
  await browser.evaluate("document.querySelector('.mentor-pane form button[type=submit]').click()");
  await waitFor(() => browser.evaluate("document.querySelector('[role=status]').innerText.includes('Thinking about your question')"), "waiting mentor status");
  const delivered = await mentorPoll;
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.body.message.content, firstRequest);

  const rejectedCanvas = await fetch(`${address.url}/api/a2ui`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: address.url,
      "x-learn-anything-token": address.accessToken,
      "x-learn-anything-mentor": mentorId,
    },
    body: JSON.stringify({ focus: "work", messages: [null] }),
  });
  assert.equal(rejectedCanvas.status, 400);
  await assertView(browser, "chat");
  record("malformed-a2ui-rejected-with-workspace-intact");

  const replyId = "browser-round-trip-reply";
  await api(address, "/api/mentor/event", {
    method: "POST",
    body: JSON.stringify({ type: "TEXT_MESSAGE_START", messageId: replyId, role: "assistant" }),
  }, mentorId);
  await waitFor(() => browser.evaluate("document.querySelector('[role=status]').innerText.includes('Writing a response')"), "responding mentor status");
  for (const delta of ["We will start with a tiny Rust program. ", "I will explain each line before you change it."]) {
    await api(address, "/api/mentor/event", {
      method: "POST",
      body: JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: replyId, delta }),
    }, mentorId);
  }
  await api(address, "/api/mentor/event", {
    method: "POST",
    body: JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: replyId }),
  }, mentorId);
  await waitFor(() => browser.evaluate("document.querySelector('[role=status]').innerText.trim() === ''"), "idle mentor status");
  assert.ok(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('explain each line')"));
  record("send-button-to-mentor-to-streamed-reply");
  record("waiting-responding-idle-status");

  const explanatory = {
    version: "learn-anything/v1",
    surfaceId: "explanation",
    title: "Explanation",
    components: [{ id: "explanation-copy", type: "markdown", content: "One clear explanation" }],
  };
  await renderCanvas(address, explanatory, mentorId);
  await assertView(browser, "chat");
  record("missing-focus-explanation-falls-back-to-chat");

  const code = "console.log('browser-run-ok');";
  const workStage = {
    version: "learn-anything/v1",
    surfaceId: "work-one",
    focus: "work",
    title: "One clear coding task",
    components: [
      { id: "task", type: "callout", tone: "info", title: "Only task", content: "Run the code." },
      { id: "browser-code", type: "code", language: "javascript", runnable: true, value: "console.log('initial');" },
    ],
  };
  await renderCanvas(address, workStage, mentorId);
  await assertView(browser, "work");
  const editorKind = await waitForEditor(browser);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.console-output'))"), false);
  assert.ok(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('Local runner')"));
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.editor-shell')).opacity"), "1");
  record("agent-work-visible");
  record(`code-editor-${editorKind}`);

  await setEditor(browser, "line\nnext");
  await browser.evaluate("document.querySelector('.code-fallback').focus(); document.querySelector('.code-fallback').setSelectionRange(5, 5)");
  await browser.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await browser.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await waitFor(() => browser.evaluate(`(${editorValueExpression()}) === "line\\n    next"`), "Tab indentation in code editor");
  assert.equal(await browser.evaluate("document.activeElement === document.querySelector('.code-fallback')"), true);
  record("tab-indents-and-keeps-editor-focus");

  const workQuestion = "Why does this example matter?";
  const workQuestionPoll = fetch(`${address.url}/api/mentor/next?${new URLSearchParams({ token: address.accessToken, mentorId })}`)
    .then(async (response) => ({ response, body: response.status === 204 ? null : await response.json() }));
  await browser.evaluate("document.querySelector('[data-component-id=\"browser-code\"] .ask-component').click()");
  assert.ok(await browser.evaluate("document.querySelector('.work-question-bar').innerText.includes('About code')"));
  await setComposer(browser, workQuestion, ".work-question-input");
  await waitFor(() => browser.evaluate("!document.querySelector('.work-question-bar button[type=submit]').disabled"), "enabled contextual question submit");
  await browser.evaluate("document.querySelector('.work-question-bar button[type=submit]').click()");
  const deliveredWorkQuestion = await workQuestionPoll;
  assert.equal(deliveredWorkQuestion.response.status, 200);
  assert.equal(deliveredWorkQuestion.body.message.content, workQuestion);
  assert.equal(deliveredWorkQuestion.body.message.source, "work");
  assert.equal(deliveredWorkQuestion.body.message.context.componentId, "browser-code");
  const workReplyId = "work-question-reply";
  for (const event of [
    { type: "TEXT_MESSAGE_START", messageId: workReplyId, role: "assistant", source: "work", context: deliveredWorkQuestion.body.message.context },
    { type: "TEXT_MESSAGE_CONTENT", messageId: workReplyId, delta: "This note belongs to the code block." },
    { type: "TEXT_MESSAGE_END", messageId: workReplyId },
    { type: "RUN_FINISHED", threadId: "browser-acceptance", runId: "work-question", outcome: { type: "success" } },
  ]) await api(address, "/api/mentor/event", { method: "POST", body: JSON.stringify(event) }, mentorId);
  await assertView(browser, "work");
  await waitFor(() => browser.evaluate("document.querySelector('[data-component-id=\"browser-code\"] .anchored-mentor-note')?.innerText.includes('This note belongs to the code block') === true"), "component-anchored mentor reply");
  record("work-surface-context-question");
  record("component-anchored-mentor-reply");

  await setEditor(browser, code);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const saved = await api(address, "/api/session");
  assert.equal(sessionComponent(saved, "browser-code").value, code);
  record("editor-draft-persisted");

  await browser.evaluate("Array.from(document.querySelectorAll('.stage-pane button')).find((button) => button.textContent.trim() === 'Run').click()");
  await waitFor(() => browser.evaluate("document.querySelector('.console-output').innerText.includes('browser-run-ok')"), "browser execution output");
  record("run-output-visible");

  const sqlStage = {
    version: "learn-anything/v1",
    surfaceId: "sql-native",
    focus: "work",
    title: "Choose a column",
    components: [
      { id: "books", type: "table", caption: "books", columns: ["title", "author"], rows: [["Kindred", "Octavia Butler"], ["A Wizard of Earthsea", "Ursula Le Guin"]] },
      {
        id: "sql-query",
        type: "code",
        language: "sql",
        runnable: true,
        value: "SELECT title FROM books ORDER BY title;",
        run: { runner: "sqlite", setup: "CREATE TABLE books(title TEXT, author TEXT); INSERT INTO books VALUES ('Kindred', 'Octavia Butler'), ('A Wizard of Earthsea', 'Ursula Le Guin');" },
      },
    ],
  };
  await renderCanvas(address, sqlStage, mentorId);
  await assertView(browser, "work");
  await waitForEditor(browser);
  assert.equal(await browser.evaluate(editorValueExpression()), "SELECT title FROM books ORDER BY title;");
  assert.equal(await browser.evaluate("document.querySelector('.stage-pane').innerText.includes('import sqlite3')"), false);
  assert.equal(await browser.evaluate("document.querySelector('.stage-pane').innerText.includes('CREATE TABLE')"), false);
  assert.ok(await browser.evaluate("document.querySelector('.data-surface').innerText.includes('Octavia Butler')"));
  await browser.evaluate("Array.from(document.querySelectorAll('.stage-pane button')).find((button) => button.textContent.trim() === 'Run').click()");
  await waitFor(() => browser.evaluate("Array.from(document.querySelectorAll('.data-surface')).some((table) => table.innerText.includes('A Wizard of Earthsea'))"), "structured SQL result table");
  assert.equal(await browser.evaluate("document.querySelector('.stage-pane').innerText.includes('python')"), false);
  record("subject-native-sql-editor");
  record("hidden-sql-backend");
  record("structured-sql-results");

  await setEditor(browser, "SELECT titel FROM books;");
  await waitFor(() => browser.evaluate("Array.from(document.querySelectorAll('[data-component-id=\"sql-query\"] button')).some((button) => button.textContent.trim() === 'Run' && !button.disabled)"), "SQL rerun ready");
  await browser.evaluate("Array.from(document.querySelectorAll('[data-component-id=\"sql-query\"] button')).find((button) => button.textContent.trim() === 'Run').click()");
  await waitFor(() => browser.evaluate("document.querySelector('.console-output')?.innerText.includes('no such column: titel')"), "subject-native SQL error");
  const sqlErrorText = await browser.evaluate("document.querySelector('.execution-result').innerText");
  assert.doesNotMatch(sqlErrorText, /Traceback|sql_runner|sqlite3\.|\/tmp\//i);
  record("sql-error-hides-runner-scaffolding");

  await renderCanvas(address, { ...workStage, components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");

  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true });
  assert.equal(await browser.evaluate("document.activeElement?.tagName"), "TEXTAREA");
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  record("rescue-chat-visible");
  record("editor-preserved-through-rescue");

  const transcriptBeforeShift = (await api(address, "/api/session")).transcript.length;
  await setComposer(browser, "do not send on shift enter");
  await browser.evaluate("document.querySelector('.mentor-pane textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }))");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await api(address, "/api/session")).transcript.length, transcriptBeforeShift);
  assert.ok(await browser.evaluate("Boolean(document.querySelector('#root .workspace'))"));
  record("shift-enter-does-not-submit");

  const enterMessage = "Enter remains inside the workspace";
  await setComposer(browser, enterMessage);
  const urlBeforeEnter = await browser.evaluate("location.href");
  await browser.evaluate("document.querySelector('.mentor-pane textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))");
  await waitFor(async () => (await api(address, "/api/session")).transcript.some((message) => message.content === enterMessage), "Enter message persistence");
  assert.equal(await browser.evaluate("location.href"), urlBeforeEnter);
  await assertView(browser, "chat", { rescued: true });
  record("enter-submits-without-navigation");

  await renderCanvas(address, { ...workStage, components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "chat", { rescued: true });
  record("same-surface-work-cannot-dismiss-rescue");

  await renderCanvas(address, { ...workStage, focus: "chat", components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "chat");
  record("explicit-chat-acknowledges-rescue");

  await renderCanvas(address, { ...workStage, components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  assert.ok(await browser.evaluate("document.querySelector('.console-output').innerText.includes('browser-run-ok')"));
  record("mentor-resumes-work-with-state");

  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true });
  await renderCanvas(address, { ...workStage, surfaceId: "work-two", components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");
  record("new-surface-releases-rescue");

  const interactiveStage = {
    version: "learn-anything/v1",
    surfaceId: "interactive-controls",
    focus: "work",
    title: "Interactive controls",
    components: [
      {
        id: "browser-quiz",
        type: "quiz",
        question: "Which answer?",
        options: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
      },
      {
        id: "browser-checklist",
        type: "checklist",
        items: [{ id: "checked", label: "Mark this complete", done: false }],
      },
    ],
  };
  await renderCanvas(address, interactiveStage, mentorId);
  await assertView(browser, "work");
  await browser.evaluate("Array.from(document.querySelectorAll('.stage-pane button')).find((button) => button.textContent.trim() === 'Two').click()");
  await waitFor(async () => sessionComponent((await api(address, "/api/session")), "browser-quiz").selectedOptionId === "two", "quiz persistence");
  await waitFor(() => browser.evaluate("Array.from(document.querySelectorAll('.stage-pane button')).find((button) => button.textContent.trim() === 'Two').className.includes('is-selected')"), "visible quiz selection");
  await browser.evaluate("document.querySelector('.stage-pane input[type=checkbox]').click()");
  await waitFor(async () => sessionComponent((await api(address, "/api/session")), "browser-checklist").items[0].done, "checklist persistence");
  await waitFor(() => browser.evaluate("document.querySelector('.stage-pane input[type=checkbox]').checked"), "visible checked state");
  record("quiz-choice-click-and-persistence");
  record("checklist-click-and-persistence");

  const subjectNativeStage = {
    version: "learn-anything/v1",
    surfaceId: "subject-native-non-code",
    focus: "work",
    title: "Read, notice, vary",
    components: [
      {
        id: "poem",
        type: "passage",
        text: "Whan that Aprill with his shoures soote",
        source: "Geoffrey Chaucer, General Prologue",
        annotations: [{ quote: "shoures soote", note: "sweet showers" }],
      },
      {
        id: "wave-figure",
        type: "figure",
        mermaid: "flowchart LR\nA[Path A] --> C[Detector]\nB[Path B] --> C",
        caption: "Two paths combine at one detector.",
      },
      {
        id: "phase-control",
        type: "params",
        title: "Change the phase",
        controls: [{ id: "phase", label: "Phase", min: 0, max: 1, step: 0.25, value: 0 }],
      },
    ],
  };
  await renderCanvas(address, subjectNativeStage, mentorId);
  await assertView(browser, "work");
  assert.ok(await browser.evaluate("document.querySelector('.passage-surface').innerText.includes('sweet showers')"));
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.figure-surface svg'))"), "subject figure rendering", 12_000);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.code-fallback, .console-output'))"), false);
  await browser.evaluate(`(() => {
    const input = document.querySelector('.parameter-surface input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0.75');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await waitFor(async () => sessionComponent((await api(address, "/api/session")), "phase-control").controls[0].value === 0.75, "parameter persistence");
  record("annotated-passage-visible");
  record("subject-figure-visible");
  record("parameter-control-interactive");
  record("non-code-subject-hides-code-console");

  for (const [index, focus] of ["chat", "work", "chat", "work"].entries()) {
    await renderCanvas(address, { ...workStage, surfaceId: `rapid-${index}`, focus, components: [{ ...workStage.components[1], value: code }] }, mentorId);
  }
  await assertView(browser, "work");
  record("rapid-agent-transitions-land-on-final-state");

  await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await assertView(browser, "work", { mobile: true });
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true, mobile: true });
  record("mobile-work-and-rescue-visibility");
  await browser.call("Emulation.clearDeviceMetricsOverride");

  const unknownStage = {
    version: "learn-anything/v1",
    surfaceId: "unknown-component",
    focus: "work",
    title: "Forward-compatible component",
    components: [{ id: "future", type: "future-widget", payload: { safe: true } }],
  };
  await renderCanvas(address, unknownStage, mentorId);
  await assertView(browser, "work");
  assert.ok(await browser.evaluate("document.querySelector('.stage-pane').innerText.includes('future-widget')"));
  record("unknown-component-contained");

  const malformedDiagram = {
    version: "learn-anything/v1",
    surfaceId: "bad-diagram",
    focus: "work",
    title: "Bad diagram containment",
    components: [{ id: "bad-mermaid", type: "mermaid", source: "flowchart LR\nA[" }],
  };
  await renderCanvas(address, malformedDiagram, mentorId);
  await assertView(browser, "work");
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.stage-pane .activity-error'))"), "diagram error card");
  record("malformed-diagram-contained");

  await renderCanvas(address, { ...workStage, surfaceId: "resume", components: [{ ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");
  await browser.call("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.workspace'))"), "workspace after refresh");
  await assertView(browser, "work");
  await waitForEditor(browser);
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  const persistedAfterRefresh = await api(address, "/api/session");
  assert.ok(persistedAfterRefresh.transcript.some((message) => message.content === enterMessage));
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true });
  assert.ok(await browser.evaluate(`document.querySelector('.mentor-pane').innerText.includes(${JSON.stringify(enterMessage)})`));
  await renderCanvas(address, { ...workStage, surfaceId: "after-refresh", components: [{ ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");
  record("refresh-restores-stage-and-persisted-transcript");

  await browser.evaluate(`(() => {
    document.body.dataset.crashed = '1';
    document.getElementById('root').replaceChildren();
    document.getElementById('mentor-rescue').click();
  })()`);
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.workspace')) && !document.body.dataset.crashed"), "browser-shell crash recovery", 12_000);
  await assertView(browser, "work");
  record("browser-owned-rescue-recovers-dead-react-root");

  await browser.evaluate(`(() => {
    sessionStorage.setItem('learn-anything-token', 'stale-session-token');
    location.href = location.origin;
  })()`);
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.connection-issue'))"), "stale-session recovery guidance", 12_000);
  assert.ok(await browser.evaluate("document.querySelector('.connection-issue').innerText.includes('earlier workspace')"));
  assert.equal(await browser.evaluate("document.querySelector('.connection-issue').innerText.includes('reconnecting')"), false);
  record("stale-session-shows-explicit-recovery");

  process.stdout.write(`${JSON.stringify({ ok: true, checks, editorKind }, null, 2)}\n`);
} finally {
  await browser?.stop();
  if (runtime && listening) await runtime.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
