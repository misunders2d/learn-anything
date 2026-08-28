import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";

export const MENTOR_TOOL_NAME = "complete_mentor_turn";

export function piRpcArgs({ sessionDir, sessionId = null, model = null, systemPrompt, sessionName, extensionPath }) {
  const args = [
    "--mode", "rpc",
    "--no-skills",
    "--no-extensions",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-builtin-tools",
    "--tools", MENTOR_TOOL_NAME,
    "--extension", resolve(extensionPath),
  ];
  if (sessionId) {
    args.push("--session-id", sessionId, "--session-dir", join(sessionDir, "runtime", "mentor-sessions"));
    if (sessionName) args.push("--name", sessionName);
  } else {
    args.push("--no-session");
  }
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  return args;
}

export function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function completedMentorToolResults(events) {
  return events
    .filter((event) => event?.type === "tool_execution_end" && event.toolName === MENTOR_TOOL_NAME && event.isError !== true)
    .map((event) => event.result?.details)
    .filter((details) => details && typeof details === "object" && details.contractVersion === 1);
}

export function collectPiRpcTurn(events) {
  const toolResults = completedMentorToolResults(events);
  const textMessages = events
    .filter((event) => event?.type === "message_end")
    .map((event) => assistantText(event.message))
    .filter(Boolean);
  const providerError = [...events].reverse().find((event) =>
    event?.type === "message_end"
    && event.message?.role === "assistant"
    && event.message?.stopReason === "error",
  )?.message?.errorMessage;
  return {
    toolResults,
    assistantText: textMessages.at(-1) || "",
    providerError: providerError || null,
  };
}

export class PiRpcClient {
  constructor({ command = "pi", args, cwd, spawnImpl = spawnChild, timeoutMs = 300_000 }) {
    this.child = spawnImpl(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.activeTurn = null;
    this.stderr = "";
    this.closed = false;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";

    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-12_000); });
    this.child.stdout.on("data", (chunk) => this.#readChunk(chunk));
    this.child.stdout.on("end", () => this.#finishReader());
    this.child.once("error", (error) => this.#fail(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed && code !== 0) this.#fail(new Error(`pi RPC exited ${code ?? signal}: ${this.stderr.trim() || "no error output"}`));
      else this.#fail(new Error("pi RPC process closed."));
    });
  }

  #readChunk(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.#readLine(line);
    }
  }

  #finishReader() {
    this.buffer += this.decoder.end();
    if (this.buffer) this.#readLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
    this.buffer = "";
  }

  #readLine(line) {
    let event;
    try { event = JSON.parse(line); }
    catch (error) {
      this.#fail(new Error(`Pi RPC protocol returned invalid JSONL: ${error.message}`));
      return;
    }
    if (event.type === "response" && event.id && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id);
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.success) pending.resolve(event.data ?? null);
      else pending.reject(new Error(event.error || `${event.command || "RPC command"} failed.`));
      return;
    }
    if (!this.activeTurn) return;
    this.activeTurn.events.push(event);
    if (event.type === "agent_settled") {
      const turn = this.activeTurn;
      this.activeTurn = null;
      clearTimeout(turn.timer);
      turn.resolve(collectPiRpcTurn(turn.events));
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timer);
      this.activeTurn.reject(error);
      this.activeTurn = null;
    }
  }

  command(type, fields = {}) {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new Error("Pi RPC process is not writable."));
    const id = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ready() {
    return this.command("get_state");
  }

  async setModel(model) {
    const separator = String(model || "").indexOf("/");
    if (separator <= 0) throw new Error(`Pi model must be provider-qualified: ${model}`);
    return this.command("set_model", {
      provider: model.slice(0, separator),
      modelId: model.slice(separator + 1),
    });
  }

  async prompt(message) {
    if (this.activeTurn) throw new Error("Pi RPC mentor already has an active turn.");
    const turnPromise = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (this.activeTurn?.reject === reject) this.activeTurn = null;
        reject(new Error("Pi RPC mentor turn timed out."));
      }, this.timeoutMs);
      this.activeTurn = { events: [], resolve: resolvePromise, reject, timer };
    });
    try {
      await this.command("prompt", { message });
      return await turnPromise;
    } catch (error) {
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timer);
        this.activeTurn = null;
      }
      throw error;
    }
  }

  async abort() {
    if (!this.activeTurn) return false;
    await this.command("abort");
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}
