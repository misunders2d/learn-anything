import process from "node:process";

export function watchOwnerProcess({
  ownerPid = process.ppid,
  currentParentPid = () => process.ppid,
  intervalMs = 500,
  onOwnerExit,
} = {}) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("ownerPid must be a positive integer.");
  if (typeof onOwnerExit !== "function") throw new Error("onOwnerExit is required.");
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || currentParentPid() === ownerPid) return;
    stopped = true;
    clearInterval(timer);
    void onOwnerExit();
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
