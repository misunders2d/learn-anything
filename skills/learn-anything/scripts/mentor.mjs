#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function post(url, path, value, token, mentorId) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": token,
      "x-learn-anything-mentor": mentorId,
    },
    body: JSON.stringify(value),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${body.error || response.statusText}`);
  return body;
}

async function loadValue(args, directFlag = "--text") {
  const file = option(args, "--file");
  if (file) return readFile(file, "utf8");
  const direct = option(args, directFlag);
  if (direct != null) return direct;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error(`Provide --file or ${directFlag}.`);
}

const [command, ...args] = process.argv.slice(2);
const url = (option(args, "--url") || "").replace(/\/$/, "");
const token = option(args, "--token");
const mentorId = option(args, "--mentor-id");
if (!url || !token || !mentorId) throw new Error("--url, --token, and --mentor-id are required.");

if (command === "next") {
  const query = new URLSearchParams({ token, mentorId });
  if (args.includes("--takeover")) query.set("takeover", "1");
  const response = await fetch(`${url}/api/mentor/next?${query}`);
  if (response.status === 204) process.stdout.write("null\n");
  else {
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.error || response.statusText}`);
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  }
} else if (command === "text") {
  const text = await loadValue(args);
  const messageId = randomUUID();
  const runId = randomUUID();
  await post(url, "/api/mentor/event", { type: "RUN_STARTED", threadId: "browser", runId }, token, mentorId);
  await post(url, "/api/mentor/event", { type: "TEXT_MESSAGE_START", messageId, role: "assistant" }, token, mentorId);
  for (let index = 0; index < text.length; index += 160) {
    await post(url, "/api/mentor/event", { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text.slice(index, index + 160) }, token, mentorId);
  }
  await post(url, "/api/mentor/event", { type: "TEXT_MESSAGE_END", messageId }, token, mentorId);
  await post(url, "/api/mentor/event", { type: "RUN_FINISHED", threadId: "browser", runId, outcome: { type: "success" } }, token, mentorId);
  process.stdout.write(`${JSON.stringify({ accepted: true, messageId })}\n`);
} else if (command === "canvas") {
  const raw = await loadValue(args, "--json");
  const payload = JSON.parse(raw);
  const result = await post(url, "/api/a2ui", payload, token, mentorId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (command === "event") {
  const raw = await loadValue(args, "--json");
  const event = JSON.parse(raw);
  const result = await post(url, "/api/mentor/event", event, token, mentorId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error("Usage: mentor.mjs <next|text|canvas|event> --url <server-url> --token <token> --mentor-id <id> [--takeover] [--file path|--text value|--json value]");
}
