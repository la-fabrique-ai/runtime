import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import type { ExecOptions } from "../cli/lib/context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { cmdTeam, type TeamStatus } from "../cli/lib/commands/team.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-cmd-"));
  mkdirSync(join(home, "agent-forge"), { recursive: true });
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: { dev: { count: 2, capabilities: ["repo", "publish"] } } } },
  }));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.XDG_CONFIG_HOME = home;
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["XDG_CONFIG_HOME", "FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
});

const RULES: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
  { match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" },
];

function setup() {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules: RULES });
  return { fake, ctx };
}

test("assign reads the instruction from stdin and gives the task on behalf of the human", async () => {
  const { fake, ctx } = setup();
  const code = await cmdTeam(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "Corrige le login\n" });
  assert.equal(code, 0);
  const keys = fake.instances.get("agent-forge")!.get("agent-web-dev-1")!.config;
  assert.deepEqual([keys["user.forge.task"], keys["user.forge.assigned_by"]], ["fix-login", "human"]);
  assert.equal(fake.files.get("agent-forge/agent-web-dev-1/home/aiuser/.forge/instruction.md")!.content,
    "[forge] task fix-login from human\n\nCorrige le login");
});

test("an empty instruction is refused before any Incus call", async () => {
  const { ctx } = setup();
  await assert.rejects(() => cmdTeam(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "  \n" }), /instruction is empty/);
  assert.deepEqual(ctx.calls, []);
});

test("converge launches only the missing members and reports a stray one without deleting it", async () => {
  const { fake, ctx } = setup();
  fake.addInstance("agent-forge", "agent-web-dev-9", { status: "Stopped", config: { "user.forge.team": "web" } });
  await cmdTeam(ctx, ["converge"]);
  const launches = ctx.calls.filter((c) => c.includes("launch")).map((c) => c[c.indexOf("launch") + 2]);
  assert.deepEqual(launches, ["agent-web-dev-2"]);
  assert.ok(ctx.out_lines.some((l) => l.startsWith("agent-web-dev-9") && l.includes("not in the config, left as is")), ctx.out_lines.join("\n"));
  assert.ok(fake.instances.get("agent-forge")!.has("agent-web-dev-9"));
  assert.ok(!ctx.calls.some((c) => c.includes("delete")));
});

// Sorti, ou un terminal que hc a gardé et relancé en shell (redémarrage de la VM).
const DEAD_PILOT: [string, string][] = [
  ["it has exited", '{"state":"finished","reason":"exited","exit_code":1,"status":null}'],
  ["hc kept its terminal as a shell", '{"argv":["/bin/bash"],"keep":true,"state":"live","status":null}'],
];
for (const [why, dead] of DEAD_PILOT) test(`converge starts the pilot's session again when ${why}`, async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-pilot", { status: "Running" });
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  // La session du pilote est morte jusqu'au `hc run` qui la relance, puis vivante.
  const base = fakeContext({ incus: fake, rules: RULES });
  let ran = false;
  const ctx = { ...base, exec: async (argv: string[], o?: ExecOptions) => {
    const line = argv.join(" ");
    if (line.includes("agent-pilot") && line.endsWith("-- hc get agent")) {
      return { code: 0, stderr: "", stdout: ran ? '{"argv":["forge-agent"],"state":"live","status":{"state":"idle"}}'
        : dead };
    }
    if (line.includes("agent-pilot") && line.includes("-- hc run ")) ran = true;
    return base.exec(argv, o);
  } };
  await cmdTeam(ctx, ["converge"]);
  const runs = base.calls.map((c) => c.join(" ")).filter((c) => c.includes("hc run"));
  assert.equal(runs.length, 1, runs.join("\n"));
  assert.ok(runs[0].includes("agent-pilot") && runs[0].includes("--forge-task agent-pilot-session"), runs[0]);
  assert.ok(base.out_lines.includes("Started agent-pilot's session."), base.out_lines.join("\n"));
});

test("converge starts the session of a pilot it has just created", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules: [...RULES, { match: "-- hc get agent", code: 1 }] });
  await cmdTeam(ctx, ["converge"]);
  const calls = ctx.calls.map((c) => c.join(" "));
  const launch = calls.findIndex((c) => c.includes("launch") && c.includes("agent-pilot"));
  const run = calls.findIndex((c) => c.includes("hc run") && c.includes("--forge-task agent-pilot-session"));
  assert.ok(launch >= 0 && run > launch, calls.join("\n"));
});

const lead = "agent-web-lead";

// Une question ouverte du Lead au journal, comme `forge-team ask` la laisse.
function writeJournal(...lines: object[]): void {
  mkdirSync(join(home, ".local", "share", "agent-forge", "api"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "agent-forge", "api", "journal.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}
const ASK = { id: 7, time: new Date(Date.now() - 120_000).toISOString(), caller: lead, op: "ask-human", to: null, task: null, outcome: "ok", error: null, summary: "Quel séparateur ?", text: null };

test("status --json prints one TeamStatus object and nothing else on stdout", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: { lead: { capabilities: ["repo", "ask-human"] }, dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  writeJournal(ASK);
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", lead, { status: "Running", config: { "user.forge.task": "fix", "user.forge.assigned_by": "human" } });
  const ctx = fakeContext({ incus: fake, rules: [...RULES, { match: "-- hc get agent", code: 1 }] });
  await cmdTeam(ctx, ["status"], { json: true });
  assert.equal(ctx.out_lines.length, 1);
  const s = JSON.parse(ctx.out_lines[0]) as TeamStatus;
  assert.deepEqual(s.members.map((m) => [m.name, m.present, m.task, m.assignedBy, m.session, m.waitingOn]), [
    [lead, true, "fix", "human", "none", "human"],
    ["agent-web-dev-1", false, null, null, "none", null],
  ]);
  assert.deepEqual(s.inbox.map((q) => [q.id, q.from, q.summary]), [[7, lead, "Quel séparateur ?"]]);
  assert.deepEqual(s.mirrors, [{ team: "web", originAgeSeconds: null }]);
});

test("status --quick refreshes no mirror; without it the team mirror is refreshed", async () => {
  const quick = setup();
  await cmdTeam(quick.ctx, ["status"], { json: true, quick: true });
  assert.ok(!quick.ctx.calls.some((c) => c[0] === "git"), quick.ctx.calls.map((c) => c.join(" ")).join("\n"));
  const full = setup();
  await cmdTeam(full.ctx, ["status"], { json: true });
  assert.ok(full.ctx.calls.some((c) => c[0] === "git"), "the team mirror is refreshed (created) as before");
});

test("the text status has a WAITING column, the INBOX and the origin mirror's age; a control character in a summary is dropped", async () => {
  writeJournal({ ...ASK, summary: "Quel\u001b[2J séparateur ?" });
  const { ctx } = setup();
  await cmdTeam(ctx, ["status"], { quick: true });
  assert.match(ctx.out_lines[0], /^NAME\s+ROLE\s+TASK\s+SESSION\s+WAITING$/);
  assert.ok(ctx.out_lines.includes("INBOX"));
  assert.ok(ctx.out_lines.some((l) => l === `#7 ${lead} 2 min: Quel[2J séparateur ?`), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.some((l) => l === "web: origin mirror never synced"));
  assert.ok(!ctx.out_lines.join("\n").includes("\u001b"));
});

test("for-repo prints the team that holds the repository, and nothing (exit 1) for another", async () => {
  const { ctx } = setup();
  assert.equal(await cmdTeam(ctx, ["for-repo", "o/web"]), 0);
  assert.deepEqual(ctx.out_lines, ["web"]);
  const none = setup();
  assert.equal(await cmdTeam(none.ctx, ["for-repo", "o/none"]), 1);
  assert.deepEqual(none.ctx.out_lines, []);
});

test("task-base prints one sorted <task><TAB><base> line per owned task, dropping an unsafe ref", async () => {
  const { fake, ctx } = setup();
  const keys = (n: string) => fake.instances.get("agent-forge")!.get(n)!.config;
  Object.assign(keys("agent-web-dev-1"), { "user.forge.base.fix-login": "origin/main" });
  fake.addInstance("agent-forge", "agent-web-dev-2", {
    status: "Running", config: { "user.forge.base.export-csv": "origin/main", "user.forge.base.bad": "--upload-pack=x" },
  });
  assert.equal(await cmdTeam(ctx, ["task-base", "web"]), 0);
  assert.deepEqual(ctx.out_lines, ["export-csv\torigin/main", "fix-login\torigin/main"]);
});

test("upload-pack writes nothing to stdout, then attaches git upload-pack on the team mirror with hooks off", async () => {
  const { ctx } = setup();
  const code = await cmdTeam(ctx, ["upload-pack", "web", "/ignored/path"]);
  assert.equal(code, 0);
  assert.deepEqual(ctx.out_lines, []);
  assert.equal(ctx.attachCalls.length, 1);
  const argv = ctx.attachCalls[0].argv;
  assert.deepEqual(argv.slice(0, 4), ["git", "-c", "core.hooksPath=/dev/null", "upload-pack"]);
  assert.ok(argv[4].endsWith("team-web.agents.git") && argv.length === 5, argv.join(" "));
  await assert.rejects(() => cmdTeam(setup().ctx, ["upload-pack", "nope"]), /not a declared team/);
});

test("converge gives an existing member its API channel, then restarts the service; a failing restart only warns", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: {
      lead: { capabilities: ["repo", "assign"], talkTo: ["team"] },
      dev: { capabilities: ["repo", "publish"], talkTo: ["lead"] },
    } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-lead", { status: "Running" });
  fake.addInstance("agent-forge", "agent-web-dev", { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules: [...RULES, { match: "systemctl", code: 1, stderr: "no bus\n" }] });
  assert.equal(await cmdTeam(ctx, ["converge"]), 0);
  const calls = ctx.calls.map((c) => c.join(" "));
  const adds = calls.flatMap((c, i) => (c.includes("config device add") && c.includes("forge-api") ? [i] : []));
  const restart = calls.indexOf("systemctl --user try-restart forge-api.service");
  assert.equal(adds.length, 2);
  assert.ok(restart > Math.max(...adds), calls.join("\n"));
  assert.ok(ctx.err_lines.some((l) => l.startsWith("WARNING: could not restart forge-api.service")));
});

test("converge updates an existing member's files; a live pilot is told its instructions changed, not killed, and only once", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-pilot", { status: "Running" });
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  const base = fakeContext({ incus: fake, rules: RULES });
  const ctx = { ...base, exec: async (argv: string[], o?: ExecOptions) => argv.join(" ").endsWith("-- hc get agent")
    ? { code: 0, stderr: "", stdout: '{"argv":["forge-agent"],"state":"live","status":{"state":"idle"}}' } : base.exec(argv, o) };
  const claudeMd = (name: string) => fake.files.get(`agent-forge/${name}/home/aiuser/.claude/CLAUDE.md`)?.content;

  await cmdTeam(ctx, ["converge"]);
  for (const name of ["agent-pilot", "agent-web-dev-1"]) {
    assert.match(claudeMd(name) ?? "", /forge-team status/, `${name} has no current CLAUDE.md`);
  }
  assert.ok(base.err_lines.some((l) => l.includes("agent-pilot's instructions changed") && l.includes("Herdr App") && l.includes("forge team up")), base.err_lines.join("\n"));
  assert.ok(!base.err_lines.some((l) => l.includes("hc-exec")), "the host's commands are not the human's");
  // Chaque mise à jour nomme son membre.
  assert.deepEqual(base.out_lines.filter((l) => l.startsWith("Updating ")), ["Updating agent-pilot...", "Updating agent-web-dev-1..."]);
  assert.ok(!base.calls.some((c) => c.join(" ").includes("-- hc kill") || c.join(" ").includes("-- hc run ")), "the live session is left alone");

  base.err_lines.length = 0;
  await cmdTeam(ctx, ["converge"]);
  assert.ok(!base.err_lines.some((l) => l.includes("instructions changed")), "nothing changed the second time");
});

// Les limites promises (celle du rôle, sinon celle du profil) contre la RAM moins la réserve de l'hôte.
const GIB = 2 ** 30;

test("converge warns, without refusing, when the members' limits add up to more than the RAM minus the reserve", async () => {
  // Deux membres sans limite de rôle : 75 % de 4 GiB chacun, soit 6 GiB.
  const { ctx } = setup();
  const code = await cmdTeam(ctx, ["converge"], { hostMemory: 4 * GIB });
  assert.equal(code, 0);
  const warning = ctx.err_lines.find((l) => l.startsWith("WARNING: the 2 members' memory limits add up to 6.0 GiB"));
  assert.ok(warning?.includes("4.0 GiB of RAM, 0.0 GiB kept for the host"), ctx.err_lines.join("\n"));
});

test("converge counts a role's own limit before the profile's, and reads the reserve the host keeps", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: { dev: { count: 2, capabilities: ["repo", "publish"], memory: "1GiB" } } } },
  }));
  const reserve = { match: "systemctl show -p MemoryMin --value", stdout: `${GIB / 2}\n` };
  const fake = FakeIncus.withRuntime();
  for (const n of ["agent-web-dev-1", "agent-web-dev-2"]) fake.addInstance("agent-forge", n, { status: "Running" });
  // 2 GiB promis ; 4 GiB moins 2 × 0,5 GiB (system.slice, user.slice) = 3 GiB : rien à dire.
  const fits = fakeContext({ incus: fake, rules: [...RULES, reserve] });
  await cmdTeam(fits, ["converge"], { hostMemory: 4 * GIB });
  assert.ok(!fits.err_lines.some((l) => l.includes("memory limits")), fits.err_lines.join("\n"));
  // Sur 2,5 GiB de RAM, il ne reste que 1,5 GiB.
  const tight = fakeContext({ incus: fake, rules: [...RULES, reserve] });
  await cmdTeam(tight, ["converge"], { hostMemory: 2.5 * GIB });
  assert.ok(tight.err_lines.some((l) => l.includes("add up to 2.0 GiB, more than the 1.5 GiB")), tight.err_lines.join("\n"));
});
