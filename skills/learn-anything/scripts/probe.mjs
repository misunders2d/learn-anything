import { spawnSync } from "node:child_process";
import process from "node:process";

const piCliFeatureCache = new Map();

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

export function inspectPiCli(piCommand, run = spawnSync) {
  if (!piCommand) return { persistentMentor: false };
  if (run === spawnSync && piCliFeatureCache.has(piCommand)) return piCliFeatureCache.get(piCommand);
  const result = run(piCommand, ["--no-extensions", "--no-skills", "--no-context-files", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const help = `${result.stdout || ""}\n${result.stderr || ""}`;
  const requiredFlags = [
    "--session-id", "--session-dir", "--model", "--list-models", "--system-prompt", "--name",
    "--mode", "--no-builtin-tools", "--tools", "--extension", "--no-prompt-templates",
  ];
  const features = {
    persistentMentor: result.status === 0 && requiredFlags.every((flag) => help.includes(flag)),
  };
  if (run === spawnSync) piCliFeatureCache.set(piCommand, features);
  return features;
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
  inspectPi = inspectPiCli,
} = {}) {
  const commands = Object.fromEntries(
    ["node", "npm", "pi", "claude", "codex", "docker", "podman", "python3", "python", "py", "java", "javac", "cargo", "rustc", "cc", "gcc", "clang"]
      .map((command) => [command, resolveCommand(command, platform)]),
  );
  const containerRuntime = commands.docker ? "docker" : commands.podman ? "podman" : null;
  const opener = browserOpener(platform, resolveCommand);
  const pi = inspectPi(commands.pi);
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
  if (commands.pi && !pi.persistentMentor) warnings.push("Installed Pi lacks persistent RPC mentor, typed tool, or per-course model selection support; update Pi before selecting the pi-cli profile.");

  return {
    schemaVersion: 1,
    platform,
    arch: process.arch,
    node: process.version,
    harness: harnessHint(env),
    commands,
    features: { piPersistentMentor: pi.persistentMentor },
    browserOpener: opener,
    containerRuntime,
    languages,
    warnings,
  };
}
