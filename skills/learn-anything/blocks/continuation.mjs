import { componentSupportsAction } from "./a2ui/catalog.mjs";

const ENGLISH_GENERIC_ACTIONS = [
  /^(?:continue|proceed|next|keep going|go on)(?:\s+(?:with|to|the|this|your|visible|current|activity|lesson|course|work|mentor|guidance|applying))*$/,
  /^complete\s+(?:the\s+)?(?:next\s+)?(?:unfinished\s+)?(?:step|activity)(?:\s+in\s+the\s+(?:visible|current)\s+activity)?(?:\s+using\s+the\s+mentor(?:'s)?\s+guidance)?$/,
  /^(?:follow|use)\s+the\s+mentor(?:'s)?\s+guidance$/,
  /^(?:do|try|finish|complete|check|review|inspect|change|run|edit|answer|select|choose|click|press|read|write|fix)\s+(?:it|this|that)(?:\s+(?:now|again|next|please))*$/,
  /^(?:do|finish|complete)\s+(?:the\s+)?(?:task|work|exercise)(?:\s+(?:now|again|next|please))*$/,
];

const CYRILLIC_GENERIC_ACTIONS = [
  /^(?:продолжай|продолжить|дальше|следующий шаг|иди дальше)$/u,
  /^выполни\s+(?:следующий\s+)?(?:незаверш[её]нный\s+)?(?:шаг|задание)(?:\s+по\s+указаниям\s+ментора)?$/u,
  /^(?:сделай|попробуй|заверши|проверь|измени|запусти|исправь|выбери|нажми|прочитай|напиши)\s+(?:это|то)(?:\s+(?:сейчас|снова|ещ[её]|пожалуйста))*$/u,
  /^(?:сделай|заверши|выполни)\s+(?:это\s+)?(?:задание|упражнение|работу)(?:\s+(?:сейчас|снова|ещ[её]|пожалуйста))*$/u,
];

export function normalizedContinuationText(value, max = 1_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function isGenericAction(value) {
  const normalized = normalizedContinuationText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  return [...ENGLISH_GENERIC_ACTIONS, ...CYRILLIC_GENERIC_ACTIONS].some((pattern) => pattern.test(normalized));
}

export const ACTION_TYPES = Object.freeze(["run", "edit", "answer", "adjust", "read", "inspect", "submit"]);

export function actionMatchesType(value, actionType) {
  // The typed action and target define behavior; localized prose is not a parser.
  return ACTION_TYPES.includes(actionType) && Boolean(normalizedContinuationText(value));
}

// The catalog owns which actions each component type supports.
export function actionSupportsComponent(actionType, componentType) {
  return componentSupportsAction(componentType, actionType);
}

export function concreteAction(value, { fallback = "", max = 280 } = {}) {
  const candidate = normalizedContinuationText(value, max) || normalizedContinuationText(fallback, max);
  if (!candidate || isGenericAction(candidate)) {
    throw new Error("Work continuation must name one concrete visible action and its target or expected evidence.");
  }
  return candidate;
}

export function actionRepeatsVisibleState(value, canvas, targetComponentId) {
  const text = normalizedContinuationText(value).toLocaleLowerCase();
  const asksToPopulateCode = /(?:copy|paste|insert|type|скопируй|вставь|введи|перепиши).*(?:code|editor|block|код|редактор|блок)/u.test(text)
    || /(?:code|editor|block|код|редактор|блок).*(?:copy|paste|insert|type|скопируй|вставь|введи|перепиши)/u.test(text);
  if (!asksToPopulateCode) return false;
  const surface = canvas?.activeSurfaceId ? canvas.surfaces?.[canvas.activeSurfaceId] : null;
  const target = surface?.components?.[targetComponentId];
  return Boolean(target?.component === "Code" && typeof target.value === "string" && target.value.trim());
}
