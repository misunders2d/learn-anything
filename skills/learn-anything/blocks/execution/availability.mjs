import { spawnSync } from "node:child_process";

const cache = new Map();
export function usableCommand(command, { run = spawnSync, timeout = 1_500 } = {}) {
  if (!command) return false;
  const key = `${process.env.PATH}\0${command}`;
  const saved = cache.get(key);
  if (run === spawnSync && saved && Date.now() - saved.at < 10_000) return saved.usable;
  const name = command.split(/[\\/]/).at(-1).replace(/\.exe$/i, "");
  const args = name === "java" || name === "javac" ? ["-version"] : name === "py" ? ["-3", "--version"] : ["--version"];
  const result = run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL", maxBuffer: 64_000, windowsHide: true });
  const usable = result.status === 0 && !result.error;
  if (run === spawnSync) cache.set(key, { usable, at: Date.now() });
  return usable;
}
