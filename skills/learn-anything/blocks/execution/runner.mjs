import { runContainerCode } from "./container-runner.mjs";
import { availableRunners, runCode as runHostCode } from "./host-runner.mjs";

export function selectExecution(capabilities, { mode = "host" } = {}) {
  if (mode === "container") {
    if (!capabilities?.containerRuntime) {
      throw new Error("Container execution was requested, but Docker or Podman is unavailable.");
    }
    return {
      mode: "container",
      runtime: capabilities.containerRuntime,
      blockId: "execution.container",
      degraded: [],
    };
  }
  if (mode !== "host") throw new Error(`Unknown execution mode: ${mode}`);
  return {
    mode: "host",
    runtime: null,
    blockId: "execution.host-fixed-runners",
    degraded: ["host-execution-full-user-permissions"],
  };
}

export function selectedRunners(execution) {
  if (execution?.mode === "container") {
    return { javascript: true, python: true, java: true, rust: true, c: true, sqlite: true };
  }
  return availableRunners();
}

export function runSelectedCode({ execution, ...request } = {}) {
  if (execution?.mode === "container") {
    return runContainerCode({ runtime: execution.runtime, ...request });
  }
  return runHostCode(request);
}
