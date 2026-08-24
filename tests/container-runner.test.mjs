import assert from "node:assert/strict";
import test from "node:test";
import { selectExecution } from "../skills/learn-anything/blocks/execution/runner.mjs";
import { containerPlan } from "../skills/learn-anything/blocks/execution/container-runner.mjs";

test("container plan confines learner code to a bounded writable workspace", () => {
  const plan = containerPlan({
    runtime: "docker",
    runner: "python",
    workDir: "/tmp/lesson run",
    uid: 1000,
    gid: 1000,
  });
  assert.equal(plan.command, "docker");
  assert.ok(plan.args.includes("--network"));
  assert.ok(plan.args.includes("none"));
  assert.ok(plan.args.includes("--read-only"));
  assert.ok(plan.args.includes("--cap-drop"));
  assert.ok(plan.args.includes("ALL"));
  assert.ok(plan.args.includes("--pids-limit"));
  assert.ok(plan.args.includes("128"));
  assert.ok(plan.args.includes("/tmp/lesson run:/workspace:rw"));
  assert.ok(plan.args.includes("1000:1000"));
  assert.equal(plan.args.at(-2), "python3");
  assert.equal(plan.args.at(-1), "playground.py");
});

test("container plan uses fixed compile commands for native runners", () => {
  const plan = containerPlan({ runtime: "podman", runner: "rust", workDir: "/tmp/rust" });
  assert.equal(plan.command, "podman");
  assert.equal(plan.args.at(-2), "-lc");
  assert.equal(plan.args.at(-1), "rustc playground.rs -o program && ./program");
  assert.equal(plan.args.some((arg) => arg.includes("${")), false);
});


test("execution selection defaults to available native runners even when a container exists", () => {
  assert.deepEqual(selectExecution({ containerRuntime: "docker" }), {
    mode: "host",
    runtime: null,
    blockId: "execution.host-fixed-runners",
    degraded: ["host-execution-full-user-permissions"],
  });
});

test("execution selection uses a container only when the agent requests it", () => {
  assert.deepEqual(selectExecution({ containerRuntime: "docker" }, { mode: "container" }), {
    mode: "container",
    runtime: "docker",
    blockId: "execution.container",
    degraded: [],
  });
  assert.throws(
    () => selectExecution({ containerRuntime: null }, { mode: "container" }),
    /Container execution was requested/,
  );
});

test("execution selection rejects unknown modes", () => {
  assert.throws(() => selectExecution({}, { mode: "virtual-machine" }), /Unknown execution mode/);
});