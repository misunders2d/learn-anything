import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSqlResult, sqlRunnerSource } from "./sqlite-runner.mjs";

const LIMIT_BYTES = 200_000;
const TIMEOUT_MS = 15_000;

function exists(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  return spawnSync(locator, [command], { stdio: "ignore" }).status === 0;
}

function pythonPlan(file) {
  if (exists("python3")) return ["python3", [file]];
  if (exists("python")) return ["python", [file]];
  if (exists("py")) return ["py", ["-3", file]];
  return null;
}

export function availableRunners() {
  const python = Boolean(pythonPlan("playground.py"));
  return {
    javascript: exists("node"),
    python,
    rust: exists("rustc"),
    c: exists("cc") || exists("gcc") || exists("clang"),
    sqlite: python,
  };
}

function runnerPlan(language, workDir) {
  const executable = process.platform === "win32" ? "program.exe" : "program";
  const output = join(workDir, executable);
  if (language === "javascript") return { file: "playground.mjs", steps: [["node", ["playground.mjs"]]] };
  if (language === "python") {
    const step = pythonPlan("playground.py");
    if (!step) throw new Error("Python interpreter not found.");
    return { file: "playground.py", steps: [step] };
  }
  if (language === "rust") return { file: "playground.rs", steps: [["rustc", ["playground.rs", "-o", output]], [output, []]] };
  if (language === "c") {
    const compiler = exists("cc") ? "cc" : exists("gcc") ? "gcc" : "clang";
    return { file: "playground.c", steps: [[compiler, ["playground.c", "-o", output]], [output, []]] };
  }
  throw new Error(`Unsupported language: ${language}`);
}

function runStep(command, args, cwd, onChunk) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let forceTimer;
    function terminate() {
      child.kill("SIGTERM");
      forceTimer ||= setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer.unref?.();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, TIMEOUT_MS);

    function collect(kind, chunk) {
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
    }

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

export async function runCode({ language, runner = language, code, setup = "", workDir, onChunk } = {}) {
  if (typeof code !== "string" || Buffer.byteLength(code) > 100_000) {
    throw new Error("Code must be a string no larger than 100 KB.");
  }
  if (typeof setup !== "string" || Buffer.byteLength(setup) > 100_000) {
    throw new Error("Runner setup must be a string no larger than 100 KB.");
  }
  const safeDir = resolve(workDir);
  await mkdir(safeDir, { recursive: true });
  let plan;
  if (runner === "sqlite") {
    const step = pythonPlan("sql_runner.py");
    if (!step) throw new Error("SQLite learning runner requires Python 3.");
    await Promise.all([
      writeFile(join(safeDir, "query.sql"), code, "utf8"),
      writeFile(join(safeDir, "setup.sql"), setup, "utf8"),
      writeFile(join(safeDir, "sql_runner.py"), sqlRunnerSource, "utf8"),
    ]);
    plan = { steps: [step] };
  } else {
    plan = runnerPlan(runner, safeDir);
    await writeFile(join(safeDir, plan.file), code, "utf8");
  }

  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  let truncated = false;

  for (const [command, args] of plan.steps) {
    const result = await runStep(command, args, safeDir, runner === "sqlite" ? null : onChunk);
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
    timedOut ||= result.timedOut;
    truncated ||= result.truncated;
    if (exitCode !== 0 || timedOut) break;
  }

  const result = {
    language,
    runner,
    exitCode,
    stdout,
    stderr,
    timedOut,
    truncated,
    durationMs: Date.now() - started,
  };
  if (runner === "sqlite") {
    try {
      const table = parseSqlResult(stdout);
      result.stdout = table.error ? "" : table.message || `${table.rowCount} row(s)`;
      result.stderr = table.error || "";
      result.table = table;
    } catch {
      result.stdout = "";
      result.stderr = "SQL runner could not evaluate this query.";
      result.exitCode ||= 1;
    }
  }
  return result;
}
