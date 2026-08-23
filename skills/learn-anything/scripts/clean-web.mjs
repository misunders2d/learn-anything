import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptsDir, "../blocks/web/dist");

await rm(dist, { recursive: true, force: true });
