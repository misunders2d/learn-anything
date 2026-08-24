export const A2UI_VERSION = "v0.9";
export const LEARNING_CATALOG_ID = "urn:learn-anything:catalog:v1";

const MAX_MESSAGES = 100;
const MAX_COMPONENTS = 250;
const MAX_SURFACES = 16;
const MAX_TOTAL_COMPONENTS = 1_000;
const MAX_GRAPH_DEPTH = 32;
const MAX_CANVAS_BYTES = 1_000_000;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function protocolError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError(`${label} must be an object.`);
  return value;
}

function boundedId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw protocolError(`${label} must be a non-empty string no longer than 200 characters.`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function emptyCanvas(focus = "chat") {
  return { focus, activeSurfaceId: null, surfaces: {} };
}

export function createInitialCanvas(topic) {
  const canvas = emptyCanvas("chat");
  return applyA2uiMessages(canvas, [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: "lesson",
        catalogId: LEARNING_CATALOG_ID,
      },
    },
    {
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId: "lesson",
        components: [
          { id: "root", component: "Column", children: [] },
        ],
      },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: {
        surfaceId: "lesson",
        path: "/",
        value: { title: topic },
      },
    },
  ]);
}

function messageBody(message) {
  plainObject(message, "A2UI message");
  if (message.version !== A2UI_VERSION) throw protocolError(`A2UI message version must be ${A2UI_VERSION}.`);
  const kinds = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"].filter((key) => key in message);
  if (kinds.length !== 1) throw protocolError("A2UI message must contain exactly one message type.");
  return { kind: kinds[0], body: plainObject(message[kinds[0]], kinds[0]) };
}

function requireSurface(canvas, surfaceId) {
  const id = boundedId(surfaceId, "surfaceId");
  const surface = canvas.surfaces[id];
  if (!surface) throw protocolError(`A2UI surface does not exist: ${id}`);
  return surface;
}

function updateDataModel(surface, path, value) {
  if (path === undefined || path === null || path === "" || path === "/") {
    surface.dataModel = value === undefined ? {} : clone(value);
    return;
  }
  if (typeof path !== "string" || !path.startsWith("/")) throw protocolError("updateDataModel path must be a JSON pointer.");
  const segments = path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) throw protocolError("updateDataModel path contains a blocked segment.");
  if (!surface.dataModel || typeof surface.dataModel !== "object" || Array.isArray(surface.dataModel)) surface.dataModel = {};
  let target = surface.dataModel;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== "object" || Array.isArray(target[segment])) target[segment] = {};
    target = target[segment];
  }
  target[segments.at(-1)] = clone(value);
}

function validateSurfaceGraph(surface) {
  if (surface.catalogId !== LEARNING_CATALOG_ID) throw protocolError(`Unsupported A2UI catalog: ${surface.catalogId}`);
  const components = surface.components || {};
  const root = components.root;
  if (!root) throw protocolError(`A2UI surface ${surface.id} has no root component.`);
  const visiting = new Set();
  const visited = new Set();

  function visit(id, depth) {
    if (depth > MAX_GRAPH_DEPTH) throw protocolError(`A2UI surface ${surface.id} exceeds maximum graph depth.`);
    if (visiting.has(id)) throw protocolError(`A2UI surface ${surface.id} contains a component cycle at ${id}.`);
    if (visited.has(id)) return;
    const component = components[id];
    if (!component) throw protocolError(`A2UI surface ${surface.id} references missing component ${id}.`);
    visiting.add(id);
    if (component.component === "Column" || component.component === "Row") {
      if (!Array.isArray(component.children)) throw protocolError(`A2UI layout component ${id} requires children.`);
      for (const childId of component.children) {
        boundedId(childId, `A2UI child of ${id}`);
        visit(childId, depth + 1);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  visit("root", 0);
  if (visited.size !== Object.keys(components).length) {
    throw protocolError(`A2UI surface ${surface.id} contains unreachable components.`);
  }
}

function validateCanvas(canvas) {
  const surfaces = Object.values(canvas.surfaces || {});
  if (surfaces.length > MAX_SURFACES) throw protocolError(`A2UI canvas exceeds ${MAX_SURFACES} surfaces.`);
  const componentCount = surfaces.reduce((total, surface) => total + Object.keys(surface.components || {}).length, 0);
  if (componentCount > MAX_TOTAL_COMPONENTS) throw protocolError(`A2UI canvas exceeds ${MAX_TOTAL_COMPONENTS} components.`);
  for (const surface of surfaces) validateSurfaceGraph(surface);
  if (JSON.stringify(canvas).length > MAX_CANVAS_BYTES) throw protocolError("A2UI canvas exceeds 1 MB.");
}

export function applyA2uiMessages(current, messages, { focus } = {}) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw protocolError(`A2UI messages must contain between 1 and ${MAX_MESSAGES} entries.`);
  }
  const canvas = clone(current?.surfaces ? current : emptyCanvas());
  if (focus !== undefined) {
    if (!['chat', 'work'].includes(focus)) throw protocolError("Canvas focus must be chat or work.");
    canvas.focus = focus;
  }

  for (const message of messages) {
    const { kind, body } = messageBody(message);
    if (kind === "createSurface") {
      const surfaceId = boundedId(body.surfaceId, "surfaceId");
      const catalogId = boundedId(body.catalogId, "catalogId");
      if (catalogId !== LEARNING_CATALOG_ID) throw protocolError(`Unsupported A2UI catalog: ${catalogId}`);
      canvas.surfaces[surfaceId] = {
        id: surfaceId,
        catalogId,
        ...(body.theme === undefined ? {} : { theme: clone(body.theme) }),
        components: {},
        dataModel: {},
      };
      canvas.activeSurfaceId = surfaceId;
      continue;
    }

    if (kind === "deleteSurface") {
      const surfaceId = boundedId(body.surfaceId, "surfaceId");
      delete canvas.surfaces[surfaceId];
      if (canvas.activeSurfaceId === surfaceId) canvas.activeSurfaceId = Object.keys(canvas.surfaces).at(-1) || null;
      continue;
    }

    const surface = requireSurface(canvas, body.surfaceId);
    canvas.activeSurfaceId = surface.id;
    if (kind === "updateComponents") {
      if (!Array.isArray(body.components) || body.components.length > MAX_COMPONENTS) throw protocolError("updateComponents components must be a bounded array.");
      for (const [index, candidate] of body.components.entries()) {
        const component = plainObject(candidate, `A2UI component ${index + 1}`);
        const id = boundedId(component.id, `A2UI component ${index + 1} id`);
        boundedId(component.component, `A2UI component ${index + 1} component`);
        surface.components[id] = clone(component);
      }
    } else {
      updateDataModel(surface, body.path, body.value);
    }
  }
  validateCanvas(canvas);
  return canvas;
}

export function activeSurface(canvas) {
  return canvas?.activeSurfaceId ? canvas.surfaces?.[canvas.activeSurfaceId] || null : null;
}

export function surfaceComponents(canvas) {
  const surface = activeSurface(canvas);
  return surface ? Object.values(surface.components || {}) : [];
}

export function replayA2uiMessages(canvas) {
  const messages = [];
  for (const surface of Object.values(canvas?.surfaces || {})) {
    messages.push({
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: surface.id,
        catalogId: surface.catalogId,
        ...(surface.theme === undefined ? {} : { theme: clone(surface.theme) }),
      },
    });
    messages.push({
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId: surface.id,
        components: Object.values(surface.components || {}).map(clone),
      },
    });
    messages.push({
      version: A2UI_VERSION,
      updateDataModel: {
        surfaceId: surface.id,
        path: "/",
        value: clone(surface.dataModel || {}),
      },
    });
  }
  return messages;
}

export function canvasEventValue(canvas) {
  return {
    focus: canvas?.focus || "chat",
    activeSurfaceId: canvas?.activeSurfaceId || null,
    messages: replayA2uiMessages(canvas),
  };
}

export function resolveDataBinding(value, dataModel) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.path !== "string") return value;
  if (value.path === "" || value.path === "/") return dataModel;
  const segments = value.path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let resolved = dataModel;
  for (const segment of segments) resolved = resolved?.[segment];
  return resolved;
}

export function canvasFromStage(stage, topic = "Learning workspace") {
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) return createInitialCanvas(topic);
  const surfaceId = typeof stage.surfaceId === "string" && stage.surfaceId ? stage.surfaceId : "lesson";
  const children = [];
  const components = [{ id: "root", component: "Column", children }];
  for (const [index, source] of (Array.isArray(stage.components) ? stage.components : []).entries()) {
    if (!source || typeof source !== "object" || typeof source.type !== "string") continue;
    const id = typeof source.id === "string" && source.id ? source.id : `component-${index + 1}`;
    const { type, ...properties } = source;
    children.push(id);
    components.push({ ...properties, id, component: type[0].toUpperCase() + type.slice(1) });
  }
  return applyA2uiMessages(emptyCanvas(stage.focus === "work" ? "work" : "chat"), [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: LEARNING_CATALOG_ID } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: { title: stage.title || topic } } },
  ]);
}
