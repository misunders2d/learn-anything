import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseSqlResult, sqlRunnerSource } from "./sqlite-runner.mjs";

const LIMIT_BYTES = 200_000;
const TIMEOUT_MS = 20_000;

const RUNNERS = {
  javascript: { image: "node:22-alpine", file: "playground.mjs", command: ["node", "playground.mjs"] },
  python: { image: "python:3.13-alpine", file: "playground.py", command: ["python3", "playground.py"] },
  rust: { image: "rust:1.85-alpine", file: "playground.rs", command: ["sh", "-lc", "rustc playground.rs -o program && ./program"] },
  c: { image: "gcc:14", file: "playground.c", command: ["sh", "-lc", "gcc playground.c -o program && ./program"] },
  sqlite: { image: "python:3.13-alpine", file: "query.sql", command: ["python3", "sql_runner.py"] },
};

export function containerPlan({ runtime, runner, workDir, uid = process.getuid?.(), gid = process.getgid?.() } = {}) {
  if (!['docker', 'podman'].includes(runtime)) throw new Error("Container runtime must be docker or podman.");
  const selected = RUNNERS[runner];
  if (!selected) throw new Error(`Unsupported container runner: ${runner}`);
  const args = [
    "run", "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "512m",
    "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
  ];
  if (Number.isInteger(uid) && Number.isInteger(gid)) args.push("--user", `${uid}:${gid}`);
  args.push("--volume", `${resolve(workDir)}:/workspace:rw`, "--workdir", "/workspace", selected.image, ...selected.command);
  return { command: runtime, args, file: selected.file };
}

function execute(plan, cwd, onChunk) {
  return new Promise((resolvePromise) => {
    const child = spawn(plan.command, plan.args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let forceTimer;
    const terminate = () => {
      child.kill("SIGTERM");
      forceTimer ||= setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, TIMEOUT_MS);
    const collect = (kind, chunk) => {
      const remaining = LIMIT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        terminate();
        return;
      }
      const bounded = chunk.subarray(0, remaining);
      const text = bounded.toString("utf8");
      bytes += bounded.length;
      if (kind === "stdout") stdout += text;
      else stderr += text;
      onChunk?.({ kind, text });
      if (bounded.length < chunk.length) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}\n`, timedOut, truncated });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });
}

export async function runContainerCode({ runtime, language, runner = language, code, setup = "", workDir, onChunk } = {}) {
  if (typeof code !== "string" || Buffer.byteLength(code) > 100_000) throw new Error("Code must be a string no larger than 100 KB.");
  if (typeof setup !== "string" || Buffer.byteLength(setup) > 100_000) throw new Error("Runner setup must be a string no larger than 100 KB.");
  const safeDir = resolve(workDir);
  await mkdir(safeDir, { recursive: true });
  const plan = containerPlan({ runtime, runner, workDir: safeDir });
  if (runner === "sqlite") {
    await Promise.all([
      writeFile(join(safeDir, "query.sql"), code, "utf8"),
      writeFile(join(safeDir, "setup.sql"), setup, "utf8"),
      writeFile(join(safeDir, "sql_runner.py"), sqlRunnerSource, "utf8"),
    ]);
  } else await writeFile(join(safeDir, plan.file), code, "utf8");

  const started = Date.now();
  const result = await execute(plan, safeDir, runner === "sqlite" ? null : onChunk);
  const output = { language, runner, ...result, durationMs: Date.now() - started };
  if (runner === "sqlite") {
    try {
      const table = parseSqlResult(output.stdout);
      output.stdout = table.error ? "" : table.message || `${table.rowCount} row(s)`;
      output.stderr = table.error || "";
      output.table = table;
    } catch {
      output.stdout = "";
      output.stderr = "SQL runner could not evaluate this query.";
      output.exitCode ||= 1;
    }
  }
  return output;
}
