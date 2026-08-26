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
  payload.continuation = stage.continuation || (payload.focus === "work"
    ? { kind: "action", text: `Complete the visible ${stage.title || "activity"}.` }
    : { kind: "question", text: "What would you like to explore next?" });
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
      hasWorkState: document.body.dataset.hasWork || '',
      rescueState: document.body.dataset.rescue || '',
      returnWorkState: document.body.dataset.returnWork || '',
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

async function assertView(browser, expected, { rescued = false, returned = false, mobile = false } = {}) {
  await waitFor(async () => {
    const state = await browser.evaluate(viewExpression());
    const primaryWidth = expected === "chat" ? state.mentorWidth : state.stageWidth;
    const secondaryWidth = expected === "chat" ? state.stageWidth : state.mentorWidth;
    const primaryOpacity = expected === "chat" ? state.mentorOpacity : state.stageOpacity;
    const secondaryOpacity = expected === "chat" ? state.stageOpacity : state.mentorOpacity;
    return state.workspace
      && (rescued || returned || state.bodyFocus === expected)
      && state.rescueState === (rescued ? "1" : "")
      && state.returnWorkState === (returned ? "1" : "")
      && primaryWidth > state.viewport * 0.9
      && secondaryWidth < 10
      && primaryOpacity === "1"
      && secondaryOpacity === "0";
  }, `${expected} computed visibility${mobile ? " on mobile" : ""}`, 4000);

  const state = await browser.evaluate(viewExpression());
  if (!rescued && !returned) assert.equal(state.bodyFocus, expected);
  assert.equal(state.rescueState, rescued ? "1" : "");
  assert.equal(state.returnWorkState, returned ? "1" : "");
  assert.equal(expected === "chat" ? state.mentorPointerEvents : state.stagePointerEvents, "auto");
  assert.equal(expected === "chat" ? state.stagePointerEvents : state.mentorPointerEvents, "none");
  const rescueVisible = expected === "work" || rescued || returned || (expected === "chat" && state.hasWorkState === "1");
  assert.equal(state.rescueDisplay, rescueVisible ? "block" : "none");
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
  let interruptCount = 0;
  runtime.setInterruptHandler(async () => {
    interruptCount += 1;
    return true;
  });
  await api(address, "/api/mentor/register", {
    method: "POST",
    body: JSON.stringify({ mentorId, takeover: true }),
  });
  await api(address, "/api/mentor/ready", { method: "POST", body: "{}" }, mentorId);

  browser = new ChromeHarness(await browserBinary(), profile, address.launchUrl);
  await browser.start();
  await waitFor(() => browser.evaluate("document.body.dataset.focus === 'chat'"), "initial chat focus");
  await waitFor(() => browser.evaluate("document.querySelector('.workspace-status')?.innerText.includes('Mentor ready')"), "qualified mentor connection");
  await assertView(browser, "chat");
  record("initial-chat-visible");
  const renderedContrast = await browser.evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    const parse = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value.trim();
      document.body.append(probe);
      const channels = getComputedStyle(probe).color.match(/[\\d.]+/g).slice(0, 3).map(Number);
      probe.remove();
      return channels;
    };
    const luminance = (channels) => channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (foreground, background) => {
      const values = [luminance(parse(foreground)), luminance(parse(background))].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const ground = root.getPropertyValue('--ground');
    return {
      faintText: ratio(root.getPropertyValue('--faint'), ground),
      focusIndicator: ratio(root.getPropertyValue('--accent'), ground),
      primaryButton: ratio('#ffffff', root.getPropertyValue('--accent')),
    };
  })()`);
  assert.ok(renderedContrast.faintText >= 4.5, `faint text contrast must be at least 4.5:1, got ${renderedContrast.faintText}`);
  assert.ok(renderedContrast.focusIndicator >= 3, `focus contrast must be at least 3:1, got ${renderedContrast.focusIndicator}`);
  assert.ok(renderedContrast.primaryButton >= 4.5, `primary button contrast must be at least 4.5:1, got ${renderedContrast.primaryButton}`);
  record("rendered-core-colors-meet-wcag-contrast");
  assert.ok(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('Mentor ready')"));
  assert.equal(await browser.evaluate("document.querySelector('.mentor-pane').innerText.includes('mentor-output-may-arrive-per-turn')"), false);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.console-output'))"), false);
  record("learner-facing-capability-labels");
  record("non-code-stage-hides-console");

  const unsentQuestion = "draft survives refresh";
  await setComposer(browser, unsentQuestion);
  await browser.call("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.workspace'))"), "workspace after draft refresh");
  assert.equal(await browser.evaluate("document.querySelector('.mentor-pane textarea').value"), unsentQuestion);
  record("unsent-question-draft-restored");

  const mentorPoll = fetch(`${address.url}/api/mentor/next?${new URLSearchParams({ token: address.accessToken, mentorId })}`)
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
    body: JSON.stringify({ focus: "work", messages: [null], continuation: { kind: "action", text: "Continue the activity." } }),
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
  const workLeadId = "work-transition-reply";
  for (const event of [
    { type: "TEXT_MESSAGE_START", messageId: workLeadId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: workLeadId, delta: `This explanation must remain visible when the activity opens.\n\n${"Mentor context stays above the activity. ".repeat(120)}` },
    { type: "TEXT_MESSAGE_END", messageId: workLeadId },
  ]) await api(address, "/api/mentor/event", { method: "POST", body: JSON.stringify(event) }, mentorId);
  await renderCanvas(address, workStage, mentorId);
  await assertView(browser, "work");
  await waitFor(() => browser.evaluate("document.querySelector('.stage-pane').contains(document.activeElement)"), "focus moves into work surface");
  assert.ok(await browser.evaluate("document.querySelector('.work-mentor-lead')?.innerText.includes('must remain visible')"));
  await waitFor(() => browser.evaluate("document.querySelector('.stage-pane .course-continuation')?.innerText.toLowerCase().includes('next step') === true"), "work continuation cue");
  record("mentor-reply-visible-through-work-transition");
  record("chat-to-work-focus-moves-to-visible-control");
  record("work-turn-shows-explicit-next-action");

  await renderCanvas(address, { ...workStage, focus: "chat" }, mentorId);
  await assertView(browser, "chat");
  await waitFor(() => browser.evaluate("document.querySelector('.mentor-pane .course-continuation')?.innerText.toLowerCase().includes('your turn') === true"), "chat continuation cue");
  assert.equal(await browser.evaluate("document.getElementById('mentor-rescue').textContent"), "Back to activity");
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "work", { returned: true });
  record("programmatic-chat-keeps-back-to-activity");
  await renderCanvas(address, workStage, mentorId);
  await assertView(browser, "work");

  const nestedComponents = [
    { id: "root", component: "Column", children: ["nested-layout"] },
    { id: "nested-layout", component: "Column", children: ["instruction", "scroll-code", "support"] },
    { id: "instruction", component: "Markdown", content: { path: "/instruction" } },
    { id: "scroll-code", component: "Code", language: "javascript", runnable: true, value: "console.log(1);" },
    { id: "support", component: "Markdown", content: "Supporting detail ".repeat(300) },
  ];
  await api(address, "/api/a2ui", {
    method: "POST",
    body: JSON.stringify({
      focus: "work",
      continuation: { kind: "action", text: "Change one value in the visible code." },
      messages: [
        { version: "v0.9", deleteSurface: { surfaceId: "work-one" } },
        { version: "v0.9", createSurface: { surfaceId: "work-one", catalogId: "urn:learn-anything:catalog:v1" } },
        { version: "v0.9", updateComponents: { surfaceId: "work-one", components: nestedComponents } },
        { version: "v0.9", updateDataModel: { surfaceId: "work-one", path: "/", value: { title: "First task", instruction: "### First task\n\nChange one value." } } },
      ],
    }),
  }, mentorId);
  await assertView(browser, "work");
  await browser.evaluate("document.querySelector('.stage-scroll').scrollTop = document.querySelector('.stage-scroll').scrollHeight");
  assert.ok(await browser.evaluate("document.querySelector('.stage-scroll').scrollTop > 100"));
  await api(address, "/api/a2ui", {
    method: "POST",
    body: JSON.stringify({
      focus: "work",
      continuation: { kind: "action", text: "Run the revised visible example." },
      messages: [
        { version: "v0.9", updateDataModel: { surfaceId: "work-one", path: "/title", value: "Second task" } },
        { version: "v0.9", updateDataModel: { surfaceId: "work-one", path: "/instruction", value: "### Second task\n\nRun the revised example." } },
      ],
    }),
  }, mentorId);
  await waitFor(() => browser.evaluate(`(() => {
    const viewport = document.querySelector('.stage-scroll')?.getBoundingClientRect();
    const instruction = document.querySelector('[data-component-id="instruction"]')?.getBoundingClientRect();
    if (!viewport || !instruction) return false;
    const overlap = Math.max(0, Math.min(viewport.bottom, instruction.bottom) - Math.max(viewport.top, instruction.top));
    return overlap >= instruction.height * 0.9;
  })()`), "new nested bound instruction is visible");
  assert.ok(await browser.evaluate("document.querySelector('[data-component-id=instruction]').innerText.includes('Second task')"));
  record("new-task-instruction-scrolls-into-view");

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
  await browser.call("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.workspace'))"), "workspace after immediate editor refresh");
  await assertView(browser, "work");
  await waitForEditor(browser);
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  record("immediate-editor-draft-restored");
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
  assert.equal(await browser.evaluate("document.getElementById('mentor-rescue').textContent"), "Back to activity");
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "work", { returned: true });
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  record("manual-back-to-preserved-activity");
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true });

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

  const rescueReplyId = "rescue-question-reply";
  for (const event of [
    { type: "TEXT_MESSAGE_START", messageId: rescueReplyId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: rescueReplyId, delta: "Move the existing control now." },
  ]) await api(address, "/api/mentor/event", { method: "POST", body: JSON.stringify(event) }, mentorId);
  await renderCanvas(address, { ...workStage, components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "chat", { rescued: true });
  await api(address, "/api/mentor/event", { method: "POST", body: JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: rescueReplyId }) }, mentorId);
  await assertView(browser, "work");
  record("same-surface-work-resumes-after-rescue-reply");
  record("work-restore-survives-canvas-before-reply-end");

  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true });
  await renderCanvas(address, { ...workStage, focus: "chat", components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "chat", { rescued: true });
  assert.equal(await browser.evaluate("document.getElementById('mentor-rescue').textContent"), "Back to activity");
  record("mentor-can-keep-chat-after-rescue");
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "work", { returned: true });
  assert.equal(await browser.evaluate(editorValueExpression()), code);
  record("back-to-activity-available-after-chat-focused-reply");

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
    title: "Read and connect",
    components: [
      {
        id: "poem",
        type: "passage",
        text: "Whan that Aprill with his shoures soote",
        source: "Geoffrey Chaucer, General Prologue",
        annotations: [{ quote: "shoures soote", note: "sweet showers" }],
      },
      {
        id: "reading-figure",
        type: "figure",
        mermaid: "flowchart LR\nA[Middle English line] --> B[Word-level gloss]\nB --> C[Meaning in context]",
        caption: "Move from the original line to a gloss, then to an interpretation.",
      },
    ],
  };
  await renderCanvas(address, subjectNativeStage, mentorId);
  await assertView(browser, "work");
  assert.ok(await browser.evaluate("document.querySelector('.passage-surface').innerText.includes('sweet showers')"));
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.figure-surface svg'))"), "subject figure rendering", 12_000);
  const diagramTheme = await browser.evaluate(`(() => {
    const svg = document.querySelector('.figure-surface svg');
    const label = svg?.querySelector('.nodeLabel, text');
    const node = svg?.querySelector('.node rect, .node polygon, .node circle');
    return {
      content: svg?.textContent || '',
      labelFill: label ? getComputedStyle(label).fill : '',
      nodeFill: node ? getComputedStyle(node).fill : '',
    };
  })()`);
  assert.match(diagramTheme.content, /Middle English line/);
  assert.notEqual(diagramTheme.labelFill, diagramTheme.nodeFill, "diagram labels must contrast with node fills");
  await renderCanvas(address, {
    ...subjectNativeStage,
    surfaceId: subjectNativeStage.surfaceId,
    components: [{
      id: "strict-figure",
      type: "figure",
      mermaid: "flowchart LR\nA[\"<img src=x onerror='window.__mermaidXss=1'>\"] --> B[Safe]",
      caption: "Strict Mermaid rendering",
    }],
  }, mentorId);
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.figure-surface svg'))"), "strict Mermaid rendering", 12_000);
  assert.equal(await browser.evaluate("window.__mermaidXss || 0"), 0);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.figure-surface script, .figure-surface [onerror], .figure-surface [onclick]'))"), false);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.code-fallback, .console-output'))"), false);
  record("annotated-passage-visible");
  record("subject-figure-visible");
  record("subject-figure-labels-readable");
  record("strict-mermaid-blocks-script-and-event-injection");
  record("non-code-subject-hides-code-console");

  const lossSeries = (weight) => [
    { id: "loss", label: "Loss across weights", points: [[0, 1], [0.25, 0.25], [0.5, 0], [0.75, 0.25], [1, 1]] },
    { id: "current", label: "Current weight", points: [[weight, (1 - 2 * weight) ** 2]] },
  ];
  const neuronFrame = (value) => ({
    value,
    updates: [
      { path: "/equation", value: `\\hat{y}=2\\times${value}=${2 * value},\\quad loss=(1-${2 * value})^2=${(1 - 2 * value) ** 2}` },
      { path: "/lossSeries", value: lossSeries(value) },
    ],
  });
  const reactiveStage = {
    version: "learn-anything/v1",
    surfaceId: "one-neuron-model",
    focus: "work",
    title: "See one neuron make a prediction",
    dataModel: {
      weight: 0,
      equation: "\\hat{y}=2\\times0=0,\\quad loss=(1-0)^2=1",
      lossSeries: lossSeries(0),
    },
    components: [
      { id: "neuron-copy", type: "markdown", content: "The input is **2** and the target is **1**. Move the weight: the prediction and squared error change together." },
      { id: "weight-control", type: "params", title: "Change the weight", controls: [{ id: "weight", label: "Weight", min: 0, max: 1, step: 0.25, value: 0, path: "/weight", frames: [0, 0.25, 0.5, 0.75, 1].map(neuronFrame) }] },
      { id: "neuron-equation", type: "math", expression: { path: "/equation" }, caption: "Prediction equals input times weight; loss measures distance from the target." },
      { id: "loss-plot", type: "plot", title: "How the weight changes loss", description: "Squared error for input 2 and target 1.", x: { label: "Weight", min: 0, max: 1 }, y: { label: "Squared loss", min: 0, max: 1 }, series: { path: "/lossSeries" }, caption: "This is one teaching neuron, not a full neural network." },
    ],
  };
  await renderCanvas(address, reactiveStage, mentorId);
  await assertView(browser, "work");
  const firstInteraction = await browser.evaluate(`(() => {
    const input = document.querySelector('.parameter-surface input[type=range]');
    const rect = input?.getBoundingClientRect();
    return rect ? { top: rect.top, bottom: rect.bottom, viewport: innerHeight } : null;
  })()`);
  assert.ok(firstInteraction && firstInteraction.top >= 0 && firstInteraction.bottom <= firstInteraction.viewport, "the first required interaction must be visible at 1280x800 without scrolling");
  record("first-required-interaction-visible-without-scrolling");
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.plot-surface svg'))"), "subject plot rendering");
  await waitFor(() => browser.evaluate("document.querySelector('.math-surface').textContent.includes('0')"), "subject math rendering");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.code-fallback, .console-output'))"), false);
  assert.equal(await browser.evaluate("document.querySelectorAll('.plot-surface circle[tabindex]').length"), 0);
  assert.ok(await browser.evaluate("document.querySelector('.plot-data summary').textContent.includes('View plotted values')"));
  const initialPlotPath = await browser.evaluate("document.querySelector('[data-plot-series=current] path').getAttribute('d')");
  await browser.evaluate(`(() => {
    const input = document.querySelector('.parameter-surface input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0.75');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => browser.evaluate(`document.querySelector('[data-plot-series=current] path').getAttribute('d') !== ${JSON.stringify(initialPlotPath)}`), "local plot reaction before persistence");
  await waitFor(() => browser.evaluate("document.querySelector('.math-surface').textContent.includes('0.75')"), "local math reaction before persistence");
  assert.equal(sessionComponent(await api(address, "/api/session"), "weight-control").controls[0].value, 0);
  record("parameter-updates-plot-and-math-without-round-trip");
  await browser.evaluate("document.querySelector('.parameter-surface input[type=range]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))");
  await waitFor(async () => sessionComponent((await api(address, "/api/session")), "weight-control").controls[0].value === 0.75, "parameter persistence");
  await browser.call("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.plot-surface svg'))"), "reactive canvas after refresh");
  await waitFor(() => browser.evaluate("document.querySelector('.math-surface').textContent.includes('0.75')"), "reactive math after refresh");
  record("one-neuron-interactive-model");
  record("safe-math-and-structured-plot-visible");
  record("plot-avoids-per-point-keyboard-stops");
  record("parameter-control-interactive");
  record("reactive-parameter-state-restored-after-refresh");

  await renderCanvas(address, {
    version: "learn-anything/v1",
    surfaceId: "one-neuron-model",
    focus: "work",
    title: "Dense plot remains navigable",
    components: [{
      id: "dense-plot",
      type: "plot",
      title: "Five hundred samples",
      x: { label: "Sample", min: 0, max: 499 },
      y: { label: "Normalized value", min: 0, max: 1 },
      series: [{ id: "samples", label: "Samples", points: Array.from({ length: 500 }, (_, index) => [index, (Math.sin(index / 25) + 1) / 2]) }],
    }],
  }, mentorId);
  await assertView(browser, "work");
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('[data-plot-series=samples] path'))"), "dense plot rendering");
  assert.equal(await browser.evaluate("document.querySelectorAll('.plot-surface circle[tabindex]').length"), 0);
  assert.equal(await browser.evaluate("document.querySelectorAll('.plot-surface circle').length"), 500);
  record("maximum-series-plot-has-no-point-tab-trap");

  for (const [index, focus] of ["chat", "work", "chat", "work"].entries()) {
    await renderCanvas(address, { ...workStage, surfaceId: `rapid-${index}`, focus, components: [{ ...workStage.components[1], value: code }] }, mentorId);
  }
  await assertView(browser, "work");
  record("rapid-agent-transitions-land-on-final-state");

  await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await assertView(browser, "work", { mobile: true });
  assert.equal(await browser.evaluate("document.querySelector('.stage-pane').scrollWidth <= document.querySelector('.stage-pane').clientWidth + 1"), true);
  await browser.evaluate("document.getElementById('mentor-rescue').click()");
  await assertView(browser, "chat", { rescued: true, mobile: true });
  record("mobile-work-and-rescue-visibility");
  record("mobile-shell-has-no-page-level-horizontal-overflow");
  await browser.call("Emulation.clearDeviceMetricsOverride");

  await renderCanvas(address, { ...workStage, components: [{ ...workStage.components[0] }, { ...workStage.components[1], value: code }] }, mentorId);
  await assertView(browser, "work");
  await browser.evaluate("document.documentElement.style.fontSize = '200%'");
  await assertView(browser, "work");
  const enlarged = await browser.evaluate(`(() => {
    const stage = document.querySelector('.stage-pane');
    const rescue = document.getElementById('mentor-rescue').getBoundingClientRect();
    const composer = document.querySelector('.work-question-input').getBoundingClientRect();
    return {
      noPageOverflow: stage.scrollWidth <= stage.clientWidth + 1,
      rescueVisible: rescue.width > 0 && rescue.height > 0 && rescue.right <= innerWidth && rescue.bottom <= innerHeight,
      composerVisible: composer.width > 100 && composer.height > 0,
    };
  })()`);
  assert.deepEqual(enlarged, { noPageOverflow: true, rescueVisible: true, composerVisible: true });
  await browser.evaluate("document.documentElement.style.fontSize = ''");
  record("two-hundred-percent-text-scale-keeps-core-actions-visible");

  await browser.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const maxMotionMs = await browser.evaluate(`(() => {
    const toMs = (value) => value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
    const values = Array.from(document.querySelectorAll('.workspace, .workspace > section, .stage-component, .thinking-dot')).flatMap((element) => {
      const style = getComputedStyle(element);
      return [...style.animationDuration.split(','), ...style.transitionDuration.split(',')].map((value) => toMs(value.trim()));
    });
    return Math.max(...values.filter(Number.isFinite));
  })()`);
  assert.ok(maxMotionMs <= 0.1, `reduced-motion durations must settle immediately, got ${maxMotionMs}ms`);
  await browser.call("Emulation.setEmulatedMedia", { features: [] });
  record("reduced-motion-settles-into-complete-state");

  const rtlStage = {
    ...workStage,
    title: "قراءة تقرير اقتصادي طويل باللغة العربية",
    dataModel: { direction: "rtl" },
    components: [
      { ...workStage.components[0], title: "المهمة الحالية", content: "اقرأ الفقرة الطويلة، ثم شغّل المثال وراجع النتيجة بجانبها." },
      { ...workStage.components[1], value: code },
    ],
  };
  await renderCanvas(address, rtlStage, mentorId);
  await assertView(browser, "work");
  const rtlLayout = await browser.evaluate(`(() => {
    const stage = document.querySelector('.stage-pane');
    const rescue = document.getElementById('mentor-rescue').getBoundingClientRect();
    return {
      direction: getComputedStyle(document.querySelector('.stage-pane')).direction,
      noPageOverflow: stage.scrollWidth <= stage.clientWidth + 1,
      calloutStartBorder: getComputedStyle(document.querySelector('.callout-surface')).borderInlineStartWidth,
      codeDirection: getComputedStyle(document.querySelector('.playground-surface')).direction,
      rescueVisible: rescue.width > 0 && rescue.height > 0 && rescue.left >= 0 && rescue.right <= innerWidth,
    };
  })()`);
  assert.deepEqual(rtlLayout, {
    direction: "rtl",
    noPageOverflow: true,
    calloutStartBorder: "3px",
    codeDirection: "ltr",
    rescueVisible: true,
  });
  record("right-to-left-content-keeps-logical-layout-and-ltr-code");

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

  await renderCanvas(address, {
    version: "learn-anything/v1",
    surfaceId: "bad-diagram",
    focus: "work",
    title: "Bad math containment",
    components: [{ id: "bad-equation", type: "math", expression: "\\definitelyUnknownCommand{" }],
  }, mentorId);
  await assertView(browser, "work");
  await waitFor(() => browser.evaluate("document.querySelector('.stage-pane .activity-error')?.innerText.includes('notation could not render')"), "math error card");
  record("malformed-math-contained");

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

  await api(address, "/api/mentor/event", {
    method: "POST",
    body: JSON.stringify({ type: "RUN_STARTED", threadId: "browser-acceptance", runId: "interrupt-check" }),
  }, mentorId);
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.mentor-stop'))"), "mentor interrupt control");
  await browser.evaluate("document.querySelector('.mentor-stop').click()");
  await waitFor(() => interruptCount === 1, "mentor interrupt delivery");
  assert.equal((await api(address, "/api/session")).mentorAttached, false);
  record("mentor-interrupt-control");

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
