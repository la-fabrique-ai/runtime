import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ensurePilot, PILOT_INSTRUCTION } from "../cli/lib/pilot.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPilot, cmdPilotLaptop } from "../cli/lib/commands/pilot.ts";
import { saveHost } from "../cli/lib/laptop/state.ts";

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
  // Le Pilote parle à l'humain : il garde le mode auto.
  assert.ok(run.endsWith("--permission-mode auto"), run);
  const write = ctx.calls.map((c) => c.join(" ")).find((c) => c.includes("node -e") && c.endsWith("/home/aiuser/.forge/instruction.md"))!;
  assert.ok(write.includes(`exec ${CONTROL} --user 1001`), write);
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

test("a live session without a readable state (unknown) is left alone: the human's conversation is never cut", async () => {
  const ctx = setup([state("starting")]);
  assert.equal(await ensurePilot(ctx), "running");
  assert.deepEqual(runs(ctx), []);
});

test("Review Focus 2: an exited session is replaced", async () => {
  const ctx = setup([state("exited")]);
  assert.equal(await ensurePilot(ctx), "started");
  assert.equal(runs(ctx).length, 1);
});

// ---------------------------------------------------------------- forge pilot <ticket>


function withProject(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "forge-pilot-"));
    mkdirSync(join(home, "agent-forge"), { recursive: true });
    writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
      project: { repositories: { web: { repo: "o/web" }, api: { repo: "o/api" } }, executors: { count: 1 } },
    }));
    const saved = { x: process.env.XDG_CONFIG_HOME, h: process.env.FORGE_HOME, m: process.env.FORGE_MIRRORS };
    process.env.XDG_CONFIG_HOME = home;
    process.env.FORGE_HOME = home;
    process.env.FORGE_MIRRORS = join(home, "mirrors");
    try {
      await fn();
    } finally {
      for (const [k, v] of [["XDG_CONFIG_HOME", saved.x], ["FORGE_HOME", saved.h], ["FORGE_MIRRORS", saved.m]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const SENT: ExecRule = { match: "-- hc send --json agent", stdout: '{"turn":1}' };
const lines = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));

test("forge pilot T-3: the ticket asked to the channel, each mirror refreshed, then exactly one line in the Pilot's session", withProject(async () => {
  const ctx = setup([state("idle"), SENT]);
  assert.equal(await cmdPilot(ctx, ["T-3"], {}), 0);
  const l = lines(ctx);
  const ticket = l.findIndex((c) => c.includes(`exec ${CONTROL} --user 1001`) && c.endsWith("forge-team ticket T-3"));
  const web = l.findIndex((c) => c.startsWith("git ") && c.includes("repo-web.git"));
  const api = l.findIndex((c) => c.startsWith("git ") && c.includes("repo-api.git"));
  const send = l.findIndex((c) => c.includes("-- hc send --json agent"));
  assert.ok(ticket >= 0 && web > ticket && api > ticket && send > Math.max(web, api), l.join("\n"));
  assert.equal(ctx.calls[send].at(-1), "[forge] ticket T-3: the human opens it with you");
  assert.deepEqual(runs(ctx), []);
  assert.deepEqual(ctx.out_lines.at(-1), "The Pilot is on T-3: talk to it in its terminal (forge open, or its Herdr App machine).");
}));

test("Review Focus 1: a ticket the channel does not know is refused before any git call; a bad id is a usage error", withProject(async () => {
  const ctx = setup([{ match: "forge-team ticket T-9", code: 1, stderr: "forge-team: ticket T-9 not found\n" }]);
  await assert.rejects(cmdPilot(ctx, ["T-9"], {}), /^ForgeError: ticket T-9: forge-team: ticket T-9 not found$|ticket T-9: forge-team: ticket T-9 not found/);
  assert.ok(!lines(ctx).some((c) => c.startsWith("git ")), lines(ctx).join("\n"));
  await assert.rejects(cmdPilot(setup([]), ["nope"], {}), /usage: forge pilot <ticket>/);
}));

test("Review Focus 2: with a dead Pilot session, hc run comes before hc send", withProject(async () => {
  const ctx = setup([state("exited"), SENT]);
  await cmdPilot(ctx, ["T-3"], {});
  const l = lines(ctx);
  const run = l.findIndex((c) => c.includes("-- hc run "));
  const send = l.findIndex((c) => c.includes("-- hc send "));
  assert.ok(run >= 0 && send > run, l.join("\n"));
}));

test("from the laptop, the command sent over SSH is forge pilot T-3 --fresh", withProject(async () => {
  saveHost({ name: "forge-local", kind: "remote", address: "203.0.113.10", port: 22, user: "u", admin: "ubuntu", adminKey: "/k", exposure: "public", done: [] });
  const ctx = fakeContext();
  await cmdPilotLaptop(ctx, ["T-3"], { fresh: true });
  assert.ok(lines(ctx).some((c) => c.endsWith("'forge' 'pilot' 'T-3' '--fresh'")), lines(ctx).join("\n"));
}));

test("forge pilot brings the control's clones up to date as aiuser, after the mirrors; a failure is a warning", withProject(async () => {
  const ctx = setup([state("idle"), SENT]);
  await cmdPilot(ctx, ["T-3"], {});
  const l = lines(ctx);
  const mirror = l.findLastIndex((c) => c.startsWith("git ") && c.includes("repo-api.git"));
  for (const repo of ["web", "api"]) {
    const fetch = l.findIndex((c) => c.includes(`exec ${CONTROL} --user 1001`) && c.endsWith(`git -C /workspace/${repo} fetch origin`));
    const checkout = l.findIndex((c) => c.includes(`exec ${CONTROL} --user 1001`) && c.endsWith(`git -C /workspace/${repo} checkout --detach origin/HEAD`));
    assert.ok(fetch > mirror && checkout > fetch, `${repo}\n${l.join("\n")}`);
  }
  const failing = setup([state("idle"), SENT, { match: "git -C /workspace/web fetch origin", code: 1, stderr: "fatal: nope" }]);
  assert.equal(await cmdPilot(failing, ["T-3"], {}), 0);
  assert.ok(failing.err_lines.some((x) => x.startsWith("WARNING:") && x.includes("/workspace/web")), failing.err_lines.join("\n"));
  assert.ok(lines(failing).some((c) => c.includes("-- hc send ")));
}));
