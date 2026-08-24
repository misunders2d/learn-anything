const PREFIX = "learn-anything:draft:";

function storageKey(key) {
  return `${PREFIX}${key}`;
}

export function loadDraft(storage, key, fallback = "") {
  if (!storage) return fallback;
  try {
    const record = JSON.parse(storage.getItem(storageKey(key)) || "null");
    return typeof record?.value === "string" ? record.value : fallback;
  } catch {
    return fallback;
  }
}

export function saveDraft(storage, key, value) {
  if (!storage) return;
  storage.setItem(storageKey(key), JSON.stringify({ value, updatedAt: Date.now() }));
}

export function clearDraft(storage, key, expectedValue) {
  if (!storage) return false;
  const current = loadDraft(storage, key, null);
  if (current !== expectedValue) return false;
  storage.removeItem(storageKey(key));
  return true;
}
