import { createElement, useLayoutEffect, useSyncExternalStore } from "react";
import en from "./locales/en.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };

export const locales = Object.freeze({ en, ru });
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function resolveLocale(hint, language = globalThis.navigator?.language) {
  // Protocol hints must name an exact shipped locale; browser tags may be regional.
  if (typeof hint === "string" && owns(locales, hint)) return hint;
  const base = typeof language === "string" ? language.toLowerCase().split("-")[0] : "";
  return owns(locales, base) ? base : "en";
}

export function translate(locale, key, params = {}, bundles = locales) {
  const bundle = owns(bundles, locale) ? bundles[locale] : {};
  const candidate = owns(bundle, key) ? bundle[key] : null;
  const fallback = owns(en, key) ? en[key] : String(key);
  const template = typeof candidate === "string" && candidate.length ? candidate : fallback;
  return template.replace(/\{(\w+)\}/g, (match, name) => owns(params, name) ? String(params[name]) : match);
}

let currentLocale = resolveLocale();
export const t = (key, params) => translate(currentLocale, key, params);

export const THEME_STORAGE_KEY = "learn-anything:theme";
const themeChoices = ["system", "light", "dark"];
export function readThemePreference(host = globalThis.window) {
  try {
    const value = host?.localStorage?.getItem(THEME_STORAGE_KEY);
    return themeChoices.includes(value) ? value : "system";
  } catch { return "system"; }
}
export function writeThemePreference(choice, host = globalThis.window) {
  const preference = themeChoices.includes(choice) ? choice : "system";
  try { host?.localStorage?.setItem(THEME_STORAGE_KEY, preference); } catch { /* In-memory preference still works. */ }
  return preference;
}
export const resolveTheme = (choice, systemDark = false) => choice === "dark" || (choice === "system" && systemDark) ? "dark" : "light";

let preference = readThemePreference();
const media = globalThis.window?.matchMedia?.("(prefers-color-scheme: dark)");
let mode = resolveTheme(preference, media?.matches);
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => `${preference}:${mode}`;

function applyTheme() {
  mode = resolveTheme(preference, media?.matches);
  const root = globalThis.document?.documentElement;
  if (root) {
    if (preference === "system") delete root.dataset.theme;
    else root.dataset.theme = preference;
    root.dataset.resolvedTheme = mode;
  }
  for (const listener of listeners) listener();
}
export function setThemePreference(choice) {
  preference = writeThemePreference(choice);
  applyTheme();
}
media?.addEventListener("change", applyTheme);
globalThis.window?.addEventListener("storage", (event) => {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  preference = readThemePreference();
  applyTheme();
});
applyTheme();

export function useResolvedTheme() {
  return useSyncExternalStore(subscribe, snapshot, snapshot).split(":")[1];
}

export function usePresentation(localeHint) {
  // One browser workspace owns chrome; content direction remains surface-owned.
  currentLocale = resolveLocale(localeHint);
  const locale = currentLocale;
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("Learn anything");
    window.dispatchEvent(new CustomEvent("learn-anything:locale", { detail: {
      ask: t("Ask mentor"), back: t("Back to activity"), returnLabel: t("Return to preserved activity"),
    } }));
  }, [locale]);
}

export function ThemePicker() {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot).split(":")[0];
  return createElement("label", { className: "theme-picker" },
    createElement("span", { className: "visually-hidden" }, t("Theme")),
    createElement("select", {
      "aria-label": t("Theme"), value,
      onChange: (event) => setThemePreference(event.target.value),
    }, themeChoices.map((choice) => createElement("option", { key: choice, value: choice }, t({ system: "System", light: "Light", dark: "Dark" }[choice])))),
  );
}

export function mermaidThemeVariables() {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(`--${name}`).trim();
  return {
    darkMode: mode === "dark",
    background: token("ground"), primaryColor: token("sunken"),
    primaryTextColor: token("ink"), primaryBorderColor: token("muted"),
    secondaryColor: token("accent-soft"), secondaryTextColor: token("ink"), secondaryBorderColor: token("accent"),
    tertiaryColor: token("surface"), tertiaryTextColor: token("ink"), tertiaryBorderColor: token("muted"),
    lineColor: token("muted"), edgeLabelBackground: token("ground"),
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  };
}
