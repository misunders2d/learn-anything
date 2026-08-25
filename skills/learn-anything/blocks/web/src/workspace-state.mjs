import { resolveDataBinding } from "../../a2ui/state.mjs";

export function canvasComponents(canvas) {
  const surface = canvas?.activeSurfaceId ? canvas.surfaces?.[canvas.activeSurfaceId] : null;
  return surface ? Object.values(surface.components || {}) : [];
}

export function resolveFocus(canvas) {
  if (canvas?.focus === "chat" || canvas?.focus === "work") return canvas.focus;
  const interactive = canvasComponents(canvas).some((component) => (
    (component?.component === "Code" && component.runnable !== false)
    || component?.component === "Quiz"
    || component?.component === "Checklist"
  ));
  return interactive ? "work" : "chat";
}

export function shouldReleaseRescue(canvas, rescuedSurfaceId, mentorReplyCompleted = false) {
  if (!rescuedSurfaceId) return false;
  return (mentorReplyCompleted && canvas?.focus === "work")
    || Boolean(canvas?.activeSurfaceId && canvas.activeSurfaceId !== rescuedSurfaceId);
}

function firstLearnerComponent(surface, componentId, seen = new Set()) {
  if (!componentId || seen.has(componentId)) return null;
  seen.add(componentId);
  const component = surface?.components?.[componentId];
  if (!component) return null;
  if (component.component === "Column" || component.component === "Row") {
    for (const childId of Array.isArray(component.children) ? component.children : []) {
      const found = firstLearnerComponent(surface, childId, seen);
      if (found) return found;
    }
    return null;
  }
  return component;
}

export function firstLearnerComponentId(canvas) {
  const surfaceId = canvas?.activeSurfaceId || "";
  const surface = surfaceId ? canvas?.surfaces?.[surfaceId] : null;
  return firstLearnerComponent(surface, "root")?.id || "";
}

export function workTaskKey(canvas) {
  const surfaceId = canvas?.activeSurfaceId || "";
  const surface = surfaceId ? canvas?.surfaces?.[surfaceId] : null;
  if (!surface) return "";
  const root = surface.components?.root;
  const first = firstLearnerComponent(surface, "root");
  const firstPrompt = resolveDataBinding(
    first?.title ?? first?.question ?? first?.content ?? first?.text ?? "",
    surface.dataModel || {},
  );
  return JSON.stringify([
    surfaceId,
    surface.dataModel?.title || "",
    root?.children || [],
    first?.component || "",
    firstPrompt,
  ]);
}

export function connectionIssueFor(error) {
  if (error?.status === 401) {
    return {
      title: "This tab belongs to an earlier workspace",
      message: "Use the newest Learn Anything tab opened by your coding agent. Your saved work is still safe.",
    };
  }
  if (error instanceof TypeError || /failed to fetch/i.test(error?.message || "")) {
    return {
      title: "Workspace stopped",
      message: "Your work is saved locally. Restart the workspace from your coding agent, then reload this page.",
    };
  }
  return {
    title: "Connection lost",
    message: "Your work is saved locally. Restart the workspace from your coding agent, then reload this page.",
  };
}
