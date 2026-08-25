export const A2UI_VERSION = "v0.9";
export const LEARNING_CATALOG_ID = "urn:learn-anything:catalog:v1";

const MAX_MESSAGES = 100;
const MAX_COMPONENTS = 250;
const MAX_SURFACES = 16;
const MAX_TOTAL_COMPONENTS = 1_000;
const MAX_GRAPH_DEPTH = 32;
const MAX_CANVAS_BYTES = 1_000_000;
const MAX_PLOT_SERIES = 8;
const MAX_PLOT_POINTS_PER_SERIES = 500;
const MAX_PLOT_POINTS = 2_000;
const MAX_PARAMETER_CONTROLS = 12;
const MAX_PARAMETER_FRAMES = 101;
const MAX_FRAME_UPDATES = 12;
const MAX_MATH_EXPRESSION = 5_000;
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

function pointerSegments(path, label = "updateDataModel path") {
  if (typeof path !== "string" || !path.startsWith("/")) throw protocolError(`${label} must be a JSON pointer.`);
  const segments = path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) throw protocolError(`${label} contains a blocked segment.`);
  return segments;
}

function updateDataModel(surface, path, value) {
  if (path === undefined || path === null || path === "" || path === "/") {
    surface.dataModel = value === undefined ? {} : clone(value);
    return;
  }
  const segments = pointerSegments(path);
  if (!surface.dataModel || typeof surface.dataModel !== "object" || Array.isArray(surface.dataModel)) surface.dataModel = {};
  let target = surface.dataModel;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== "object" || Array.isArray(target[segment])) target[segment] = {};
    target = target[segment];
  }
  target[segments.at(-1)] = clone(value);
}

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw protocolError(`${label} must be a finite number.`);
  return value;
}

function boundedText(value, label, max = 200) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > max) throw protocolError(`${label} must be a string no longer than ${max} characters.`);
}

function validateLearningComponent(surface, component) {
  // Validate the values the browser will actually render. Bindings are resolved
  // recursively at render time, so checking only the binding object would let
  // malformed data-model values bypass the component contract.
  const resolvedComponent = resolveDataBinding(component, surface.dataModel);
  if (component.component === "Math") {
    const expression = resolvedComponent.expression;
    if (typeof expression !== "string" || !expression.trim() || expression.length > MAX_MATH_EXPRESSION) {
      throw protocolError(`A2UI Math component ${component.id} requires a non-empty expression no longer than ${MAX_MATH_EXPRESSION} characters.`);
    }
    boundedText(resolvedComponent.caption, `A2UI Math component ${component.id} caption`, 2_000);
  }

  if (component.component === "Plot") {
    const series = resolvedComponent.series;
    if (!Array.isArray(series) || series.length === 0 || series.length > MAX_PLOT_SERIES) {
      throw protocolError(`A2UI Plot component ${component.id} requires between 1 and ${MAX_PLOT_SERIES} series.`);
    }
    boundedText(resolvedComponent.title, `A2UI Plot component ${component.id} title`);
    boundedText(resolvedComponent.description, `A2UI Plot component ${component.id} description`, 2_000);
    boundedText(resolvedComponent.caption, `A2UI Plot component ${component.id} caption`, 2_000);
    let totalPoints = 0;
    for (const [seriesIndex, item] of series.entries()) {
      plainObject(item, `A2UI Plot series ${seriesIndex + 1}`);
      if (item.id !== undefined) boundedId(item.id, `A2UI Plot series ${seriesIndex + 1} id`);
      boundedText(item.label, `A2UI Plot series ${seriesIndex + 1} label`);
      if (!Array.isArray(item.points) || item.points.length === 0 || item.points.length > MAX_PLOT_POINTS_PER_SERIES) {
        throw protocolError(`A2UI Plot series ${seriesIndex + 1} requires between 1 and ${MAX_PLOT_POINTS_PER_SERIES} points.`);
      }
      totalPoints += item.points.length;
      for (const [pointIndex, point] of item.points.entries()) {
        if (!Array.isArray(point) || point.length !== 2) throw protocolError(`A2UI Plot point ${seriesIndex + 1}:${pointIndex + 1} must be [x, y].`);
        finiteNumber(point[0], `A2UI Plot x value ${seriesIndex + 1}:${pointIndex + 1}`);
        finiteNumber(point[1], `A2UI Plot y value ${seriesIndex + 1}:${pointIndex + 1}`);
      }
    }
    if (totalPoints > MAX_PLOT_POINTS) throw protocolError(`A2UI Plot component ${component.id} exceeds ${MAX_PLOT_POINTS} total points.`);
    for (const [axisName, values] of [["x", series.flatMap((item) => item.points.map((point) => point[0]))], ["y", series.flatMap((item) => item.points.map((point) => point[1]))]]) {
      const axis = resolvedComponent[axisName];
      if (axis !== undefined) plainObject(axis, `A2UI Plot ${component.id} ${axisName} axis`);
      boundedText(axis?.label, `A2UI Plot ${component.id} ${axisName} axis label`);
      boundedText(axis?.unit, `A2UI Plot ${component.id} ${axisName} axis unit`);
      if (axis?.min !== undefined) finiteNumber(axis.min, `A2UI Plot ${component.id} ${axisName} axis min`);
      if (axis?.max !== undefined) finiteNumber(axis.max, `A2UI Plot ${component.id} ${axisName} axis max`);
      const dataMin = Math.min(...values);
      const dataMax = Math.max(...values);
      const effectiveMin = axis?.min ?? dataMin;
      const effectiveMax = axis?.max ?? dataMax;
      if ((axis?.min !== undefined || axis?.max !== undefined) && effectiveMin >= effectiveMax) {
        throw protocolError(`A2UI Plot ${component.id} ${axisName} axis min must be less than max and contain a usable range.`);
      }
    }
  }

  if (component.component === "Params") {
    if (!Array.isArray(component.controls) || component.controls.length === 0 || component.controls.length > MAX_PARAMETER_CONTROLS) {
      throw protocolError(`A2UI Params component ${component.id} requires between 1 and ${MAX_PARAMETER_CONTROLS} controls.`);
    }
    for (const [controlIndex, control] of component.controls.entries()) {
      plainObject(control, `A2UI parameter control ${controlIndex + 1}`);
      boundedId(control.id, `A2UI parameter control ${controlIndex + 1} id`);
      boundedText(control.label, `A2UI parameter control ${control.id} label`);
      boundedText(control.unit, `A2UI parameter control ${control.id} unit`);
      const min = finiteNumber(control.min, `A2UI parameter control ${control.id} min`);
      const max = finiteNumber(control.max, `A2UI parameter control ${control.id} max`);
      const value = finiteNumber(control.value, `A2UI parameter control ${control.id} value`);
      if (min >= max || value < min || value > max) throw protocolError(`A2UI parameter control ${control.id} has invalid bounds or value.`);
      if (control.step !== undefined && (!Number.isFinite(control.step) || control.step <= 0)) throw protocolError(`A2UI parameter control ${control.id} step must be positive.`);
      if (control.path !== undefined) pointerSegments(control.path, `A2UI parameter control ${control.id} path`);
      if (control.frames !== undefined) {
        if (!Array.isArray(control.frames) || control.frames.length === 0 || control.frames.length > MAX_PARAMETER_FRAMES) {
          throw protocolError(`A2UI parameter control ${control.id} frames must contain between 1 and ${MAX_PARAMETER_FRAMES} entries.`);
        }
        for (const [frameIndex, frame] of control.frames.entries()) {
          plainObject(frame, `A2UI parameter frame ${control.id}:${frameIndex + 1}`);
          const frameValue = finiteNumber(frame.value, `A2UI parameter frame ${control.id}:${frameIndex + 1} value`);
          if (frameValue < min || frameValue > max) throw protocolError(`A2UI parameter frame ${control.id}:${frameIndex + 1} is outside the control bounds.`);
          if (!Array.isArray(frame.updates) || frame.updates.length === 0 || frame.updates.length > MAX_FRAME_UPDATES) {
            throw protocolError(`A2UI parameter frame ${control.id}:${frameIndex + 1} requires between 1 and ${MAX_FRAME_UPDATES} updates.`);
          }
          for (const [updateIndex, update] of frame.updates.entries()) {
            plainObject(update, `A2UI parameter frame update ${control.id}:${frameIndex + 1}:${updateIndex + 1}`);
            pointerSegments(update.path, `A2UI parameter frame update ${control.id}:${frameIndex + 1}:${updateIndex + 1} path`);
          }
        }
      }
    }
  }
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
  for (const component of Object.values(components)) validateLearningComponent(surface, component);
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
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.keys(value).length === 1 && typeof value.path === "string") {
    if (value.path === "" || value.path === "/") return dataModel;
    const segments = pointerSegments(value.path, "A2UI data binding path");
    let resolved = dataModel;
    for (const segment of segments) resolved = resolved?.[segment];
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveDataBinding(item, dataModel));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDataBinding(item, dataModel)]));
}

export function applyParameterFrame(current, componentId, controlId, requestedValue) {
  const canvas = clone(current);
  const surface = activeSurface(canvas);
  const component = surface?.components?.[componentId];
  if (!component || component.component !== "Params" || !Array.isArray(component.controls)) return null;
  const control = component.controls.find((candidate) => candidate.id === controlId);
  if (!control || !Number.isFinite(requestedValue)) return null;
  const value = Math.min(control.max, Math.max(control.min, requestedValue));
  control.value = value;
  if (control.path) updateDataModel(surface, control.path, value);
  if (Array.isArray(control.frames) && control.frames.length) {
    const frame = control.frames.reduce((nearest, candidate) => (
      Math.abs(candidate.value - value) < Math.abs(nearest.value - value) ? candidate : nearest
    ));
    for (const update of frame.updates) updateDataModel(surface, update.path, update.value);
  }
  validateCanvas(canvas);
  return canvas;
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
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: { ...(stage.dataModel && typeof stage.dataModel === "object" && !Array.isArray(stage.dataModel) ? clone(stage.dataModel) : {}), title: stage.title || topic } } },
  ]);
}
