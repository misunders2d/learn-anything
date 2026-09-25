import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { locales, resolveLocale, translate, readThemePreference, writeThemePreference, resolveTheme, ThemePicker } from "../skills/learn-anything/blocks/web/src/i18n.mjs";
import { safeStorage } from "../skills/learn-anything/blocks/web/src/safe-storage.mjs";
import { loadDraft, saveDraft, clearDraft } from "../skills/learn-anything/blocks/web/src/draft-store.mjs";

test("locale hint must name a shipped locale, then browser language, then English", () => {
  assert.equal(resolveLocale("ru", "en-US"), "ru");
  assert.equal(resolveLocale("en", "ru-RU"), "en");
  for (const hint of ["fr", "ru-RU", "RU", "__proto__", "constructor", {}, null, undefined]) {
    assert.equal(resolveLocale(hint, "ru-RU"), "ru");
  }
  assert.equal(resolveLocale(null, "RU-ru"), "ru");
  assert.equal(resolveLocale(null, "fr-FR"), "en");
  assert.equal(resolveLocale(null, null), "en");
  assert.equal(resolveLocale(null, "constructor"), "en");
});

test("English and Russian cover exactly the same nonempty keys", () => {
  assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.ru).sort());
  for (const bundle of Object.values(locales)) {
    for (const [key, value] of Object.entries(bundle)) assert.ok(typeof value === "string" && value.trim(), key);
  }
});

test("every literal chrome lookup has a shipped translation and preserves its parameters", async () => {
  const source = await readFile(new URL("../skills/learn-anything/blocks/web/src/app.jsx", import.meta.url), "utf8");
  for (const [, key] of source.matchAll(/\bt\("([^"\n]+)"/g)) {
    assert.ok(Object.hasOwn(locales.en, key), `Unbundled chrome: ${key}`);
  }
  for (const key of Object.keys(locales.en)) {
    const parameters = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(parameters(locales.en[key]), parameters(locales.ru[key]), key);
  }
  assert.equal(translate("en", "milestoneOne", { count: 1 }), "1 milestone");
  assert.equal(translate("en", "milestoneCount", { count: 2 }), "2 milestones");
});

test("missing or empty translation falls back to English and preserves parameters", () => {
  const incomplete = { en: locales.en, ru: { Run: "", modelCount: null } };
  assert.equal(translate("ru", "Run", {}, incomplete), "Run");
  assert.equal(translate("ru", "Submit to mentor", {}, incomplete), "Submit to mentor");
  assert.equal(translate("ru", "modelCount", { count: 7 }, incomplete), "Models: 7");
  assert.equal(translate("xx", "Run"), "Run");
  assert.equal(translate("ru", "unknown.key"), "unknown.key");
  assert.equal(translate("ru", "explainSelection", { text: "{count}" }), "Объясни «{count}»");
});

test("theme preference survives storage errors and still renders controls", () => {
  const getterThrows = { get localStorage() { throw new Error("SecurityError"); } };
  const methodsThrow = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } } };
  for (const host of [getterThrows, methodsThrow]) {
    assert.equal(readThemePreference(host), "system");
    assert.equal(writeThemePreference("dark", host), "dark");
    assert.equal(resolveTheme(writeThemePreference("dark", host), false), "dark");
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: getterThrows });
  try {
    const html = renderToStaticMarkup(createElement(ThemePicker));
    assert.match(html, /<select/);
    assert.match(html, /value="system"/);
    assert.match(html, /value="light"/);
    assert.match(html, /value="dark"/);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  }
});

test("theme choice validates persisted input and explicit preference beats the system", () => {
  const values = new Map();
  const host = { localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } };
  assert.equal(writeThemePreference("dark", host), "dark");
  assert.equal(readThemePreference(host), "dark");
  assert.equal(writeThemePreference("invalid", host), "system");
  assert.equal(readThemePreference(host), "system");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("blocked storage does not prevent chat or code drafts from rendering or editing", () => {
  for (const host of [
    { get localStorage() { throw new Error("blocked getter"); } },
    { localStorage: { getItem() { throw Error("read"); }, setItem() { throw Error("write"); }, removeItem() { throw Error("remove"); } } },
  ]) {
    const storage = safeStorage(host);
    assert.equal(loadDraft(storage, "test-chat", "initial"), "initial");
    saveDraft(storage, "test-chat", "edited");
    assert.equal(loadDraft(safeStorage(host), "test-chat"), "edited");
    assert.equal(clearDraft(storage, "test-chat", "edited"), true);
    assert.equal(loadDraft(storage, "test-chat", "initial"), "initial");
  }
});
