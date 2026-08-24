import { spawnSync } from "node:child_process";
import process from "node:process";

export function commandPath(command, platform = process.platform) {
  const locator = platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/, 1)[0] || null;
}

function browserOpener(platform, resolveCommand = commandPath) {
  if (platform === "darwin") return resolveCommand("open", platform);
  if (platform === "win32") return resolveCommand("cmd", platform);
  return resolveCommand("xdg-open", platform) ?? resolveCommand("gio", platform);
}

function harnessHint(env) {
  if (env.OMPCODE) return "omp";
  if (env.PI_CODING_AGENT || env.PI_AGENT) return "pi";
  if (env.CLAUDECODE) return "claude-code";
  if (env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  if (env.GEMINI_CLI || env.ANTIGRAVITY_AGENT) return "gemini-or-antigravity";
  return "unknown";
}

export function probeCapabilities({
  env = process.env,
  platform = process.platform,
  resolveCommand = commandPath,
} = {}) {
  const commands = Object.fromEntries(
    ["node", "npm", "pi", "claude", "codex", "docker", "podman", "python3", "python", "py", "java", "javac", "cargo", "rustc", "cc", "gcc", "clang"]
      .map((command) => [command, resolveCommand(command, platform)]),
  );
  const containerRuntime = commands.docker ? "docker" : commands.podman ? "podman" : null;
  const opener = browserOpener(platform, resolveCommand);
  const languages = {
    javascript: Boolean(commands.node),
    python: Boolean(commands.python3 || commands.python || commands.py),
    sql: Boolean(commands.python3 || commands.python || commands.py),
    rust: Boolean(commands.rustc),
    java: Boolean(commands.java && commands.javac),
    c: Boolean(commands.cc || commands.gcc || commands.clang),
  };

  const warnings = [];
  if (!opener) warnings.push("No browser opener detected; launch will print URL instead of opening it.");
  if (!Object.values(languages).some(Boolean)) warnings.push("No supported code runner detected.");

  return {
    schemaVersion: 1,
    platform,
    arch: process.arch,
    node: process.version,
    harness: harnessHint(env),
    commands,
    browserOpener: opener,
    containerRuntime,
    languages,
    warnings,
  };
}
