import { test } from "node:test";
import assert from "node:assert/strict";
// logic.js is a plain ES module with no import of the app's view library.
// @ts-expect-error: a JavaScript module, not typed
import { barText, shouldPoll, spaceRenames } from "../herdr/mods/forge/logic.js";

const host = (name: string, over: object = {}) =>
  ({ host: name, executors: { working: 0, idle: 0, free: 0 }, orchestrator: "active", error: null, ...over });

test("barText: counts summed over hosts; a stopped orchestrator and an unreachable host are named", () => {
  const report = { hosts: [
    host("a", { executors: { working: 1, idle: 0, free: 0 } }),
    host("b", { executors: { working: 1, idle: 1, free: 2 }, orchestrator: "failed" }),
  ] };
  assert.equal(barText(report), "forge: 2 working · 1 idle · 2 free · b: orchestrator failed");
  assert.equal(barText({ hosts: [host("down", { error: "no answer" })] }), "forge: down unreachable");
  assert.equal(barText({ hosts: [host("a")] }), "forge: quiet");
  assert.equal(barText({ hosts: [host("a\u0007", { orchestrator: "x\u001b" })] }), "forge: a: orchestrator x");
});

test("spaceRenames: an unnamed space of an agent's machine takes the agent's name; a named one and This computer are left", () => {
  const space = (machine: string | null, named: boolean, id = "s1") => ({ id, named, machine });
  assert.deepEqual(spaceRenames([space("forge-recette-executor-1", false)], ["forge-recette"]), [{ id: "s1", name: "executor-1" }]);
  assert.deepEqual(spaceRenames([space("forge-recette-executor-1", true), space(null, false), space("elsewhere-x", false)], ["forge-recette"]), []);
  // The longest host name wins.
  assert.deepEqual(spaceRenames([space("forge-recette-control", false)], ["forge", "forge-recette"]), [{ id: "s1", name: "control" }]);
});

test("shouldPoll: never while one runs, at most every 30 s", () => {
  assert.equal(shouldPoll(true, null, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 10_000, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 31_000, 1_000_000), true);
  assert.equal(shouldPoll(false, null, 1_000_000), true);
});
