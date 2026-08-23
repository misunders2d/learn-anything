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

export function shouldReleaseRescue(canvas, rescuedSurfaceId) {
  if (!rescuedSurfaceId) return false;
  return canvas?.focus === "chat"
    || Boolean(canvas?.activeSurfaceId && canvas.activeSurfaceId !== rescuedSurfaceId);
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
