import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ensurePilot, PILOT_INSTRUCTION } from "../cli/lib/pilot.ts";

const CONTROL = "agent-control";
const state = (s: string): ExecRule => s === "none"
  ? { match: "-- hc get agent", code: 1, stderr: "no such terminal" }
  : s === "exited"
    ? { match: "-- hc get agent", stdout: '{"state":"finished","exit_code":0,"status":null}' }
    : { match: "-- hc get agent", stdout: `{"argv":["/usr/local/bin/forge-agent"],"state":"live","status":{"state":"${s}"}}` };

// `hc get agent` rend `initial`, puis `idle` une fois `hc run` passé.
function setup(rules: ExecRule[]) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", CONTROL, { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules });
  const inner = ctx.exec;
  let started = false;
  ctx.exec = async (argv, opts) => {
    const line = argv.join(" ");
    if (line.includes("-- hc run ")) started = true;
    if (started && line.includes("-- hc get agent")) {
      ctx.calls.push(argv);
      return { code: 0, stdout: '{"argv":["/usr/local/bin/forge-agent"],"state":"live","status":{"state":"idle"}}', stderr: "" };
    }
    return inner(argv, opts);
  };
  return ctx;
}
const runs = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" ")).filter((c) => c.includes("-- hc run "));

test("no agent terminal in the control: ensurePilot starts forge-agent in /workspace, with the Pilot's instruction", async () => {
  const ctx = setup([state("none")]);
  assert.equal(await ensurePilot(ctx), "started");
  const [run] = runs(ctx);
  assert.ok(run.includes(`exec ${CONTROL} `) && run.includes("--name agent --cwd /workspace ") && run.includes("forge-agent"), run);
  const push = ctx.calls.map((c) => c.join(" ")).find((c) => c.includes("file push"))!;
  assert.ok(push.includes(`${CONTROL}/home/aiuser/.forge/instruction.md`), push);
  assert.ok(PILOT_INSTRUCTION.startsWith("[forge] You are the Pilot of this project."));
});

test("Review Focus 4: a working session is left alone; fresh starts one anyway", async () => {
  const ctx = setup([state("working")]);
  assert.equal(await ensurePilot(ctx), "running");
  assert.deepEqual(runs(ctx), []);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("hc kill")));
  const fresh = setup([state("working")]);
  assert.equal(await ensurePilot(fresh, { fresh: true }), "started");
  assert.equal(runs(fresh).length, 1);
});

test("Review Focus 2: an exited session is replaced", async () => {
  const ctx = setup([state("exited")]);
  assert.equal(await ensurePilot(ctx), "started");
  assert.equal(runs(ctx).length, 1);
});
