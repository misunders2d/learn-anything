// The single source of truth for learning-catalog component identity.
//
// Adding a component type means editing this file and adding one renderer entry
// in blocks/web/src/app.jsx. Nothing else may enumerate component names: the
// reducer, the pattern library, the workspace focus heuristic, the adapters and
// the mentor prompt all import from here.

export const COMPONENT_CATALOG = Object.freeze({
  Column: { layout: true, actions: ["read", "inspect"] },
  Row: { layout: true, actions: ["read", "inspect"] },
  Markdown: { actions: ["read", "inspect"] },
  Callout: { actions: ["read", "inspect"] },
  Code: { actions: ["run", "edit", "inspect", "submit"] },
  Table: { actions: ["read", "inspect"] },
  Passage: { actions: ["read", "inspect"] },
  Figure: { actions: ["read", "inspect"] },
  Math: { actions: ["read", "inspect"] },
  Plot: { actions: ["read", "inspect", "adjust"] },
  Params: { actions: ["adjust", "inspect"] },
  Mermaid: { actions: ["read", "inspect"] },
  Quiz: { actions: ["answer", "inspect"] },
  Checklist: { actions: ["answer", "inspect"] },
});

export const COMPONENT_NAMES = Object.freeze(Object.keys(COMPONENT_CATALOG));

// Actions that mean the learner acts on the component rather than reads it.
const PASSIVE_ACTIONS = new Set(["read", "inspect"]);

export function isKnownComponent(name) {
  return typeof name === "string" && Object.hasOwn(COMPONENT_CATALOG, name);
}

export function isLayoutComponent(name) {
  return isKnownComponent(name) && COMPONENT_CATALOG[name].layout === true;
}

// An unknown type is never granted more than reading, so a future catalog entry
// cannot be impersonated into an executable action by name alone.
export function componentSupportsAction(name, actionType) {
  const supported = isKnownComponent(name) ? COMPONENT_CATALOG[name].actions : ["read", "inspect"];
  return supported.includes(actionType);
}

export function isInteractiveComponent(name) {
  return isKnownComponent(name)
    && COMPONENT_CATALOG[name].layout !== true
    && COMPONENT_CATALOG[name].actions.some((action) => !PASSIVE_ACTIONS.has(action));
}
