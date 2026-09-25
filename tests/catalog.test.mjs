import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_CATALOG,
  COMPONENT_NAMES,
  componentSupportsAction,
  isInteractiveComponent,
  isKnownComponent,
  isLayoutComponent,
} from "../skills/learn-anything/blocks/a2ui/catalog.mjs";
import { A2UI_VERSION, LEARNING_CATALOG_ID, applyA2uiMessages } from "../skills/learn-anything/blocks/a2ui/state.mjs";
import { actionSupportsComponent } from "../skills/learn-anything/blocks/continuation.mjs";
import { resolveFocus } from "../skills/learn-anything/blocks/web/src/workspace-state.mjs";

function surface(children, extra = []) {
  return applyA2uiMessages({ activeSurfaceId: null, surfaces: {} }, [
    { version: A2UI_VERSION, createSurface: { surfaceId: "s", catalogId: LEARNING_CATALOG_ID } },
    { version: A2UI_VERSION, updateComponents: { surfaceId: "s", components: [{ id: "root", component: "Column", children }, ...extra] } },
  ]);
}

test("the catalog is the frozen list of trusted component types", () => {
  assert.ok(Object.isFrozen(COMPONENT_CATALOG));
  assert.ok(Object.isFrozen(COMPONENT_NAMES));
  assert.deepEqual(COMPONENT_NAMES, Object.keys(COMPONENT_CATALOG));
  for (const name of COMPONENT_NAMES) assert.ok(isKnownComponent(name), name);
  assert.equal(isKnownComponent("Foo"), false);
});

test("an unknown type still renders as inspectable content, as the stage catalog documents", () => {
  const canvas = surface(["f"], [{ id: "f", component: "Foo" }]);
  assert.equal(canvas.surfaces.s.components.f.component, "Foo");
});

test("action compatibility comes from the catalog, and an unknown type can only be read", () => {
  assert.equal(componentSupportsAction("Code", "run"), true);
  assert.equal(componentSupportsAction("Markdown", "submit"), false);
  assert.equal(componentSupportsAction("Plot", "adjust"), true);
  assert.equal(componentSupportsAction("Foo", "read"), true);
  assert.equal(componentSupportsAction("Foo", "run"), false);
  // The work-turn gate delegates to the same table.
  assert.equal(actionSupportsComponent("edit", "Code"), true);
  assert.equal(actionSupportsComponent("answer", "Code"), false);
});

test("layout and interactive classification come from the catalog", () => {
  assert.equal(isLayoutComponent("Column"), true);
  assert.equal(isLayoutComponent("Row"), true);
  assert.equal(isLayoutComponent("Code"), false);
  for (const name of ["Code", "Quiz", "Checklist", "Params", "Plot"]) assert.equal(isInteractiveComponent(name), true, name);
  for (const name of ["Markdown", "Callout", "Column", "Foo"]) assert.equal(isInteractiveComponent(name), false, name);
});

test("focus falls back to work for catalog-interactive components, but not a non-runnable editor", () => {
  const params = surface(["p"], [{ id: "p", component: "Params", controls: [{ id: "k", min: 0, max: 1, value: 0 }] }]);
  delete params.focus;
  assert.equal(resolveFocus(params), "work");
  const readonly = surface(["c"], [{ id: "c", component: "Code", language: "javascript", value: "x", runnable: false }]);
  delete readonly.focus;
  assert.equal(resolveFocus(readonly), "chat");
});
