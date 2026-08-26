import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm package exposes an OMP-discoverable skill", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    { cwd: projectRoot },
  );
  const [packed] = Object.values(JSON.parse(stdout));
  const files = new Set(packed.files.map(({ path }) => path));

  assert.ok(files.has("skills/learn-anything/SKILL.md"));
  assert.ok(files.has("skills/learn-anything/bin/learn-anything.mjs"));
  assert.ok(files.has("skills/learn-anything/references/pedagogy.md"));
  assert.ok(files.has("skills/learn-anything/references/visual-system.md"));
});

test("skill keeps measurable design QA in its packaged guidance", async () => {
  const skill = await readFile(resolve(projectRoot, "skills/learn-anything/SKILL.md"), "utf8");
  const visualSystem = await readFile(resolve(projectRoot, "skills/learn-anything/references/visual-system.md"), "utf8");

  assert.match(skill, /Run the design QA in `references\/visual-system\.md`/);
  assert.match(visualSystem, /WCAG 2\.2 AA/);
  assert.match(visualSystem, /200% browser zoom/);
  assert.match(visualSystem, /right-to-left/);
  assert.match(visualSystem, /reduced-motion/);
});

test("package declares its Pi skill and gallery metadata", async () => {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));

  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
});
