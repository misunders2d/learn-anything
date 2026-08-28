import { ACTION_TYPES, concreteAction } from "../continuation.mjs";

const DEFAULT_CHAT_QUESTION = "What would you like to explore next?";
const A2UI_VERSION = "v0.9";

function text(value, max = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function question(value) {
  const normalized = text(value, 1_000) || DEFAULT_CHAT_QUESTION;
  return normalized.endsWith("?") ? normalized : `${normalized.replace(/[.!]+$/, "")}?`;
}

function action(value, saved) {
  return concreteAction(value, { fallback: saved, max: 280 });
}

function surfaceOperation(operation, index) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(`Surface operation ${index + 1} must be an object.`);
  }
  const surfaceId = text(operation.surface_id, 200);
  if (!surfaceId) throw new Error(`Surface operation ${index + 1} requires surface_id.`);
  if (operation.kind === "create_surface") {
    return {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: text(operation.catalog_id, 500) || "urn:learn-anything:catalog:v1",
      },
    };
  }
  if (operation.kind === "update_components") {
    if (!Array.isArray(operation.components) || operation.components.length === 0) {
      throw new Error(`Surface operation ${index + 1} requires components.`);
    }
    return {
      version: A2UI_VERSION,
      updateComponents: { surfaceId, components: operation.components },
    };
  }
  if (operation.kind === "update_data_model") {
    const path = text(operation.path, 500);
    if (!path.startsWith("/")) throw new Error(`Surface operation ${index + 1} requires an absolute data-model path.`);
    if (!("value" in operation)) throw new Error(`Surface operation ${index + 1} requires value.`);
    return {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId, path, value: operation.value },
    };
  }
  if (operation.kind === "delete_surface") {
    return { version: A2UI_VERSION, deleteSurface: { surfaceId } };
  }
  throw new Error(`Surface operation ${index + 1} has invalid kind.`);
}

export function composeSurfacePlan(plan) {
  if (plan === undefined || plan === null) return [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.operations)) {
    throw new Error("surface_plan must contain an operations array.");
  }
  if (plan.operations.length > 100) throw new Error("surface_plan supports at most 100 operations.");
  return plan.operations.map(surfaceOperation);
}

function explicitAnchor(item, session) {
  return item?.type === "user_message"
    && item.message?.source === "work"
    && Boolean(item.message?.context?.componentId)
    && Boolean(session?.canvas?.activeSurfaceId);
}

function automaticActivity(item, session) {
  return ["execution_result", "stage_action"].includes(item?.type)
    && Boolean(session?.canvas?.activeSurfaceId);
}

function targetContext(item, candidate) {
  const componentId = text(candidate?.target_component_id, 200)
    || text(item?.message?.context?.componentId, 200)
    || text(item?.componentId, 200);
  if (!componentId) return null;
  const quote = text(candidate?.target_quote, 2_000);
  const label = text(item?.message?.context?.label, 200)
    || (item?.type === "execution_result" ? `${item.language || "code"} code` : "");
  return {
    componentId,
    ...(quote ? { quote } : {}),
    ...(label ? { label } : {}),
  };
}

export function plainTextMentorCandidate(message) {
  const value = text(message);
  if (!value) throw new Error("Pi returned neither a completed mentor tool call nor learner-facing text.");
  return {
    message: value,
    presentation: "chat",
    continuation: { kind: "none", text: "" },
    surface_plan: null,
    target_component_id: null,
    target_quote: null,
  };
}

export function reconcileMentorTurn(item, candidate, session, { runId } = {}) {
  const message = text(candidate?.message);
  if (!message) throw new Error("Mentor turn requires a learner-facing message.");
  let messages = composeSurfacePlan(candidate?.surface_plan);
  const anchored = explicitAnchor(item, session);
  const automatic = automaticActivity(item, session);
  let presentation = ["chat", "inline", "activity"].includes(candidate?.presentation)
    ? candidate.presentation
    : "chat";

  if (anchored) presentation = "inline";
  if (automatic) presentation = "activity";
  if (presentation === "inline" && !anchored) presentation = "chat";
  if (presentation === "activity" && messages.length === 0 && !session?.canvas?.activeSurfaceId) presentation = "chat";
  if (presentation === "inline") messages = [];

  const focus = presentation === "chat" ? "chat" : "work";
  const requestedKind = candidate?.continuation?.kind;
  const requestedText = candidate?.continuation?.text;
  const requestedActionType = candidate?.continuation?.action_type;
  const context = targetContext(item, candidate);
  const currentSurface = session?.canvas?.activeSurfaceId ? session.canvas.surfaces?.[session.canvas.activeSurfaceId] : null;
  const taskTitle = presentation === "activity"
    ? text(candidate?.task_title, 120)
    : presentation === "inline"
      ? text(currentSurface?.dataModel?.title, 120)
      : "";
  if (focus === "work" && !taskTitle) {
    throw new Error("Work mentor turn requires one localized task_title shared by the title, artifact, and action.");
  }
  if (focus === "work" && !context?.componentId) {
    throw new Error("Work mentor turn requires one target_component_id for the visible current task.");
  }
  const actionType = focus === "work"
    ? (ACTION_TYPES.includes(requestedActionType)
      ? requestedActionType
      : presentation === "inline" && ACTION_TYPES.includes(session?.continuation?.actionType)
        ? session.continuation.actionType
        : "")
    : "";
  if (focus === "work" && !actionType) {
    throw new Error(`Work mentor turn requires continuation.action_type: ${ACTION_TYPES.join(", ")}.`);
  }
  const continuation = focus === "chat"
    ? { kind: "question", text: question(requestedKind === "question" ? requestedText : "") }
    : {
        kind: "action",
        text: action(
          requestedKind === "action" ? requestedText : "",
          presentation === "inline" && session?.continuation?.kind === "action" ? session.continuation.text : "",
        ),
        taskTitle,
        targetComponentId: context.componentId,
        actionType,
      };

  return {
    turnId: item?.mentorTurn?.id,
    baseRevision: item?.mentorTurn?.baseRevision,
    runId: runId || null,
    message,
    presentation,
    ...(taskTitle ? { taskTitle } : {}),
    focus,
    messages,
    continuation,
    context,
  };
}
