// Accessing the browser's storage property itself may throw (private/blocked storage).
// A per-page fallback preserves drafts and preferences while persistence is unavailable.
const memory = new Map();
export function safeStorage(host = globalThis.window) {
  return {
    getItem(key) {
      try { return host?.localStorage?.getItem(key) ?? memory.get(key) ?? null; }
      catch { return memory.get(key) ?? null; }
    },
    setItem(key, value) {
      memory.set(key, String(value));
      try { host?.localStorage?.setItem(key, String(value)); } catch { /* Keep the per-page copy. */ }
    },
    removeItem(key) {
      memory.delete(key);
      try { host?.localStorage?.removeItem(key); } catch { /* Storage may be disabled. */ }
    },
  };
}
