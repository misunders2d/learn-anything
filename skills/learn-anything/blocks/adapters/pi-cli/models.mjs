import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parsePiModelList(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("provider "))
    .map((line) => line.split(/\s{2,}/))
    .filter((columns) => columns.length >= 2 && columns[0] && columns[1])
    .map(([provider, model, context = "", maxOutput = "", thinking = "", images = ""]) => ({
      id: `${provider}/${model}`,
      provider,
      model,
      context,
      maxOutput,
      thinking: thinking === "yes",
      images: images === "yes",
    }));
}

async function configuredDefaultModel(env = process.env) {
  const configDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const settings = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    return settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadPiModelCatalog({ piCommand = "pi", env = process.env } = {}) {
  const [{ stdout }, defaultModel] = await Promise.all([
    execFileAsync(piCommand, ["--list-models"], {
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    }),
    configuredDefaultModel(env),
  ]);
  const models = parsePiModelList(stdout);
  const availableIds = new Set(models.map((model) => model.id));
  return {
    models,
    defaultModel: defaultModel && availableIds.has(defaultModel) ? defaultModel : null,
  };
}
