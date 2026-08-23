export function createPartialMessage(event) {
  return {
    id: event.messageId,
    role: event.role || "assistant",
    content: "",
    ...(event.source ? { source: event.source } : {}),
    ...(event.surfaceId ? { surfaceId: event.surfaceId } : {}),
    ...(event.context ? { context: event.context } : {}),
  };
}

export function upsertMessage(messages, message) {
  return [...messages.filter((item) => item?.id !== message.id), message];
}

export function appendPartialDelta(partials, event) {
  const current = partials.get(event.messageId) || createPartialMessage(event);
  const pending = { ...current, content: `${current.content || ""}${event.delta || ""}` };
  partials.set(event.messageId, pending);
  return pending;
}

export function mergeSnapshotMessages(messages, partials) {
  let merged = Array.isArray(messages) ? messages : [];
  for (const pending of partials.values()) merged = upsertMessage(merged, pending);
  return merged;
}
