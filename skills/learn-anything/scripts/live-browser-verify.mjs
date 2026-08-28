import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function waitFor(check, label, timeout = 120_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
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
  throw new Error("Chrome or Chromium is required. Set CHROME_BIN.");
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
    await waitFor(() => devtoolsUrl, "Chrome DevTools endpoint", 10_000);
    const port = new URL(devtoolsUrl).port;
    const target = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      return targets.find((item) => item.type === "page" && item.url.startsWith(new URL(this.launchUrl).origin));
    }, "workspace browser target", 10_000);
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.call("Runtime.enable");
    await this.call("Page.enable");
    await waitFor(() => this.evaluate("Boolean(document.querySelector('.workspace'))"), "workspace mount", 15_000);
  }

  call(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async screenshot(path) {
    const result = await this.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(path, Buffer.from(result.data, "base64"));
  }

  async click(expression) {
    await this.evaluate(`(() => {
      const element = ${expression};
      if (!element) throw new Error('Clickable element not found');
      element.scrollIntoView({ block: 'center', inline: 'center' });
    })()`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const point = await this.evaluate(`(() => {
      const element = ${expression};
      if (!element) throw new Error('Clickable element not found');
      const rect = element.getBoundingClientRect();
      if (element.disabled) throw new Error('Clickable element is disabled');
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) throw new Error('Clickable element is outside viewport');
      return { x, y };
    })()`);
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }

  async setComposer(text, selector = ".mentor-pane textarea") {
    await this.click(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    })()`);
  }

  async stop() {
    this.socket?.close();
    if (this.chrome?.exitCode === null) this.chrome.kill("SIGTERM");
  }
}

function browserState() {
  return `(() => ({
    focus: document.body.dataset.focus || '',
    rescue: document.body.dataset.rescue || '',
    rootText: document.getElementById('root')?.innerText || '',
    connected: Boolean(document.querySelector('.status-dot.is-connected')),
    status: document.querySelector('[role=status]')?.innerText || '',
    messages: Array.from(document.querySelectorAll('.mentor-pane article')).map((item) => item.innerText),
    lastMessageRole: document.querySelector('.mentor-pane article:last-of-type')?.classList.contains('chat-message-mentor') ? 'mentor' : 'user',
    stageTitle: document.querySelector('.stage-pane h2')?.innerText || '',
    runVisible: Array.from(document.querySelectorAll('.stage-pane button')).some((button) => button.innerText.trim() === 'Run'),
    editorVisible: Boolean(document.querySelector('.monaco-editor, .code-fallback')),
    outputText: document.querySelector('.execution-result')?.innerText || '',
    anchoredReplyText: document.querySelector('.anchored-mentor-note')?.innerText || '',
    composerValue: document.querySelector('.mentor-pane textarea')?.value || '',
    sendDisabled: document.querySelector('.mentor-pane button[type=submit]')?.disabled ?? true,
    composerVisible: (() => {
      const input = document.querySelector('.mentor-pane textarea');
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    })(),
    workComposerVisible: (() => {
      const input = document.querySelector('.work-question-input');
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    })()
  }))()`;
}

const args = process.argv.slice(2);
const url = (option(args, "--url") || "").replace(/\/$/, "");
const sessionDir = resolve(option(args, "--session") || "");
if (!url || !option(args, "--session")) throw new Error("Usage: live-browser-verify.mjs --url <server-url> --session <session-dir>");
const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
const token = session.security?.accessToken;
if (!token) throw new Error("Session has no access token.");
const firstMessage = option(args, "--message") || "I am completely new to Rust. Start from the beginning, explain the first idea in plain language, then prepare one tiny guided example.";
const allowChat = args.includes("--allow-chat");
const currentWork = args.includes("--current-work");
const mentorTurnOnly = args.includes("--mentor-turn-only");
const interruptWith = option(args, "--interrupt-with");
const expectedInterruptText = option(args, "--expect");
const workQuestion = option(args, "--work-question");
const unanchoredWorkQuestion = args.includes("--unanchored-work-question");
const screenshotPath = option(args, "--screenshot");
const profile = await mkdtemp(join(tmpdir(), "learn-anything-live-browser-"));
const browser = new ChromeHarness(await browserBinary(), profile, `${url}/#token=${token}`);
const checks = [];

async function send(text) {
  await waitFor(async () => !(await browser.evaluate(browserState())).status, "mentor idle before send", 180_000);
  const before = (await browser.evaluate(browserState())).messages.length;
  await browser.evaluate(`(() => {
    window.__mentorStatuses = [];
    window.__mentorStatusObserver?.disconnect();
    window.__mentorStatusObserver = new MutationObserver(() => {
      const status = document.querySelector('[role=status]')?.innerText || '';
      if (status) window.__mentorStatuses.push(status);
    });
    window.__mentorStatusObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  })()`);
  await browser.setComposer(text);
  await waitFor(async () => {
    const state = await browser.evaluate(browserState());
    return state.composerValue === text && !state.sendDisabled;
  }, "typed learner message", 10_000);
  await browser.click("document.querySelector('.mentor-pane button[type=submit]')");
  await waitFor(async () => {
    const state = await browser.evaluate(browserState());
    return !state.composerValue && state.messages.some((message) => message.includes(text));
  }, "exact visible learner message", 10_000);
  await waitFor(async () => {
    const state = await browser.evaluate(browserState());
    return state.messages.length >= before + 2 && !state.status && state.lastMessageRole === "mentor";
  }, "real mentor reply", 180_000);
  const statuses = await browser.evaluate("window.__mentorStatuses || []");
  assert.ok(statuses.some((status) => /thinking|writing|adding|waiting|responding/i.test(status)), "visible mentor activity status must occur");
  await browser.evaluate("window.__mentorStatusObserver?.disconnect()");
}

try {
  await browser.start();
  await waitFor(async () => (await browser.evaluate(browserState())).connected, "workspace SSE connection", 15_000);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  let state = await browser.evaluate(browserState());
  if (state.focus === "work" && !currentWork) {
    await browser.click("document.getElementById('mentor-rescue')");
    await waitFor(async () => (await browser.evaluate(browserState())).composerVisible, "initial rescue chat", 10_000);
    state = await browser.evaluate(browserState());
  }
  assert.ok(currentWork ? state.focus === "work" : state.focus === "chat" || state.rescue === "1");
  assert.ok(state.rootText.trim());
  checks.push(currentWork ? "existing-work-visible" : "initial-chat-visible");

  if (!currentWork) {
    await send(firstMessage);
    state = await browser.evaluate(browserState());
    assert.ok(state.messages.at(-1).length > 40);
    checks.push("clicked-send-real-codex-reply");
    checks.push("waiting-responding-idle-visible");
  }

  if (state.focus !== "work" && !allowChat) {
    await send("That makes sense. Show me a complete tiny worked example, then give me one clear change to make and run in the browser.");
    state = await browser.evaluate(browserState());
  }
  if (state.focus === "work") {
    assert.ok(state.stageTitle && !/profile|adapter/i.test(state.stageTitle));
    assert.ok(state.workComposerVisible);
    checks.push("mentor-driven-work-surface");
    checks.push("work-question-composer-visible");
    const firstInteraction = await browser.evaluate(`(() => {
      const element = document.querySelector('.parameter-surface input[type=range], .playground-surface textarea, .interaction-list button, .checklist-list input');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: innerHeight };
    })()`);
    if (firstInteraction && !mentorTurnOnly) {
      assert.ok(firstInteraction.top >= 0 && firstInteraction.bottom <= firstInteraction.viewport, "first required interaction must be visible without scrolling");
      checks.push("first-required-interaction-visible-without-scrolling");
    }
    if (workQuestion) {
      if (!unanchoredWorkQuestion) {
        await browser.click("document.querySelector('.code-fallback')?.closest('.stage-component')?.querySelector('.ask-component') || document.querySelector('.stage-component .ask-component')");
        await waitFor(() => browser.evaluate("document.querySelector('.work-question-bar').innerText.includes('About ')"), "selected work component context", 10_000);
      }
      await browser.setComposer(workQuestion, ".work-question-input");
      await browser.click("document.querySelector('.work-question-bar button[type=submit]')");
      await waitFor(async () => {
        const current = await browser.evaluate(browserState());
        return current.messages.some((message) => message.includes(workQuestion));
      }, "work-surface question in transcript", 10_000);
      await waitFor(async () => {
        const current = await browser.evaluate(browserState());
        if (current.status || current.lastMessageRole !== "mentor") return false;
        return unanchoredWorkQuestion ? current.focus === "chat" : current.focus === "work" && current.anchoredReplyText;
      }, "mentor response to work-surface question", 180_000);
      checks.push(unanchoredWorkQuestion ? "broad-work-question-opens-chat" : "clicked-work-question-and-received-reply");
      state = await browser.evaluate(browserState());
    }
    if (state.focus === "work" && state.editorVisible && state.runVisible) {
      const messagesBeforeRun = state.messages.length;
      await browser.click("Array.from(document.querySelectorAll('.stage-pane button')).find((button) => button.innerText.trim() === 'Run')");
      await waitFor(async () => {
        const current = await browser.evaluate(browserState());
        return current.outputText;
      }, "visible execution result", 60_000);
      checks.push("clicked-run-visible-output");
      if (interruptWith) {
        await browser.click("document.getElementById('mentor-rescue')");
        await waitFor(async () => (await browser.evaluate(browserState())).composerVisible, "interrupt rescue chat", 10_000);
        await browser.setComposer(interruptWith);
        await browser.click("document.querySelector('.mentor-pane button[type=submit]')");
        await waitFor(async () => {
          const current = await browser.evaluate(browserState());
          return !current.composerValue && current.messages.some((message) => message.includes(interruptWith));
        }, "visible interrupting learner message", 10_000);
        await waitFor(async () => {
          const current = await browser.evaluate(browserState());
          return !current.status && (!expectedInterruptText || current.messages.at(-1).toLowerCase().includes(expectedInterruptText.toLowerCase()));
        }, "mentor response to interrupting topic", 240_000);
        const interruptedSession = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
        const interruptIndex = interruptedSession.transcript.findIndex((message) => message.role === "user" && message.content === interruptWith);
        const repliesAfterInterrupt = interruptedSession.transcript.slice(interruptIndex + 1).filter((message) => message.role === "assistant");
        assert.ok(interruptIndex >= 0, "interrupting learner message must persist");
        assert.equal(repliesAfterInterrupt.length, 1, "stale automatic feedback must not render after a newer learner message");
        if (expectedInterruptText) assert.match(repliesAfterInterrupt[0].content, new RegExp(expectedInterruptText, "i"));
        checks.push("learner-message-preempts-stale-execution-feedback");
        state = await browser.evaluate(browserState());
      } else {
        await waitFor(async () => {
          const current = await browser.evaluate(browserState());
          return current.messages.length > messagesBeforeRun && !current.status;
        }, "mentor response to execution", 180_000);
        checks.push("execution-returns-to-real-mentor");
        state = await browser.evaluate(browserState());
      }
    }
    if (screenshotPath) {
      await browser.screenshot(screenshotPath);
      checks.push("captured-workspace-screenshot");
    }
    if (state.focus === "work") {
      await browser.click("document.getElementById('mentor-rescue')");
      await waitFor(async () => {
        const current = await browser.evaluate(browserState());
        return current.rescue === "1" && current.composerVisible && current.rootText.trim();
      }, "rescue chat", 10_000);
      checks.push("clicked-ask-mentor-nonblank-chat");
    }
  } else {
    assert.ok(state.composerVisible);
    checks.push("chat-remains-primary");
  }

  await browser.call("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("Boolean(document.querySelector('.workspace'))"), "workspace after refresh", 15_000);
  state = await browser.evaluate(browserState());
  assert.ok(state.rootText.trim());
  assert.ok(state.messages.length >= 2);
  assert.deepEqual(browser.exceptions, []);
  checks.push("refresh-restores-real-transcript");

  const persisted = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
  const surface = persisted.canvas?.surfaces?.[persisted.canvas.activeSurfaceId] || null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checks,
    canvas: {
      focus: persisted.canvas?.focus || "chat",
      title: surface?.dataModel?.title || "",
      componentTypes: Object.values(surface?.components || {}).map((component) => component.component),
    },
    lastMentorMessage: persisted.transcript?.filter((message) => message.role === "assistant").at(-1)?.content || "",
  }, null, 2)}\n`);
} finally {
  await browser.stop();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
