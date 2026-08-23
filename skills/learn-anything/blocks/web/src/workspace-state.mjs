export function stageComponents(stage) {
  if (Array.isArray(stage?.components)) return stage.components;
  return stage ? [stage] : [];
}

export function resolveFocus(stage) {
  if (stage?.focus === "chat" || stage?.focus === "work") return stage.focus;
  const interactive = stageComponents(stage).some((component) => (
    (component?.type === "code" && component.runnable !== false)
    || component?.type === "quiz"
    || component?.type === "checklist"
  ));
  return interactive ? "work" : "chat";
}

export function shouldReleaseRescue(stage, rescuedSurfaceId) {
  if (!rescuedSurfaceId) return false;
  return stage?.focus === "chat"
    || Boolean(stage?.surfaceId && stage.surfaceId !== rescuedSurfaceId);
}
