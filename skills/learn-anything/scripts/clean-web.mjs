import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptsDir, "../blocks/web/dist");

// Fail before deleting shipped assets when a checkout lacks its build tools.
const require = createRequire(import.meta.url);
try {
  execFileSync(process.execPath, [require.resolve("esbuild/bin/esbuild"), "--version"], { stdio: "pipe" });
  const tailwind = resolve(dirname(require.resolve("@tailwindcss/cli/package.json")), "dist/index.mjs");
  execFileSync(process.execPath, [tailwind, "--help"], { stdio: "pipe" });
} catch {
  throw new Error("Web build tools are unavailable. Run npm ci first; existing browser assets were preserved.");
}

await rm(dist, { recursive: true, force: true });
