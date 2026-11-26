import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule, type FakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import type { ApiDeps } from "../cli/lib/api/missions.ts";
import { Journal } from "../cli/lib/api/journal.ts";
import { hostSocketPath, serveApi } from "../cli/lib/api/server.ts";
import { handleMission, MISSION_KEY, parseMissionRequest, QUESTION_KEY } from "../cli/lib/api/missions.ts";
import { SUMMARY_ALLOWED } from "../cli/lib/api/protocol.ts";
import { readBranchRecords } from "../cli/lib/branch-records.ts";
import { socketHost, type HeldMission, type MissionSpec } from "../cli/lib/orchestrator/host.ts";
import { CONTROL, executorName, projectMembers, repoTeamMirror } from "../cli/lib/project.ts";
import { TRUST_SCRIPT, trustedDirs } from "../cli/lib/project-provision.ts";

const cfg = parseConfig("/c.json", {
  project: {
    repositories: { web: { repo: "o/web" }, api: { repo: "o/api" } },
    executors: { count: 2 },
    tickets: { base: "~/tickets" },
  },
});
const E1 = executorName(1);
const E2 = executorName(2);
const member = (name: string) => projectMembers(cfg.project!).find((m) => m.name === name)!;

const spec = (over: Partial<MissionSpec> = {}): MissionSpec => ({
  kind: "dev", ticket: "T-1", subtask: "T-1.1", repository: "web", branch: "agent/T-1.1", base: "origin/main",
  instruction: "Fais la sous-tâche 1", files: { spec: null, answers: null, split: null }, ...over,
});
const held = (over: Partial<MissionSpec> = {}): HeldMission => {
  const { instruction: _, files: _f, ...rest } = spec(over);
  return rest;
};

let home: string;
let fake: FakeIncus;
let ctx: FakeContext;
let d: ApiDeps;
// L'état que `hc get agent` rend, par container ; `hc ls` échoue pour ceux de `hcDown`.
let sessions: Record<string, string>;
let hcDown: Set<string>;
// Les appels qui ne finiraient jamais : sans délai, le test le dit ; avec, le délai les coupe.
let hangs: string[];

function setup(rules: ExecRule[] = []): void {
  ctx = fakeContext({ incus: fake, rules });
  const inner = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (hangs.some((h) => argv.join(" ").includes(h))) {
      ctx.calls.push(argv);
      return opts?.timeoutMs === undefined
        ? { code: 99, stdout: "", stderr: "no timeout: this call would hang the queue" }
        : { code: 124, stdout: "", stderr: "", timedOut: true };
    }
    const hc = argv.indexOf("hc");
    if (hc > 0 && argv[0] === "incus") {
      const container = argv[argv.indexOf("exec") + 1];
      const verb = argv[hc + 1];
      if (verb === "get") {
        ctx.calls.push(argv);
        const state = sessions[container] ?? "none";
        if (state === "none") return { code: 1, stdout: "", stderr: "no such terminal" };
        return { code: 0, stdout: JSON.stringify(
          state === "exited" ? { state: "finished", exit_code: 0, status: null }
            : state === "lost" ? { argv: ["/bin/bash"], state: "live", status: null }
              : { argv: ["/usr/local/bin/forge-agent"], state: "live", status: { state } }), stderr: "" };
      }
      if (verb === "ls") {
        ctx.calls.push(argv);
        return hcDown.has(container) ? { code: 1, stdout: "", stderr: "cannot reach the core" } : { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "kill") sessions[container] = "exited";
      if (verb === "run") sessions[container] = "idle";
    }
    return inner(argv, opts);
  };
  d = { ctx, cfg, journal: Journal.open(join(home, "api", "journal.jsonl")), secrets: ["tok-123"], now: () => new Date("2026-11-25T10:00:00Z") };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-api-missions-"));
  process.env.FORGE_HOME = home;
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  fake = FakeIncus.withRuntime();
  for (const name of [CONTROL, E1, E2]) fake.addInstance("agent-forge", name, { status: "Running" });
  sessions = {};
  hcDown = new Set();
  hangs = [];
  setup();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["FORGE_HOME", "XDG_DATA_HOME", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
});

const call = (caller: string, req: Record<string, unknown>) => handleMission(d, member(caller), JSON.stringify(req));
const keys = (name: string) => fake.instances.get("agent-forge")!.get(name)!.config;
const joined = () => ctx.calls.map((c) => c.join(" "));
const hold = (name: string, m: HeldMission) => { keys(name)[MISSION_KEY] = JSON.stringify(m); };

// Git dans le clone d'un exécuteur : les options qui coupent ce que sa config
// pourrait lancer.
const GIT = "git -C /workspace/web -c core.fsmonitor=false -c core.hooksPath=/dev/null " +
  "-c remote.origin.uploadpack=git-upload-pack -c remote.team.uploadpack=git-upload-pack " +
  "-c protocol.allow=never -c protocol.file.allow=always";

// Une branche absente du miroir d'équipe et du clone : `rev-parse --verify` échoue.
const absent = (ref: string): ExecRule => ({ match: `rev-parse --verify --quiet ${ref}`, code: 1 });

// --------------------------------------------------------------- les sockets

test("an executor asking for a control verb, or the control calling done: refused by the socket", async () => {
  for (const op of ["assign", "events", "release"]) {
    const r = await call(E1, { op, to: E2, after: 0 });
    assert.deepEqual(r, { ok: false, error: `${op} is not a verb of the executor container` });
  }
  assert.deepEqual(await call(CONTROL, { op: "done" }), { ok: false, error: "done is not a verb of the control container" });
  assert.equal(ctx.calls.length, 0);
  assert.ok(d.journal.entries().every((e) => e.outcome === "refused"));
  assert.equal(d.journal.entries().length, 4);
});

test("the request is checked field by field: exact mission keys, branch, base, instruction size", () => {
  const assign = (m: unknown) => () => parseMissionRequest(JSON.stringify({ op: "assign", to: E1, mission: m }), "control", ["tok-123"]);
  assert.throws(assign({ ...spec(), extra: 1 }), /mission: unknown field: "extra"/);
  assert.throws(assign({ ...spec(), branch: "agent/T-1.2" }), /branch must be agent\/T-1\.1/);
  assert.throws(assign({ ...spec(), subtask: "T-2.1", branch: "agent/T-2.1" }), /subtask T-2\.1 is not a sub-task of T-1/);
  assert.throws(assign({ ...spec(), base: "main" }), /base must be origin\/<branch> or agent\/<sub-task>/);
  assert.throws(assign({ ...spec(), base: "agent/T-1.1" }), /cannot start from itself/);
  assert.throws(assign({ ...spec(), instruction: "x".repeat(70_000) }), /instruction is longer than 65536 bytes/);
  assert.throws(assign({ ...spec(), instruction: "voici tok-123" }), /secret/);
  assert.throws(() => parseMissionRequest('{"op":"events","after":-1}', "control", []), /after must be a non-negative integer/);
  assert.deepEqual(parseMissionRequest('{"op":"events","after":3}', "control", []), { op: "events", after: 3 });
});

test("an instruction of 70 000 bytes is refused and journaled", async () => {
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec({ instruction: "é".repeat(35_000) }) });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /longer than 65536 bytes/);
  assert.equal(d.journal.entries()[0].outcome, "refused");
  assert.equal(keys(E1)[MISSION_KEY], undefined);
});

// --------------------------------------------------------------- assign

test("assign of a first sub-task: git switch -c from origin/main in /workspace/web as aiuser, branch recorded, key set, session in the clone", async () => {
  setup([absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1")]);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  assert.deepEqual(r, { ok: true });
  const calls = joined();
  const sw = calls.find((c) => c.includes(`${GIT} switch`));
  assert.ok(sw, calls.join("\n"));
  assert.ok(sw.includes(`exec ${E1} --user 1001 --group 1001`), sw);
  assert.ok(sw.endsWith("switch -c agent/T-1.1 origin/main"), sw);
  const fetchTeam = calls.findIndex((c) => c.endsWith(`${GIT} fetch team`));
  const fetchOrigin = calls.findIndex((c) => c.endsWith(`${GIT} fetch origin`));
  assert.ok(fetchTeam >= 0 && fetchOrigin > fetchTeam);
  assert.ok(calls.some((c) => c.includes("hc run") && c.includes("--cwd /workspace/web")));
  assert.deepEqual(JSON.parse(keys(E1)[MISSION_KEY]), held());
  assert.deepEqual(readBranchRecords(), [{ branch: "agent/T-1.1", repository: "web", ticket: "T-1", subtask: "T-1.1", base: "origin/main", executor: E1 }]);
  const e = d.journal.entries()[0];
  assert.deepEqual([e.op, e.to, e.outcome, e.text, e.mission], ["assign", E1, "ok", "Fais la sous-tâche 1", held()]);
});

// Le défaut de la recette R1 : la session démarrait dans un dossier que le
// ~/.claude.json de l'exécuteur n'acceptait pas, et restait à l'écran de
// confiance de Claude Code. Le .claude.json qu'un exécuteur reçoit
// (container/claude.json, puis le script de confiance de project-provision)
// doit accepter chaque dossier où assign lance une session.
test("the .claude.json an executor gets trusts every folder assign starts a session in", async () => {
  const cwds: string[] = [];
  for (const [to, repository, subtask] of [[E1, "web", "T-1.1"], [E2, "api", "T-2.1"]] as const) {
    setup([absent(`refs/remotes/team/agent/${subtask}`), absent(`refs/heads/agent/${subtask}`)]);
    const r = await call(CONTROL, { op: "assign", to, mission: spec({ repository, subtask, ticket: subtask.split(".")[0], branch: `agent/${subtask}` }) });
    assert.deepEqual(r, { ok: true });
    const run = ctx.calls.find((c) => c.includes("hc") && c.includes("run"))!;
    cwds.push(run[run.indexOf("--cwd", run.indexOf("hc")) + 1]);
  }
  assert.deepEqual(cwds, ["/workspace/web", "/workspace/api"]);
  const file = join(home, "claude.json");
  copyFileSync(join(import.meta.dirname, "..", "container", "claude.json"), file);
  const trust = spawnSync(process.execPath, ["-e", TRUST_SCRIPT, file, ...trustedDirs(cfg.project!)], { encoding: "utf8" });
  assert.equal(trust.status, 0, trust.stderr);
  const projects = JSON.parse(readFileSync(file, "utf8")).projects;
  for (const cwd of cwds) {
    assert.deepEqual([projects[cwd]?.hasTrustDialogAccepted, projects[cwd]?.hasCompletedProjectOnboarding], [true, true], cwd);
  }
});

test("assign of a branch that is in the team mirror: git switch -C from team/<branch>", async () => {
  setup([absent("refs/heads/agent/T-1.1")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E2, mission: spec() }), { ok: true });
  assert.ok(joined().some((c) => c.endsWith(`${GIT} switch -C agent/T-1.1 team/agent/T-1.1`)), joined().join("\n"));
  assert.ok(!joined().some((c) => c.includes("switch -c")));
});

test("a second sub-task's assign starts from team/agent/<first sub-task>", async () => {
  setup([absent("refs/remotes/team/agent/T-1.2"), absent("refs/heads/agent/T-1.2")]);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec({ subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" }) });
  assert.deepEqual(r, { ok: true });
  assert.ok(joined().some((c) => c.endsWith(`${GIT} switch -c agent/T-1.2 team/agent/T-1.1`)), joined().join("\n"));
});

test("a stacked base missing from the team mirror is refused, nothing recorded", async () => {
  setup([absent("refs/remotes/team/agent/T-1.2"), absent("refs/heads/agent/T-1.2"), absent("refs/remotes/team/agent/T-1.1")]);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec({ subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" }) });
  assert.deepEqual(r, { ok: false, error: "base agent/T-1.1 is not in the team mirror" });
  assert.equal(keys(E1)[MISSION_KEY], undefined);
  assert.deepEqual(readBranchRecords(), []);
});

test("an executor that is not free: refused, unless it holds the same sub-task (its session restarts)", async () => {
  hold(E1, held({ subtask: "T-1.3", branch: "agent/T-1.3" }));
  const busy = await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  assert.deepEqual(busy, { ok: false, error: `${E1} holds T-1.3: release it first` });
  assert.ok(!joined().some((c) => c.includes("git ")));

  hold(E1, held());
  sessions[E1] = "exited";
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: true });
  assert.ok(joined().some((c) => c.includes("hc run")));
});

// La reprise de l'orchestrateur (tick.ts, recover) : `release` puis `assign` de
// la même mission, par son client. À l'assign, la clé est vide : c'est le clone,
// déjà sur agent/T-1.1, qui dit la reprise.
test("recovery as the orchestrator does it, release then assign: on the branch with uncommitted work, no clean check, no switch, a new session", async () => {
  hold(E1, held());
  sessions[E1] = "lost";
  setup([{ match: "symbolic-ref --short HEAD", stdout: "agent/T-1.1\n" }, { match: "status --porcelain", stdout: " M a.ts\n" }]);
  await withHost(async (host) => {
    assert.deepEqual((await host.status()).find((e) => e.name === E1)?.session, "lost");
    await host.release(E1);
    assert.equal(keys(E1)[MISSION_KEY], undefined);
    const before = ctx.calls.length;
    await host.assign(E1, spec());
    const after = ctx.calls.slice(before).map((c) => c.join(" "));
    assert.ok(after.some((c) => c.includes("fetch team")), after.join("\n"));
    assert.ok(!after.some((c) => c.includes(" switch")), after.join("\n"));
    assert.ok(!after.some((c) => c.includes("status --porcelain")), after.join("\n"));
    assert.ok(after.some((c) => c.includes("hc run")));
  });
  assert.equal(keys(E1)[MISSION_KEY], JSON.stringify(held()));
});

// Le clone déjà sur la branche, face à team/<branche> : `--is-ancestor` rend 1
// pour « non ».
const onBranch: ExecRule = { match: "symbolic-ref --short HEAD", stdout: "agent/T-1.1\n" };
const notAncestor = (x: string, y: string): ExecRule => ({ match: `merge-base --is-ancestor ${x} ${y}`, code: 1 });
const TEAM = "team/agent/T-1.1";

test("on the branch, team/<branch> already in it: the clone is kept, no switch, no merge", async () => {
  setup([onBranch]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: true });
  assert.ok(joined().some((c) => c.endsWith(`${GIT} merge-base --is-ancestor ${TEAM} HEAD`)), joined().join("\n"));
  assert.ok(!joined().some((c) => c.includes(" switch") || c.includes(" merge --ff-only")), joined().join("\n"));
});

test("on the branch, clean, team/<branch> ahead: fast-forward", async () => {
  setup([onBranch, notAncestor(TEAM, "HEAD")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: true });
  assert.ok(joined().some((c) => c.endsWith(`${GIT} merge --ff-only ${TEAM}`)), joined().join("\n"));
  assert.ok(!joined().some((c) => c.includes(" switch")));
});

test("on the branch, dirty, team/<branch> ahead: refused, nothing changed", async () => {
  setup([onBranch, notAncestor(TEAM, "HEAD"), { match: "status --porcelain", stdout: " M a.ts\n" }]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: false, error:
    `${E1}: /workspace/web is on agent/T-1.1 with uncommitted changes, and ${TEAM} has moved beyond it: commit or discard them, then assign again` });
  assert.ok(!joined().some((c) => c.includes(" switch") || c.includes(" merge --ff-only")));
  assert.equal(keys(E1)[MISSION_KEY], undefined);
  assert.deepEqual(readBranchRecords(), []);
});

const DIVERGED = `agent/T-1.1 in ${E1} has commits that ${TEAM} does not have, and the reverse: resolve by hand (release, inspect the clone)`;

test("on the branch, diverged from team/<branch>: refused", async () => {
  setup([onBranch, notAncestor(TEAM, "HEAD"), notAncestor("HEAD", TEAM)]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: false, error: DIVERGED });
  assert.ok(!joined().some((c) => c.includes(" switch") || c.includes(" merge --ff-only")));
  assert.equal(keys(E1)[MISSION_KEY], undefined);
});

test("off the branch, a local branch diverged from team/<branch>: refused, never switch -C", async () => {
  setup([{ match: "symbolic-ref --short HEAD", stdout: "main\n" },
    notAncestor("agent/T-1.1", TEAM), notAncestor(TEAM, "agent/T-1.1")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: false, error: DIVERGED });
  assert.ok(!joined().some((c) => c.includes(" switch")), joined().join("\n"));
  assert.equal(keys(E1)[MISSION_KEY], undefined);
});

test("off the branch, a local branch ahead of team/<branch>: switched to as it is", async () => {
  setup([{ match: "symbolic-ref --short HEAD", stdout: "main\n" }, notAncestor("agent/T-1.1", TEAM)]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: true });
  assert.ok(joined().some((c) => c.endsWith(`${GIT} switch agent/T-1.1`)), joined().join("\n"));
  assert.ok(!joined().some((c) => c.includes("switch -C")));
});

test("a clone off the branch with tracked changes is refused, released or not; a held sub-task with another base is refused", async () => {
  setup([{ match: "symbolic-ref --short HEAD", stdout: "main\n" }, { match: "status --porcelain --untracked-files=no", stdout: " M a.ts\n" }]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `${E1}: /workspace/web has 1 uncommitted change and is not on agent/T-1.1: commit or discard them before assigning a mission` });
  hold(E1, held());
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `${E1}: /workspace/web has 1 uncommitted change and is not on agent/T-1.1: commit or discard them before assigning a mission` });
  assert.ok(!joined().some((c) => c.includes(" switch")));
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec({ base: "origin/dev" }) }),
    { ok: false, error: "T-1.1 is held with another repository or base" });
});

test("a git call that times out refuses the verb, and the queue goes on", async () => {
  hangs = ["fetch team"];
  setup([absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1")]);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  assert.deepEqual(r, { ok: false, error: `git fetch in ${E1}:/workspace/web timed out after 60 s` });
  hangs = ["fetch --no-tags src"];
  hold(E2, held({ subtask: "T-1.2", branch: "agent/T-1.2" }));
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  assert.deepEqual(await call(E2, { op: "done" }), { ok: false, error: "copying agent/T-1.2 to the team mirror timed out after 120 s" });
  hangs = [];
  assert.deepEqual(await call(CONTROL, { op: "release", to: E2 }), { ok: true });
});

test("a sub-task held by another executor is refused", async () => {
  hold(E1, held());
  const r = await call(CONTROL, { op: "assign", to: E2, mission: spec() });
  assert.deepEqual(r, { ok: false, error: `T-1.1 is held by ${E1}` });
  assert.equal(keys(E2)[MISSION_KEY], undefined);
});

test("a dirty clone (tracked changes only), an unknown executor and an undeclared repository are refused", async () => {
  setup([{ match: `${GIT} status --porcelain --untracked-files=no`, stdout: " M a.ts\n" }]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `${E1}: /workspace/web has 1 uncommitted change and is not on agent/T-1.1: commit or discard them before assigning a mission` });
  assert.deepEqual(await call(CONTROL, { op: "assign", to: executorName(3), mission: spec() }),
    { ok: false, error: "agent-executor-3 is not an executor of this project" });
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec({ repository: "docs" }) }),
    { ok: false, error: "repository docs is not declared in the project" });
});

test("a session that does not start: the mission key is unset", async () => {
  setup([absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1"), { match: "hc run", code: 1, stderr: "boom" }]);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  assert.equal(r.ok, false);
  assert.equal(keys(E1)[MISSION_KEY], undefined);
});

// --------------------------------------------------------------- release, status

test("release unsets the key and stops the session", async () => {
  hold(E1, held());
  sessions[E1] = "working";
  assert.deepEqual(await call(CONTROL, { op: "release", to: E1 }), { ok: true });
  assert.equal(keys(E1)[MISSION_KEY], undefined);
  assert.equal(sessions[E1], "exited");
});

test("status: none only with hc up and no mission; held without terminal is lost; stopped or hc down is unknown", async () => {
  fake.addInstance("agent-forge", "agent-executor-2", { status: "Stopped", config: { [MISSION_KEY]: JSON.stringify(held()) } });
  let r = await call(CONTROL, { op: "status" });
  assert.deepEqual(r, { ok: true, executors: [
    { name: E1, mission: null, session: "none", question: null },
    { name: E2, mission: held(), session: "unknown", question: null },
  ] });
  fake.instances.get("agent-forge")!.get(E2)!.status = "Running";
  r = await call(CONTROL, { op: "status" });
  assert.equal((r as unknown as { executors: { session: string }[] }).executors[1].session, "lost");
  hcDown.add(E1);
  r = await call(CONTROL, { op: "status" });
  assert.equal((r as unknown as { executors: { session: string }[] }).executors[0].session, "unknown");
});

test("status: a free executor whose clone has tracked changes, or whose git status hangs, is unknown; a busy one is not looked at", async () => {
  hold(E2, held());
  sessions[E2] = "working";
  setup([{ match: "/workspace/api -c core.fsmonitor=false", stdout: " M a.ts\n" }]);
  let r = await call(CONTROL, { op: "status" });
  assert.deepEqual(r, { ok: true, executors: [
    { name: E1, mission: null, session: "unknown", question: null },
    { name: E2, mission: held(), session: "working", question: null },
  ] });
  const looked = joined().filter((c) => c.includes("status --porcelain --untracked-files=no"));
  assert.ok(looked.length === 2 && looked.every((c) => c.includes(`exec ${E1} `)), looked.join("\n"));
  setup();
  hangs = ["/workspace/web -c core.fsmonitor=false"];
  r = await call(CONTROL, { op: "status" });
  assert.equal((r as unknown as { executors: { session: string }[] }).executors[0].session, "unknown");
  hangs = [];
  r = await call(CONTROL, { op: "status" });
  assert.equal((r as unknown as { executors: { session: string }[] }).executors[0].session, "none");
});

test("status: a hc get or hc ls that hangs is unknown, never lost, for an executor that holds a mission", async () => {
  hold(E1, held());
  for (const h of [["hc get"], ["hc ls"]]) {
    hangs = h.map((x) => `-- ${x}`);
    const r = await call(CONTROL, { op: "status" });
    assert.equal((r as unknown as { executors: { session: string }[] }).executors[0].session, "unknown", h[0]);
  }
  hangs = [];
  const r = await call(CONTROL, { op: "status" });
  assert.equal((r as unknown as { executors: { session: string }[] }).executors[0].session, "lost");
});

test("the incus and hc calls of assign and release have a timeout: a hang refuses naming the step, and the key is not left set", async () => {
  const fresh = [absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1")];
  fake.instances.get("agent-forge")!.get(E1)!.status = "Stopped";
  hangs = [`start ${E1}`];
  setup(fresh);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `incus start ${E1} timed out after 30 s` });
  fake.instances.get("agent-forge")!.get(E1)!.status = "Running";
  hangs = [`set ${E1} ${MISSION_KEY}`];
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `recording the mission of ${E1} timed out after 30 s` });
  hangs = ["-- hc run"];
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `hc run in ${E1} timed out after 30 s` });
  assert.equal(keys(E1)[MISSION_KEY], undefined);
  // Un `hc kill` muet ne refuse pas la libération : la clé est retirée, l'humain prévenu.
  hold(E1, held());
  hangs = ["-- hc kill"];
  assert.deepEqual(await call(CONTROL, { op: "release", to: E1 }), { ok: true });
  assert.equal(keys(E1)[MISSION_KEY], undefined);
  assert.ok(ctx.err_lines.some((l) => l.includes(`could not stop ${E1}'s session`)), ctx.err_lines.join("\n"));
  hangs = [`unset ${E1} ${MISSION_KEY}`];
  hold(E1, held());
  assert.deepEqual(await call(CONTROL, { op: "release", to: E1 }), { ok: false, error: `clearing the mission of ${E1} timed out after 30 s` });
});

test("a switch has 60 s", async () => {
  hangs = ["switch -c agent/T-1.1"];
  setup([absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }),
    { ok: false, error: `git switch in ${E1}:/workspace/web timed out after 60 s` });
});

test("an executor's status is its mission", async () => {
  assert.deepEqual(await call(E1, { op: "status" }), { ok: true, mission: null });
  hold(E1, held());
  assert.deepEqual(await call(E1, { op: "status" }), { ok: true, mission: held() });
});

// --------------------------------------------------------------- done, events

test("done with nothing beyond the base is refused", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "0\n" }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error: "nothing committed on agent/T-1.1 beyond origin/main" });
  assert.ok(!joined().some((c) => c.includes("fetch --no-tags src")));
});

// Accepté sur un clone sale, le done libérerait un exécuteur que `status` dit
// ensuite `unknown` : il ne recevrait plus de mission.
test("done with tracked changes in any of the executor's clones, or a clone that does not answer, is refused: nothing copied, nothing journaled", async () => {
  hold(E1, held());
  for (const [rules, error] of [
    [[{ match: `${GIT} status --porcelain --untracked-files=no`, stdout: " M package-lock.json\n" }],
      `${E1}: /workspace/web has uncommitted changes: commit or discard them, then report done again`],
    [[{ match: "/workspace/api -c core.fsmonitor=false", stdout: " M a.ts\n" }],
      `${E1}: /workspace/api has uncommitted changes: commit or discard them, then report done again`],
    [[{ match: "/workspace/api -c core.fsmonitor=false", code: 128, stderr: "fatal" }],
      `${E1}: git status in /workspace/api did not answer: try done again`],
  ] as [ExecRule[], string][]) {
    setup([...rules, { match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" }]);
    assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error });
    assert.ok(!joined().some((c) => c.includes("fetch --no-tags src")));
  }
  assert.ok(d.journal.entries().every((e) => e.outcome !== "ok"));
});

test("done without a mission is refused", async () => {
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error: `${E1} holds no mission: there is nothing to report done` });
});

test("done fetches the branch into repo-web.agents.git, and events(0) returns it with last", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" }]);
  const r = await call(E1, { op: "done" });
  assert.deepEqual(r, { ok: true, id: 1 });
  const fetch = ctx.calls.find((c) => c[0] === "git" && c.includes("fetch"))!;
  assert.ok(fetch.includes(`--git-dir=${repoTeamMirror("web")}`), fetch.join(" "));
  assert.ok(fetch.includes("remote.src.url=/workspace/web"));
  assert.ok(fetch.some((a) => a.startsWith("remote.src.uploadpack=FORGE_SIDE=host ") && a.endsWith(` upload-pack ${E1}`)));
  assert.equal(fetch.at(-1), "+refs/heads/agent/T-1.1:refs/heads/agent/T-1.1");
  const ev = await call(CONTROL, { op: "events", after: 0 });
  assert.deepEqual(ev, { ok: true, events: [{ id: 1, kind: "done", executor: E1, ticket: "T-1", subtask: "T-1.1", branch: "agent/T-1.1", wip: false, report: null }], last: 1 });
  // Les lectures acceptées du contrôle ne vont pas au journal : `last` ne bouge pas.
  assert.deepEqual(await call(CONTROL, { op: "events", after: 1 }), { ok: true, events: [], last: 1 });
  await call(CONTROL, { op: "status" });
  assert.deepEqual(d.journal.entries().map((e) => e.op), ["done"]);
  // Un refus du contrôle, si.
  await call(CONTROL, { op: "events", after: -1 });
  assert.deepEqual(d.journal.entries().map((e) => [e.op, e.outcome]), [["done", "ok"], [null, "refused"]]);
});

test("two done calls racing: event ids follow their append order", async () => {
  hold(E1, held());
  hold(E2, held({ subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" }));
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  const [a, b] = await Promise.all([call(E1, { op: "done" }), call(CONTROL, { op: "status" }), call(E2, { op: "done" })]).then(([x, , y]) => [x, y]);
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: { id: number; executor: string }[]; last: number };
  const order = d.journal.entries().filter((e) => e.op === "done").map((e) => e.id);
  assert.deepEqual(ev.events.map((e) => e.id), order);
  assert.deepEqual(ev.events.map((e) => e.executor), [E1, E2]);
  assert.deepEqual([(a as unknown as { id: number }).id, (b as unknown as { id: number }).id], order);
  assert.ok(ev.events.every((e) => e.id <= ev.last));
});

// --------------------------------------------------------------- le contrat

test("status and events replies pass the orchestrator's client", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  await call(E1, { op: "done" });
  await withHost(async (host) => {
    const status = await host.status();
    assert.deepEqual(status.map((e) => [e.name, e.mission?.subtask ?? null]), [[E1, "T-1.1"], [E2, null]]);
    const ev = await host.events(0);
    assert.deepEqual(ev.events.map((e) => [e.executor, e.kind === "done" ? e.branch : null]), [[E1, "agent/T-1.1"]]);
    await host.release(E1);
  });
});

// Le client de l'orchestrateur (socketHost) sur une socket que sert handleMission
// pour le contrôle, comme le service.
async function withHost(fn: (host: ReturnType<typeof socketHost>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "forge-mission-sock-"));
  const path = join(dir, "api.sock");
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      if (!buf.includes("\n")) return;
      void handleMission(d, member(CONTROL), buf.split("\n")[0]).then((r) => s.end(`${JSON.stringify(r)}\n`));
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    await fn(socketHost(path));
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with a project, the server opens one socket per project container and answers with the mission verbs", async () => {
  process.env.FORGE_API_RUNTIME = join(home, "run");
  const stop = new AbortController();
  const served = serveApi(d, stop.signal);
  try {
    for (let i = 0; i < 100 && !existsSync(hostSocketPath(E2)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok([CONTROL, E1, E2].every((n) => existsSync(hostSocketPath(n))));
    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(hostSocketPath(E1));
      let out = "";
      s.setEncoding("utf8");
      s.on("data", (c) => (out += c));
      s.on("end", () => resolve(out));
      s.on("error", reject);
      s.write('{"op":"events","after":0}\n');
    });
    assert.deepEqual(JSON.parse(reply), { ok: false, error: "events is not a verb of the executor container" });
  } finally {
    stop.abort();
    await served;
    delete process.env.FORGE_API_RUNTIME;
  }
});

// --------------------------------------------------------------- les questions (plan 2b)

test("ask: accepted with a mission, its id is the journal line's; status and events show it", async () => {
  hold(E1, held());
  const r = await call(E1, { op: "ask", text: "what is the limit?" });
  const line = d.journal.entries().find((e) => e.op === "ask")!;
  assert.deepEqual(r, { ok: true, id: line.id });
  assert.equal(keys(E1)[QUESTION_KEY], String(line.id));
  const st = await call(CONTROL, { op: "status" }) as unknown as { executors: { name: string; question: number | null }[] };
  assert.deepEqual(st.executors.map((e) => [e.name, e.question]), [[E1, line.id], [E2, null]]);
  const ev = await call(CONTROL, { op: "events", after: 0 });
  assert.deepEqual(ev, { ok: true, events: [{ id: line.id, kind: "ask", executor: E1, ticket: "T-1", subtask: "T-1.1", text: "what is the limit?" }], last: line.id });
});

test("ask: a second ask is refused with the pending id; without a mission, or from the control, refused", async () => {
  hold(E1, held());
  const first = await call(E1, { op: "ask", text: "q1" }) as unknown as { id: number };
  assert.deepEqual(await call(E1, { op: "ask", text: "q2" }), { ok: false, error: `question ${first.id} still waits for its answer` });
  assert.deepEqual(await call(E2, { op: "ask", text: "q" }), { ok: false, error: `${E2} holds no mission: there is nothing to ask about` });
  assert.deepEqual(await call(CONTROL, { op: "ask", text: "q" }), { ok: false, error: "ask is not a verb of the control container" });
});

test("ask: a question holding a secret is refused, and the journal does not hold it; release clears the key", async () => {
  hold(E1, held());
  const r = await call(E1, { op: "ask", text: "the token is tok-123" });
  assert.equal(r.ok, false);
  assert.ok(!readFileSync(join(home, "api", "journal.jsonl"), "utf8").includes("tok-123"));
  await call(E1, { op: "ask", text: "q" });
  assert.ok(keys(E1)[QUESTION_KEY]);
  await call(CONTROL, { op: "release", to: E1 });
  assert.equal(keys(E1)[QUESTION_KEY], undefined);
});

const mirrorFetch = () => ctx.calls.some((c) => c[0] === "git" && c.includes("fetch") && c.some((a) => a.startsWith("--git-dir=")));

test("done --wip with nothing committed is accepted and copies nothing; with a commit it copies the branch", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "0\n" }]);
  assert.equal((await call(E1, { op: "done", wip: true, report: null })).ok, true);
  assert.ok(!mirrorFetch());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "1\n" }]);
  assert.equal((await call(E1, { op: "done", wip: true, report: null })).ok, true);
  assert.ok(mirrorFetch());
});

test("done --wip on a dirty clone is refused, as a plain done is", async () => {
  hold(E1, held());
  setup([{ match: "/workspace/web -c core.fsmonitor=false", stdout: " M a.ts\n" }]);
  const r = await call(E1, { op: "done", wip: true, report: null });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /uncommitted changes/);
});

test("done with a report gives an event with that report; {op:done} alone still works; an unknown field is refused", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "1\n" }]);
  const r = await call(E1, { op: "done", wip: false, report: "Did x; checked y." }) as unknown as { id: number };
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: { wip: boolean; report: string | null }[] };
  assert.deepEqual([ev.events[0].wip, ev.events[0].report], [false, "Did x; checked y."]);
  assert.ok(r.id > 0);
  hold(E2, held({ subtask: "T-1.2", branch: "agent/T-1.2" }));
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  assert.equal((await call(E2, { op: "done" })).ok, true);
  assert.deepEqual(await call(E2, { op: "done", force: true }), { ok: false, error: 'done: unknown field: "force"' });
});

const SENT: ExecRule = { match: "-- hc send --json agent", stdout: '{"turn":3}' };
const sentLines = () => ctx.calls.filter((c) => c.includes("send")).map((c) => c.at(-1)!);

test("session: the control starts question-<n> in agent-control; an executor cannot", async () => {
  const r = await call(CONTROL, { op: "session", question: 7, instruction: "[forge] question 7 on T-1.1 (ticket T-1)" });
  assert.deepEqual(r, { ok: true });
  assert.ok(joined().some((c) => c.includes(`exec ${CONTROL} `) && c.includes("-- hc run --bg --name question-7 ")), joined().join("\n"));
  assert.ok(!joined().some((c) => c.endsWith("hc kill agent")));
  assert.deepEqual(await call(E1, { op: "session", question: 7, instruction: "x" }), { ok: false, error: "session is not a verb of the executor container" });
});

test("answer to an executor waiting for question 7: file, line, key cleared, question session ended, delivered", async () => {
  hold(E1, held());
  keys(E1)[QUESTION_KEY] = "7";
  sessions[E1] = "working";
  setup([SENT]);
  const r = await call(CONTROL, { op: "answer", to: E1, question: 7, kind: "answer", text: "100 per page" });
  assert.deepEqual(r, { ok: true, delivered: true });
  assert.ok(joined().some((c) => c.includes("file push") && c.includes(`${E1}/home/aiuser/.forge/messages/answer-7.md`)));
  assert.deepEqual(sentLines(), ["[forge] answer to your question 7: read /home/aiuser/.forge/messages/answer-7.md"]);
  assert.equal(keys(E1)[QUESTION_KEY], undefined);
  assert.ok(joined().some((c) => c.includes(`exec ${CONTROL} `) && c.endsWith("-- hc kill question-7")));
});

test("Review Focus 2: an answer for a question no longer pending types nothing and is not delivered", async () => {
  hold(E1, held());
  keys(E1)[QUESTION_KEY] = "7";
  sessions[E1] = "working";
  setup([SENT]);
  const r = await call(CONTROL, { op: "answer", to: E1, question: 8, kind: "answer", text: "x" });
  assert.deepEqual(r, { ok: true, delivered: false });
  assert.deepEqual(sentLines(), []);
  assert.equal(keys(E1)[QUESTION_KEY], "7");
  assert.ok(joined().some((c) => c.endsWith("-- hc kill question-8")));
});

test("Review Focus 5: a developer session that finished before the answer: key cleared, not delivered, no error", async () => {
  hold(E1, held());
  keys(E1)[QUESTION_KEY] = "7";
  sessions[E1] = "working";
  setup([{ match: "-- hc send --json agent", code: 11, stdout: '{"error":{"kind":"finished","message":"t2 has finished"}}' }]);
  const r = await call(CONTROL, { op: "answer", to: E1, question: 7, kind: "needs-human", text: "?" });
  assert.deepEqual(r, { ok: true, delivered: false });
  assert.equal(keys(E1)[QUESTION_KEY], undefined);
});

test("the two typed lines pass SUMMARY_ALLOWED once their [forge] prefix is removed", async () => {
  for (const kind of ["answer", "needs-human"]) {
    hold(E1, held());
    keys(E1)[QUESTION_KEY] = "7";
    sessions[E1] = "working";
    setup([SENT]);
    await call(CONTROL, { op: "answer", to: E1, question: 7, kind, text: "x" });
    const [line] = sentLines();
    assert.ok(line.startsWith("[forge] ") && SUMMARY_ALLOWED.test(line.slice("[forge] ".length)), line);
  }
});
