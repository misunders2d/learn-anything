import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "blocks/web/src");
const output = resolve(root, "blocks/web/dist");

await mkdir(output, { recursive: true });
await cp(resolve(source, "index.html"), resolve(output, "index.html"));
