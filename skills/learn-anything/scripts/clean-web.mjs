import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptsDir, "../blocks/web/dist");

// Fail before deleting shipped assets when a checkout lacks its build tools.
const require = createRequire(import.meta.url);
try {
  require.resolve("esbuild/bin/esbuild");
  require.resolve("@tailwindcss/cli/package.json");
} catch {
  throw new Error("Web build tools are unavailable. Run npm ci first; existing browser assets were preserved.");
}

await rm(dist, { recursive: true, force: true });
