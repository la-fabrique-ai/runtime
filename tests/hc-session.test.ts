import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { hcArgv, typeNotice, INSTRUCTION_PATH, sessionState, startSession } from "../cli/lib/hc-session.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV = "agent-executor-1";

function setup(rules: ExecRule[] = []) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", DEV, { status: "Running" });
  return { fake, ctx: fakeContext({ incus: fake, rules }) };
}

test("hcArgv runs hc as the agent, in /workspace, with the core's session bus", () => {
  assert.deepEqual(hcArgv(DEV, ["get", "agent"]), [
    "incus", "--project", "agent-forge", "exec", DEV,
    "--user", "1001", "--group", "1001", "--cwd", "/workspace",
    "--env", "HOME=/home/aiuser",
    "--env", "XDG_RUNTIME_DIR=/run/user/1001",
    "--env", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus",
    "--", "hc", "get", "agent",
  ]);
});

test("startSession: old session removed, instruction pushed as a file, then hc run; the text is in no argv", async () => {
  const { fake, ctx } = setup();
  const text = "Corrige le login $(id) 'quoted'";
  await startSession(ctx, { name: DEV }, "fix-login", text);
  const calls = ctx.calls.map((c) => c.join(" "));
  const kill = calls.findIndex((c) => c.endsWith("-- hc kill agent"));
  const rm = calls.findIndex((c) => c.endsWith("-- hc rm agent"));
  const push = calls.findIndex((c) => c.includes("file push") && c.includes("/home/aiuser/.forge/instruction.md"));
  const run = calls.findIndex((c) => c.includes("-- hc run --bg --name agent "));
  assert.ok(kill >= 0 && rm > kill && push > rm && run > push, calls.join("\n"));
  assert.ok(calls[run].includes(`forge-agent --forge-task ${DEV}-fix-login `), calls[run]);
  // Herdr App ne montre que les terminaux qui portent ces deux étiquettes.
  assert.ok(calls[run].includes("--label herdr.space=forge --label herdr.tab=agent "), calls[run]);
  const file = fake.files.get(`agent-forge/${DEV}/home/aiuser/.forge/instruction.md`)!;
  assert.deepEqual([file.content, file.uid, file.mode], [text, "1001", "600"]);
  assert.ok(!ctx.calls.some((c) => c.some((a) => a.includes("Corrige"))));
});

// Le lien entre les deux côtés : l'argv que startSession donne à forge-agent est
// lu par le vrai lanceur (le fichier de consigne remplacé par un fichier local),
// devant un faux claude qui affiche ce qu'il reçoit.
test("startSession's forge-agent arguments are the ones the launcher reads: the instruction reaches claude", async () => {
  const { ctx } = setup();
  await startSession(ctx, { name: DEV }, "fix-login", "unused");
  const run = ctx.calls.find((c) => c.includes("forge-agent"))!;
  const dir = mkdtempSync(join(tmpdir(), "forge-agent-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "claude"), '#!/bin/bash\necho "$*"\n', { mode: 0o755 });
    writeFileSync(join(dir, "token"), "tok\n");
    writeFileSync(join(dir, "instruction"), "Fais X");
    const args = run.slice(run.indexOf("forge-agent") + 1)
      .map((a) => (a === INSTRUCTION_PATH ? join(dir, "instruction") : a));
    const r = spawnSync("bash", [join(import.meta.dirname, "..", "container", "forge-agent"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FORGE_TOKEN_FILE: join(dir, "token") },
    });
    assert.equal(r.stdout.trim(), "--permission-mode auto Fais X", r.stderr);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("startSession refuses a session whose agent stops as soon as it starts", async () => {
  const { ctx } = setup([{ match: "hc get agent", stdout: '{"state":"finished","reason":"exited","exit_code":1,"status":null}' }]);
  await assert.rejects(startSession(ctx, { name: DEV }, "fix-login", "Corrige"),
    /agent-executor-1's agent stopped as soon as it started \(exit code 1\)/);
});

test("startSession: a task without a branch is marked <container>-session; a failing kill is ignored", async () => {
  const { ctx } = setup([{ match: "hc kill agent", code: 1 }, { match: "hc rm agent", code: 1 }]);
  await startSession(ctx, { name: DEV }, null, "Relis");
  assert.ok(ctx.calls.some((c) => c.join(" ").includes(`--forge-task ${DEV}-session `)));
});

test("startSession runs the agent in the given folder (an executor's clone), /workspace by default", async () => {
  const { ctx } = setup();
  await startSession(ctx, { name: DEV }, "T-1-1", "Fais", { cwd: "/workspace/web" });
  const run = ctx.calls.map((c) => c.join(" ")).find((c) => c.includes("-- hc run "))!;
  assert.ok(run.includes("hc run --bg --name agent --cwd /workspace/web "), run);
});

test("sessionState maps hc get to a state", async () => {
  const get = (rule: ExecRule) => sessionState(setup([rule]).ctx, DEV);
  assert.equal(await get({ match: "hc get agent", stdout: '{"argv":["/usr/local/bin/forge-agent"],"status":{"app":"claude-code","state":"working"}}' }), "working");
  assert.equal(await get({ match: "hc get agent", stdout: '{"argv":["forge-agent","--forge-task","t"],"status":{"state":"done"}}' }), "done");
  // Un terminal gardé par hc, relancé en shell après un redémarrage : pas une session.
  assert.equal(await get({ match: "hc get agent", stdout: '{"argv":["/bin/bash"],"keep":true,"state":"live","status":null}' }), "lost");
  assert.equal(await get({ match: "hc get agent", stdout: '{"state":"live","status":{"state":"idle"}}' }), "lost");
  // forge-agent sans statut : il démarre, rien ne dit encore qu'il vit.
  assert.equal(await get({ match: "hc get agent", stdout: '{"argv":["forge-agent"],"state":"live","status":null}' }), "unknown");
  assert.equal(await get({ match: "hc get agent", code: 1 }), "none");
  // Un terminal dont le programme est sorti : hc le garde, sans statut.
  assert.equal(await get({ match: "hc get agent", stdout: '{"state":"finished","reason":"exited","exit_code":1,"status":null}' }), "exited");
  assert.equal(await get({ match: "hc get agent", stdout: "not json" }), "unknown");
});

// typeNotice : un faux hc dont les réponses se suivent dans l'ordre.
function scriptedSend(fake: FakeIncus, replies: { code: number; stdout?: string; stderr?: string }[]) {
  const ctx = fakeContext({ incus: fake });
  const sleeps: number[] = [];
  ctx.sleep = async (ms) => { sleeps.push(ms); };
  const inner = ctx.exec;
  const sends: string[][] = [];
  ctx.exec = async (argv, opts) => {
    if (argv.includes("send")) {
      sends.push(argv);
      ctx.calls.push(argv);
      const r = replies.shift()!;
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return inner(argv, opts);
  };
  return { ctx, sleeps, sends };
}

const LEAD = "agent-executor-2";
const OK = { code: 0, stdout: '{"turn":3,"status":"working","started":true}' };

function withLead() {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", LEAD, { status: "Running" });
  return fake;
}

test("typeNotice types forge's line as a single argv element", async () => {
  const { ctx, sends } = scriptedSend(withLead(), [OK]);
  assert.equal(await typeNotice(ctx, LEAD, "[forge] memory: killed pid 7"), 3);
  assert.deepEqual(sends[0].slice(sends[0].indexOf("hc")), ["hc", "send", "--json", "agent", "[forge] memory: killed pid 7"]);
});

test("typeNotice retries while hc says the terminal is still starting", async () => {
  const starting = { code: 1, stderr: "error: t1 is still starting: its output has not settled" };
  const fake = withLead();
  const { ctx, sleeps, sends } = scriptedSend(fake, [starting, starting, OK]);
  await typeNotice(ctx, LEAD, "Fini");
  assert.equal(sends.length, 3);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("typeNotice gives up after ten attempts, and refuses a finished terminal", async () => {
  const starting = { code: 1, stderr: "error: t1 is still starting: its output has not settled" };
  const a = scriptedSend(withLead(), Array(10).fill(starting));
  await assert.rejects(typeNotice(a.ctx, LEAD, "Fini"), /delivery to agent-executor-2 failed: error: t1 is still starting/);
  assert.equal(a.sends.length, 10);
  const b = scriptedSend(withLead(), [{ code: 1, stderr: "error: t1 has finished" }]);
  await assert.rejects(typeNotice(b.ctx, LEAD, "Fini"), /agent-executor-2 has no live session/);
  // Ce que hc écrit vraiment avec --json : l'erreur est du JSON sur stdout.
  const finished = { code: 11, stdout: '{"error":{"hint":"hc read t2","kind":"finished","message":"t2 has finished"}}' };
  await assert.rejects(typeNotice(scriptedSend(withLead(), [finished]).ctx, LEAD, "Fini"), /agent-executor-2 has no live session/);
  const startingJson = { code: 1, stdout: '{"error":{"kind":"starting","message":"t1 is still starting: its output has not settled"}}' };
  const c = scriptedSend(withLead(), [startingJson, OK]);
  assert.equal(await typeNotice(c.ctx, LEAD, "Fini"), 3);
  assert.equal(c.sleeps.length, 1);
});
