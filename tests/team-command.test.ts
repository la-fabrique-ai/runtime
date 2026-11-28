import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { cmdTeam } from "../cli/lib/commands/team.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-cmd-"));
  mkdirSync(join(home, "agent-forge"), { recursive: true });
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    project: { repositories: { web: { repo: "o/web" }, api: { repo: "o/API" } }, executors: { count: 2 } },
  }));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.XDG_CONFIG_HOME = home;
  // Un XDG_DATA_HOME de la machine l'emporterait sur FORGE_HOME.
  delete process.env.XDG_DATA_HOME;
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
];

// ---------------------------------------------------------------- un projet (forge à tickets)

const PROJECT = { project: { repositories: { web: { repo: "o/web" }, api: { repo: "o/API" } }, executors: { count: 2 } } };
// Aucun clone (ni donc de remote team) n'existe encore dans un exécuteur neuf.
const NO_CLONE: ExecRule[] = [{ match: "-- test -d /workspace/", code: 1 }, { match: "remote get-url team", code: 2 }];

function project(fake = FakeIncus.withRuntime(), rules: ExecRule[] = []) {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify(PROJECT));
  return { fake, ctx: fakeContext({ incus: fake, rules: [...rules, ...RULES] }) };
}

test("converge of a fresh project creates both mirrors of each repository, then the control and two executors, then restarts the API", async () => {
  const { fake, ctx } = project(undefined, NO_CLONE);
  assert.equal(await cmdTeam(ctx, ["converge"]), 0);
  const calls = ctx.calls.map((c) => c.join(" "));
  const launches = ctx.calls.filter((c) => c.includes("launch")).map((c) => c[c.indexOf("launch") + 2]);
  assert.deepEqual(launches, ["agent-control", "agent-executor-1", "agent-executor-2"]);
  for (const repo of ["web", "api"]) {
    const origin = calls.findIndex((c) => c.includes("clone --bare") && c.endsWith(`/repo-${repo}.git`));
    const team = calls.findIndex((c) => c.includes("init --bare") && c.endsWith(`/repo-${repo}.agents.git`));
    assert.ok(origin >= 0 && team > origin, calls.join("\n"));
    assert.ok(origin < calls.findIndex((c) => c.includes(" launch ")), "the mirrors come before any container");
  }
  const restart = calls.indexOf("systemctl --user try-restart forge-api.service");
  assert.ok(restart > calls.findLastIndex((c) => c.includes(" launch ")), calls.join("\n"));
  assert.ok(fake.instances.get("agent-forge")!.has("agent-executor-2"));
  assert.deepEqual(ctx.out_lines.filter((l) => /^(NAME|agent-)/.test(l)).map((l) => l.split(/\s+/).slice(0, 4).join(" ")), [
    "NAME KIND STATUS MISSION", "agent-control control Running -", "agent-executor-1 executor Running free", "agent-executor-2 executor Running free",
  ]);
});

test("converge of a project converges the present members, never deletes a stray executor, and takes no team", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  for (const n of [1, 2, 3]) fake.addInstance("agent-forge", `agent-executor-${n}`, { status: "Running", config: { "user.forge.role": "executor" } });
  const { ctx } = project(fake);
  assert.equal(await cmdTeam(ctx, ["converge"]), 0);
  assert.ok(!ctx.calls.some((c) => c.includes("launch") || c.includes("delete")), ctx.calls.map((c) => c.join(" ")).join("\n"));
  assert.ok(ctx.out_lines.includes("Updating agent-executor-1..."), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("agent-executor-3: not in the config, left as is"), ctx.out_lines.join("\n"));
  await assert.rejects(() => cmdTeam(project().ctx, ["converge", "web"]), /a project converges as a whole: forge team converge, without a team/);
});

const LIVE_IDLE: ExecRule = { match: "-- hc get agent", stdout: '{"argv":["forge-agent"],"state":"live","status":{"state":"idle"}}' };
// systemctl is-active sort en 3 pour un service en échec, et en écrit l'état.
const ORCH_FAILED: ExecRule = { match: "systemctl is-active forge-orchestrator", code: 3, stdout: "failed\n" };
const HELD = { kind: "dev", ticket: "T-1", subtask: "T-1.2", repository: "web", branch: "agent/T-1.2", base: "agent/T-1.1" };

test("status --json of a project prints its members: kind, presence, the mission held and the session", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running", config: { "user.forge.mission": JSON.stringify(HELD) } });
  const { ctx } = project(fake, [LIVE_IDLE, ORCH_FAILED]);
  assert.equal(await cmdTeam(ctx, ["status"], { json: true }), 0);
  assert.equal(ctx.out_lines.length, 1);
  assert.deepEqual(JSON.parse(ctx.out_lines[0]), { members: [
    { name: "agent-control", kind: "control", present: true, mission: null, session: "idle", orchestrator: "failed" },
    { name: "agent-executor-1", kind: "executor", present: true, mission: HELD, session: "idle" },
    { name: "agent-executor-2", kind: "executor", present: false, mission: null, session: "none" },
  ], problems: null, tickets: null });
  const text = project(fake, [LIVE_IDLE, ORCH_FAILED]).ctx;
  assert.equal(await cmdTeam(text, ["status"]), 0);
  assert.deepEqual(text.out_lines.map((l) => l.split(/\s+/).join(" ").trim()), [
    "NAME KIND STATUS SESSION MISSION", "agent-control control Running idle orchestrator failed",
    "agent-executor-1 executor Running idle T-1.2 (web)", "agent-executor-2 executor Missing none free",
    "tickets: unavailable", "orchestrator's problems: unavailable",
  ]);
});

test("status prints the orchestrator's problems under the table; unreachable, it says unavailable and exits 0", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  const line = "T-2: assign T-2.1 to agent-executor-1: refused";
  const problems: ExecRule = { match: "forge-team problems --json", stdout: JSON.stringify([line]) };
  const { ctx } = project(fake, [LIVE_IDLE, problems]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  assert.deepEqual(ctx.out_lines.slice(-2), ["PROBLEMS", line]);
  const call = ctx.calls.map((c) => c.join(" ")).find((c) => c.includes("forge-team problems"))!;
  assert.ok(call.includes("exec agent-control --user 1001"), call);
  const json = project(fake, [LIVE_IDLE, problems]).ctx;
  await cmdTeam(json, ["status"], { json: true });
  assert.deepEqual(JSON.parse(json.out_lines[0]).problems, [line]);
  const down = project(fake, [LIVE_IDLE, { match: "forge-team problems --json", code: 2 }]).ctx;
  assert.equal(await cmdTeam(down, ["status"]), 0);
  assert.equal(down.out_lines.at(-1), "orchestrator's problems: unavailable");
});

test("status shows a blocked session, and warns of a mission whose agent waits on its screen", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running", config: { "user.forge.mission": JSON.stringify(HELD) } });
  const { ctx } = project(fake, [{ match: "-- hc get agent", stdout: '{"argv":["forge-agent"],"state":"live","status":{"state":"blocked"}}' }]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  assert.ok(ctx.out_lines.some((l) => l.split(/\s+/).join(" ").trim() === "agent-executor-1 executor Running blocked T-1.2 (web)"),
    ctx.out_lines.join("\n"));
  assert.deepEqual(ctx.err_lines.filter((l) => l.startsWith("WARNING")), [
    "WARNING: agent-executor-1 holds T-1.2 but its agent is blocked, waiting for an answer on its screen: read it with hc read <machine>/agent",
  ]);
});

test("status: the orchestrator of a control that does not answer in time is unknown, with a deadline; a stopped control's is inactive", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  const { ctx } = project(fake, [{ match: "systemctl is-active forge-orchestrator", code: 124, timedOut: true }]);
  assert.equal(await cmdTeam(ctx, ["status"], { json: true }), 0);
  assert.equal(JSON.parse(ctx.out_lines[0]).members[0].orchestrator, "unknown");
  const at = ctx.calls.findIndex((c) => c.join(" ").endsWith("systemctl is-active forge-orchestrator"));
  assert.ok((ctx.execOptions[at]?.timeoutMs ?? 0) > 0);
  fake.instances.get("agent-forge")!.get("agent-control")!.status = "Stopped";
  const stopped = project(fake).ctx;
  assert.equal(await cmdTeam(stopped, ["status"], { json: true }), 0);
  assert.equal(JSON.parse(stopped.out_lines[0]).members[0].orchestrator, "inactive");
  assert.equal(JSON.parse(stopped.out_lines[0]).members[1].orchestrator, undefined);
});

test("status warns of a free executor whose clone has tracked changes, naming it and the clone; a busy one is not looked at", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running" });
  fake.addInstance("agent-forge", "agent-executor-2", { status: "Running", config: { "user.forge.mission": JSON.stringify(HELD) } });
  const { ctx } = project(fake, [{ match: "/workspace/api -c core.fsmonitor=false", stdout: " M a.ts\n" }]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  const status = ctx.calls.map((c) => c.join(" ")).filter((c) => c.includes("status --porcelain --untracked-files=no"));
  assert.ok(status.every((c) => c.includes("exec agent-executor-1 ")) && status.length === 2, status.join("\n"));
  assert.deepEqual(ctx.err_lines.filter((l) => l.startsWith("WARNING")), [
    "WARNING: agent-executor-1 is free but /workspace/api has uncommitted changes: it gets no mission until they are committed or discarded.",
  ]);
});

test("for-repo of a project prints the repository's name; task-base its branches' sub-tasks and bases; upload-pack serves its team mirror", async () => {
  const { ctx } = project();
  assert.equal(await cmdTeam(ctx, ["for-repo", "o/api"]), 0);
  assert.deepEqual(ctx.out_lines, ["api"]);
  assert.equal(await cmdTeam(project().ctx, ["for-repo", "o/none"]), 1);

  mkdirSync(join(home, ".local", "share", "agent-forge", "api"), { recursive: true });
  const rec = (repository: string, subtask: string, base: string) =>
    ({ branch: `agent/${subtask}`, repository, ticket: subtask.split(".")[0], subtask, base, executor: null });
  writeFileSync(join(home, ".local", "share", "agent-forge", "api", "branches.json"), JSON.stringify({ version: 1, records: [
    rec("web", "T-1.2", "agent/T-1.1"), rec("api", "T-2.1", "origin/main"), rec("web", "T-1.1", "origin/main"), rec("web", "T-1.3", "--upload-pack=x"),
  ] }));
  const bases = project().ctx;
  assert.equal(await cmdTeam(bases, ["task-base", "web"]), 0);
  assert.deepEqual(bases.out_lines, ["T-1.1\torigin/main", "T-1.2\tagent/T-1.1"]);
  await assert.rejects(() => cmdTeam(project().ctx, ["task-base", "nope"]), /nope is not a repository of the project/);

  const pack = project().ctx;
  assert.equal(await cmdTeam(pack, ["upload-pack", "api", "/ignored"]), 0);
  assert.deepEqual(pack.out_lines, []);
  assert.deepEqual(pack.attachCalls[0].argv, ["git", "-c", "core.hooksPath=/dev/null", "upload-pack", join(home, "mirrors", "repo-api.agents.git")]);
  await assert.rejects(() => cmdTeam(project().ctx, ["upload-pack", "nope"]), /nope is not a repository of the project/);
});

test("sync <repository> of a project refreshes that repository's origin mirror from GitHub", async () => {
  const { ctx } = project();
  assert.equal(await cmdTeam(ctx, ["sync", "api"]), 0);
  const fetches = ctx.calls.map((c) => c.join(" ")).filter((c) => c.includes(" fetch --prune "));
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].includes(`--git-dir=${join(home, "mirrors", "repo-api.git")}`) && fetches[0].includes("o/API"), fetches[0]);
  assert.deepEqual(ctx.out_lines, ["Synced api."]);
});

test("without a project, every subcommand says to declare one; for-repo answers nothing, exit 1", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), "{}");
  await assert.rejects(() => cmdTeam(fakeContext(), ["converge"]), /no project in .*config\.json: declare "project" there first/);
  const ctx = fakeContext();
  assert.equal(await cmdTeam(ctx, ["for-repo", "o/web"]), 1);
  assert.deepEqual(ctx.out_lines, []);
  await assert.rejects(() => cmdTeam(fakeContext(), ["inbox"]), /Usage: forge team converge/);
  await assert.rejects(() => cmdTeam(fakeContext(), ["answer", "1"]), /Usage: forge team converge/);
});

// Les limites promises (celle des exécuteurs, sinon celle du profil) contre la RAM moins la réserve de l'hôte.
const GIB = 2 ** 30;

test("converge warns, without refusing, when the containers' limits add up to more than the RAM minus the reserve", async () => {
  // Le contrôle et deux exécuteurs sans limite propre : 75 % de 4 GiB chacun, soit 9 GiB.
  const fake = FakeIncus.withRuntime();
  for (const n of ["agent-control", "agent-executor-1", "agent-executor-2"]) fake.addInstance("agent-forge", n, { status: "Running" });
  const { ctx } = project(fake);
  assert.equal(await cmdTeam(ctx, ["converge"], { hostMemory: 4 * GIB }), 0);
  const warning = ctx.err_lines.find((l) => l.startsWith("WARNING: the 3 containers' memory limits add up to 9.0 GiB"));
  assert.ok(warning?.includes("4.0 GiB of RAM, 0.0 GiB kept for the host"), ctx.err_lines.join("\n"));
});

test("converge counts the executors' own limit, the profile's for the control, and the reserve the host keeps", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    limits: { memory: "1GiB" }, project: { ...PROJECT.project, executors: { count: 2, memory: "512MiB" } },
  }));
  const reserve = { match: "systemctl show -p MemoryMin --value", stdout: `${GIB / 2}\n` };
  const fake = FakeIncus.withRuntime();
  for (const n of ["agent-control", "agent-executor-1", "agent-executor-2"]) fake.addInstance("agent-forge", n, { status: "Running" });
  // 2 GiB promis ; 4 GiB moins 2 × 0,5 GiB (system.slice, user.slice) = 3 GiB : rien à dire.
  const fits = fakeContext({ incus: fake, rules: [reserve, ...RULES] });
  await cmdTeam(fits, ["converge"], { hostMemory: 4 * GIB });
  assert.ok(!fits.err_lines.some((l) => l.includes("memory limits")), fits.err_lines.join("\n"));
  // Sur 2,5 GiB de RAM, il ne reste que 1,5 GiB.
  const tight = fakeContext({ incus: fake, rules: [reserve, ...RULES] });
  await cmdTeam(tight, ["converge"], { hostMemory: 2.5 * GIB });
  assert.ok(tight.err_lines.some((l) => l.includes("add up to 2.0 GiB, more than the 1.5 GiB")), tight.err_lines.join("\n"));
});

// ---------------------------------------------------------------- la main de l'humain

const JOURNAL = () => join(home, ".local", "share", "agent-forge", "api", "journal.jsonl");
const journalLines = () => readFileSync(JOURNAL(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// Une sous-tâche jamais commencée : ni dans le miroir d'équipe, ni dans le clone.
const FRESH: ExecRule[] = [
  { match: "rev-parse --verify --quiet refs/remotes/team/agent/T-3.1", code: 1 },
  { match: "rev-parse --verify --quiet refs/heads/agent/T-3.1", code: 1 },
  LIVE_IDLE,
];
const instruction = (text: string) => async () => text;

test("assign: the human gives an executor a sub-task, its instruction from stdin, journaled as human with id 0", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running" });
  const { ctx } = project(fake, FRESH);
  assert.equal(await cmdTeam(ctx, ["assign", "agent-executor-1", "T-3.1"], { repository: "api", stdin: instruction("Corrige le login") }), 0);
  assert.deepEqual(ctx.out_lines.at(-1), "Assigned T-3.1 to agent-executor-1 (api, from origin/main).");
  const held = JSON.parse(fake.instances.get("agent-forge")!.get("agent-executor-1")!.config["user.forge.mission"]);
  assert.deepEqual(held, { kind: "dev", ticket: "T-3", subtask: "T-3.1", repository: "api", branch: "agent/T-3.1", base: "origin/main" });
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("/workspace/api") && c.join(" ").includes("switch -c agent/T-3.1 origin/main")));
  // La consigne n'est jamais dans un argv.
  assert.ok(!ctx.calls.some((c) => c.some((a) => a.includes("Corrige le login"))));
  const [line] = journalLines();
  assert.deepEqual([line.id, line.caller, line.op, line.to, line.task, line.outcome, line.text],
    [0, "human", "assign", "agent-executor-1", "T-3.1", "ok", "Corrige le login"]);
});

test("assign reads the repository and the base from the branch's record, and refuses what the API would", async () => {
  mkdirSync(join(home, ".local", "share", "agent-forge", "api"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "agent-forge", "api", "branches.json"), JSON.stringify({ version: 1, records: [
    { branch: "agent/T-3.1", repository: "web", ticket: "T-3", subtask: "T-3.1", base: "origin/release", executor: "agent-executor-2" },
  ] }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running" });
  const { ctx } = project(fake, FRESH);
  assert.equal(await cmdTeam(ctx, ["assign", "agent-executor-1", "T-3.1"], { stdin: instruction("Reprends") }), 0);
  assert.ok(ctx.out_lines.includes("Assigned T-3.1 to agent-executor-1 (web, from origin/release)."), ctx.out_lines.join("\n"));

  // Plusieurs dépôts et aucune fiche : il faut dire lequel.
  await assert.rejects(() => cmdTeam(project().ctx, ["assign", "agent-executor-1", "T-4.1"], { stdin: instruction("x") }),
    /several repositories: say which one with --repository \(web, api\)/);
  await assert.rejects(() => cmdTeam(project().ctx, ["assign", "agent-executor-9", "T-3.1"], { stdin: instruction("x") }),
    /agent-executor-9 is not an executor of this project/);
  await assert.rejects(() => cmdTeam(project().ctx, ["assign", "agent-executor-1", "fix-login"], { repository: "web", stdin: instruction("x") }),
    /mission.ticket is not a ticket id/);
  await assert.rejects(() => cmdTeam(project().ctx, ["assign", "agent-executor-1", "T-4.1"], { repository: "web", stdin: instruction(" ") }),
    /instruction is empty/);
  await assert.rejects(() => cmdTeam(project().ctx, ["status"], { repository: "web" }), /--repository and --base only go with assign/);
  // Les refus des arguments sont journalisés sous l'humain, comme les autres.
  const refused = journalLines().filter((l) => l.outcome === "refused");
  assert.deepEqual(refused.map((l) => [l.caller, l.op, l.to]).slice(0, 2),
    [["human", "assign", "agent-executor-9"], ["human", "assign", "agent-executor-1"]]);
  assert.match(refused[1].error, /mission.ticket is not a ticket id/);
});

test("assign to a busy executor is refused by the host and journaled refused; release frees it, journaled as human", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running", config: { "user.forge.mission": JSON.stringify(HELD) } });
  const { ctx } = project(fake, FRESH);
  await assert.rejects(() => cmdTeam(ctx, ["assign", "agent-executor-1", "T-3.1"], { repository: "web", stdin: instruction("x") }),
    /agent-executor-1 holds T-1.2: release it first/);
  assert.equal(await cmdTeam(ctx, ["release", "agent-executor-1"]), 0);
  assert.equal(fake.instances.get("agent-forge")!.get("agent-executor-1")!.config["user.forge.mission"], undefined);
  assert.deepEqual(journalLines().map((l) => [l.id, l.caller, l.op, l.outcome]), [[0, "human", "assign", "refused"], [0, "human", "release", "ok"]]);
});

test("converge: a running Pilot is left alone, and a change of its instructions is said; with none, it is started", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  for (const n of [1, 2]) fake.addInstance("agent-forge", `agent-executor-${n}`, { status: "Running", config: { "user.forge.role": "executor" } });
  const { ctx } = project(fake, [LIVE_IDLE]);
  assert.equal(await cmdTeam(ctx, ["converge"]), 0);
  assert.ok(ctx.out_lines.includes("NOTE: the Pilot's instructions changed; its session keeps the old ones until you run forge pilot <ticket> --fresh."),
    ctx.out_lines.join("\n"));
  assert.ok(!ctx.calls.some((c) => c.includes("agent-control") && c.join(" ").includes("-- hc run ")));

  const none = project(fake, [{ match: "agent-control --user 1001 --group 1001 --cwd /workspace --env HOME=/home/aiuser --env XDG_RUNTIME_DIR=/run/user/1001 --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus -- hc get agent", code: 1 }, LIVE_IDLE]).ctx;
  assert.equal(await cmdTeam(none, ["converge"]), 0);
  assert.ok(none.calls.some((c) => c.join(" ").includes("exec agent-control") && c.join(" ").includes("-- hc run ")), none.calls.map((c) => c.join(" ")).join("\n"));
});

test("status shows the kind of a mission that is not dev", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running", config: { "user.forge.mission": JSON.stringify({ ...HELD, kind: "qa" }) } });
  fake.addInstance("agent-forge", "agent-executor-2", { status: "Running", config: { "user.forge.mission": JSON.stringify({ ...HELD, kind: "rebase" }) } });
  const { ctx } = project(fake, [LIVE_IDLE, ORCH_FAILED]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  const rows = ctx.out_lines.map((l) => l.split(/\s+/).join(" ").trim());
  assert.ok(rows.includes("agent-executor-1 executor Running idle qa T-1 (web)"), rows.join("\n"));
  assert.ok(rows.includes("agent-executor-2 executor Running idle rebase T-1.2 (web)"), rows.join("\n"));
  // Un correctif travaille sur la branche de la sous-tâche qu'il corrige.
  fake.instances.get("agent-forge")!.get("agent-executor-2")!.config["user.forge.mission"] =
    JSON.stringify({ ...HELD, subtask: "T-1.3", branch: "agent/T-1.1" });
  const fix = project(fake, [LIVE_IDLE, ORCH_FAILED]).ctx;
  assert.equal(await cmdTeam(fix, ["status"]), 0);
  const fixRows = fix.out_lines.map((l) => l.split(/\s+/).join(" ").trim());
  assert.ok(fixRows.includes("agent-executor-2 executor Running idle fix T-1.3 of T-1.1 (web)"), fixRows.join("\n"));
});

test("status keeps the TICKETS section when no ticket is under way, with a line that says so", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  const tickets: ExecRule = { match: "forge-team tickets --json", stdout: "[]" };
  const problems: ExecRule = { match: "forge-team problems --json", stdout: "[]" };
  const { ctx } = project(fake, [LIVE_IDLE, tickets, problems]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  const at = ctx.out_lines.indexOf("TICKETS");
  assert.ok(at > 0, ctx.out_lines.join("\n"));
  assert.equal(ctx.out_lines[at + 1], "no ticket under way");
});

test("status prints the tickets under way, by priority, and says when one waits for an answer; unreachable, unavailable", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-control", { status: "Running", config: { "user.forge.role": "control" } });
  const list = [
    { id: "T-2", title: "Spinner\u001b[31m", status: "human-review", priority: 1, waiting: 0 },
    { id: "T-1", title: "Paginate", status: "dev", priority: 2, waiting: 1 },
  ];
  const tickets: ExecRule = { match: "forge-team tickets --json", stdout: JSON.stringify(list) };
  const problems: ExecRule = { match: "forge-team problems --json", stdout: "[]" };
  const { ctx } = project(fake, [LIVE_IDLE, tickets, problems]);
  assert.equal(await cmdTeam(ctx, ["status"]), 0);
  const out = ctx.out_lines.map((l) => l.split(/\s+/).join(" ").trim());
  const at = out.indexOf("TICKETS");
  assert.ok(at > 0, out.join("\n"));
  assert.deepEqual(out.slice(at + 1, at + 3), ["T-2 human-review Spinner[31m", "T-1 dev Paginate (waits for 1 answer)"]);
  const call = ctx.calls.map((c) => c.join(" ")).find((c) => c.includes("forge-team tickets"))!;
  assert.ok(call.includes("exec agent-control --user 1001") && call.endsWith("tickets --json spec dev qa human-review pr-review"), call);
  const json = project(fake, [LIVE_IDLE, tickets, problems]).ctx;
  await cmdTeam(json, ["status"], { json: true });
  assert.deepEqual(JSON.parse(json.out_lines[0]).tickets, list);
  const stopped = FakeIncus.withRuntime();
  stopped.addInstance("agent-forge", "agent-control", { status: "Stopped", config: { "user.forge.role": "control" } });
  const down = project(stopped, [LIVE_IDLE]).ctx;
  assert.equal(await cmdTeam(down, ["status"]), 0);
  assert.ok(down.out_lines.some((l) => /^agent-control\s+control\s+Stopped/.test(l)), down.out_lines.join("\n"));
  assert.ok(down.out_lines.includes("tickets: unavailable"));
});
