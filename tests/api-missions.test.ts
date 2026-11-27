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
import { handleMission, MISSION_FILES_DIR, MISSION_KEY, parseMissionRequest, parseQaReport } from "../cli/lib/api/missions.ts";
import { MISSION_DIR } from "../cli/lib/orchestrator/instruction.ts";
import { branchRecord, readBranchRecords, recordBranch, setBuiltOn } from "../cli/lib/branch-records.ts";
import { socketHost, type HeldMission, type MissionSpec } from "../cli/lib/orchestrator/host.ts";
import { CONTROL, executorName, projectMembers, repoOriginMirror, repoTeamMirror } from "../cli/lib/project.ts";
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
  assert.throws(assign({ ...spec(), kind: "rebase", branch: "agent/T-1.2" }), /branch must be agent\/T-1\.1/);
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
  assert.deepEqual(readBranchRecords(), [{ branch: "agent/T-1.1", repository: "web", ticket: "T-1", subtask: "T-1.1", base: "origin/main", executor: E1, builtOn: null }]);
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
    { name: E1, mission: null, session: "none" },
    { name: E2, mission: held(), session: "unknown" },
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
    { name: E1, mission: null, session: "unknown" },
    { name: E2, mission: held(), session: "working" },
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
  assert.deepEqual(ev, { ok: true, events: [{ id: 1, kind: "done", executor: E1, ticket: "T-1", subtask: "T-1.1", branch: "agent/T-1.1", report: null, mission: "dev", qa: null }], last: 1 });
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

const mirrorFetch = () => ctx.calls.some((c) => c[0] === "git" && c.includes("fetch") && c.some((a) => a.startsWith("--git-dir=")));

test("done with a report gives an event with that report; {op:done} alone still works; an unknown field is refused", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "1\n" }]);
  const r = await call(E1, { op: "done", report: "Did x; checked y." }) as unknown as { id: number };
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: { report: string | null }[] };
  assert.equal(ev.events[0].report, "Did x; checked y.");
  assert.ok(r.id > 0);
  hold(E2, held({ subtask: "T-1.2", branch: "agent/T-1.2" }));
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  assert.equal((await call(E2, { op: "done" })).ok, true);
  assert.deepEqual(await call(E2, { op: "done", force: true }), { ok: false, error: 'done: unknown field: "force"' });
});

// --------------------------------------------------------------- les fichiers de mission (plan 2b)

const FRESH = [absent("refs/remotes/team/agent/T-1.1"), absent("refs/heads/agent/T-1.1")];
const files = (over: Partial<MissionSpec["files"]> = {}) => ({ spec: null, answers: null, split: null, ...over });

test("the mission files folder is the one the instruction names", () => {
  assert.equal(MISSION_FILES_DIR, MISSION_DIR);
});

test("assign with files.spec: the folder is reset as root, spec.md pushed by root in mode 444, no answers.md; the key holds no files", async () => {
  setup(FRESH);
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec({ files: files({ spec: "# The spec" }) }) });
  assert.deepEqual(r, { ok: true });
  const calls = joined();
  const rm = calls.findIndex((c) => c === `incus --project agent-forge exec ${E1} -- rm -rf -- ${MISSION_FILES_DIR}`);
  const mk = calls.findIndex((c) => c === `incus --project agent-forge exec ${E1} -- mkdir -m 755 -- ${MISSION_FILES_DIR}`);
  const push = calls.findIndex((c) => c.includes("file push") && c.includes(`${E1}${MISSION_FILES_DIR}/spec.md`));
  const run = calls.findIndex((c) => c.includes("-- hc run "));
  assert.ok(rm >= 0 && mk > rm && push > mk && run > push, calls.join("\n"));
  assert.ok(calls[push].includes("--uid 0 --gid 0 --mode 444"), calls[push]);
  assert.ok(!calls.some((c) => c.includes("answers.md")));
  assert.deepEqual(JSON.parse(keys(E1)[MISSION_KEY]), held());
  assert.ok(!readFileSync(join(home, "api", "journal.jsonl"), "utf8").includes("# The spec"));
});

test("Review Focus 4: an assign with no file, and a release, empty the folder and push nothing", async () => {
  setup(FRESH);
  await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  assert.ok(joined().some((c) => c.endsWith(`-- rm -rf -- ${MISSION_FILES_DIR}`)));
  assert.ok(!joined().some((c) => c.includes("file push") && c.includes(MISSION_FILES_DIR)));
  setup();
  await call(CONTROL, { op: "release", to: E1 });
  assert.ok(joined().some((c) => c.endsWith(`-- rm -rf -- ${MISSION_FILES_DIR}`)));
});

test("a mission file over 262 144 bytes, or holding a secret, is refused", async () => {
  const over = await call(CONTROL, { op: "assign", to: E1, mission: spec({ files: files({ split: "x".repeat(262_145) }) }) });
  assert.deepEqual(over, { ok: false, error: "assign: mission.files.split is longer than 262144 bytes" });
  const secret = await call(CONTROL, { op: "assign", to: E1, mission: spec({ files: files({ answers: "tok-123" }) }) });
  assert.equal(secret.ok, false);
  assert.match((secret as { error: string }).error, /mission\.files\.answers holds a secret/);
});

test("the mission files live under /etc/forge, a root-owned parent outside aiuser's home, created by root first", async () => {
  assert.equal(MISSION_FILES_DIR, "/etc/forge/mission");
  setup(FRESH);
  await call(CONTROL, { op: "assign", to: E1, mission: spec() });
  const calls = joined();
  const parent = calls.findIndex((c) => c === `incus --project agent-forge exec ${E1} -- install -d -o root -g root -m 755 -- /etc/forge`);
  const mk = calls.findIndex((c) => c.endsWith(`-- mkdir -m 755 -- ${MISSION_FILES_DIR}`));
  assert.ok(parent >= 0 && mk > parent, calls.join("\n"));
  assert.ok(!calls.some((c) => c.includes("file push") && c.includes("/home/aiuser")), calls.join("\n"));
});

// --------------------------------------------------------------- ask : une question pour l'humain (décision 35)

test("ask with nothing committed is accepted and copies nothing; its event carries the question and the recommended answer", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "0\n" }]);
  const r = await call(E1, { op: "ask", text: "Which limit?", recommended: "100 per page" }) as unknown as { ok: boolean; id: number };
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!mirrorFetch());
  const ev = await call(CONTROL, { op: "events", after: 0 });
  assert.deepEqual(ev, { ok: true, events: [{
    id: r.id, kind: "ask", executor: E1, ticket: "T-1", subtask: "T-1.1", text: "Which limit?", recommended: "100 per page", mission: "dev",
  }], last: r.id });
  // L'hôte ne libère pas : c'est l'orchestrateur qui le fait.
  assert.deepEqual(JSON.parse(keys(E1)[MISSION_KEY]), held());
});

test("ask with commits copies the branch to the team mirror; recommended is optional (null)", async () => {
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" }]);
  assert.equal((await call(E1, { op: "ask", text: "Which limit?" })).ok, true);
  assert.ok(mirrorFetch());
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: { recommended: string | null }[] };
  assert.equal(ev.events[0].recommended, null);
});

test("ask on a dirty clone, without a mission, from the control, or holding a secret: refused, nothing journaled as ok", async () => {
  hold(E1, held());
  setup([{ match: "/workspace/web -c core.fsmonitor=false", stdout: " M a.ts\n" }]);
  const dirty = await call(E1, { op: "ask", text: "q" });
  assert.equal(dirty.ok, false);
  assert.match((dirty as { error: string }).error, /uncommitted changes: commit or discard them, then ask again/);
  setup();
  assert.deepEqual(await call(E2, { op: "ask", text: "q" }), { ok: false, error: `${E2} holds no mission: there is nothing to ask about` });
  assert.deepEqual(await call(CONTROL, { op: "ask", text: "q" }), { ok: false, error: "ask is not a verb of the control container" });
  const secret = await call(E1, { op: "ask", text: "q", recommended: "use tok-123" });
  assert.equal(secret.ok, false);
  assert.ok(!readFileSync(join(home, "api", "journal.jsonl"), "utf8").includes("tok-123"));
  assert.ok(d.journal.entries().every((e) => e.outcome === "refused"));
});

// ------------------------------------------------------- les trois genres

test("a qa assign detaches the clone on team/<branch> as aiuser, records no branch, starts the session", async () => {
  const r = await call(CONTROL, { op: "assign", to: E1, mission: spec({ kind: "qa", subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" }) });
  assert.deepEqual(r, { ok: true });
  const calls = joined();
  const sw = calls.find((c) => c.includes(`${GIT} switch`));
  assert.ok(sw?.endsWith("switch --detach team/agent/T-1.2"), calls.join("\n"));
  assert.ok(sw!.includes(`exec ${E1} --user 1001 --group 1001`), sw);
  assert.ok(calls.some((c) => c.endsWith(`${GIT} fetch team`)));
  assert.deepEqual(readBranchRecords(), []);
  assert.ok(calls.some((c) => c.includes("hc run") && c.includes("--cwd /workspace/web")));
  assert.equal(JSON.parse(keys(E1)[MISSION_KEY]).kind, "qa");
});

test("a qa assign on a clone with tracked changes, or on a branch the team mirror lacks, is refused", async () => {
  const qa = spec({ kind: "qa", subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" });
  setup([{ match: "status --porcelain", stdout: " M a.ts\n" }]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: qa }), { ok: false, error:
    `${E1}: /workspace/web has 1 uncommitted change: commit or discard them before assigning a QA mission` });
  setup([absent("refs/remotes/team/agent/T-1.2")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: qa }), { ok: false, error: "agent/T-1.2 is not in the team mirror of web" });
  assert.ok(!joined().some((c) => c.includes(" switch")));
  assert.equal(keys(E1)[MISSION_KEY], undefined);
});

test("a fix's dev mission works on the branch it fixes: its record keeps that sub-task; other branches and kinds are refused", async () => {
  setup([absent("refs/heads/agent/T-1.1")]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec({ subtask: "T-1.3", branch: "agent/T-1.1" }) }), { ok: true });
  assert.deepEqual(readBranchRecords(), [{ branch: "agent/T-1.1", repository: "web", ticket: "T-1", subtask: "T-1.1", base: "origin/main", executor: E1, builtOn: null }]);
  const assign = (m: unknown) => () => parseMissionRequest(JSON.stringify({ op: "assign", to: E1, mission: m }), "control", []);
  assert.throws(assign(spec({ subtask: "T-1.3", branch: "agent/T-2.1" })), /assign: mission\.branch must be agent\/<a sub-task of T-1>/);
  assert.throws(assign(spec({ kind: "rebase", subtask: "T-1.2", branch: "agent/T-1.1", base: "origin/main" })), /assign: branch must be agent\/T-1\.2/);
  assert.throws(assign({ ...spec(), kind: "review" }), /assign: mission\.kind must be "dev", "rebase" or "qa"/);
});

// ------------------------------------------- ce sur quoi une branche est posée

const SHA = "1".repeat(40);
const OLD = "2".repeat(40);
const record = (base = "origin/main") =>
  recordBranch({ branch: "agent/T-1.1", repository: "web", ticket: "T-1", subtask: "T-1.1", base, executor: E1 });

test("a done whose branch holds origin/main's tip records that commit and its published ref", async () => {
  record();
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" },
    { match: "rev-parse --verify --quiet refs/remotes/origin/main", stdout: `${SHA}\n` }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: true, id: 1 });
  assert.equal(branchRecord("web", "agent/T-1.1")?.builtOn, SHA);
  const calls = joined();
  assert.ok(calls.some((c) => c.endsWith(`${GIT} merge-base --is-ancestor ${SHA} agent/T-1.1`)), calls.join("\n"));
  const ref = calls.find((c) => c.endsWith(`${GIT} update-ref refs/forge/published/agent/T-1.1 refs/heads/agent/T-1.1`));
  assert.ok(ref?.includes(`exec ${E1} --user 1001 --group 1001`), calls.join("\n"));
});

test("a done on a branch that does not hold its base's tip leaves builtOn as it was", async () => {
  record();
  setBuiltOn("web", "agent/T-1.1", OLD);
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" },
    { match: "rev-parse --verify --quiet refs/remotes/origin/main", stdout: `${SHA}\n` }, notAncestor(SHA, "agent/T-1.1")]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: true, id: 1 });
  assert.equal(branchRecord("web", "agent/T-1.1")?.builtOn, OLD);
});

// Le clone garde une vieille copie d'une branche qu'un rebase a réécrite
// ailleurs : s'il a tout rendu (sa branche est sa réf publiée), la branche
// repart du miroir d'équipe ; sinon, le refus d'aujourd'hui.
const published = (same: boolean): ExecRule => ({
  match: "rev-parse refs/heads/agent/T-1.1 refs/forge/published/agent/T-1.1", stdout: same ? "abc\nabc\n" : "abc\ndef\n",
});

test("a local branch equal to its published ref, diverged from the team mirror, is recreated from it, on the branch or off it", async () => {
  for (const rules of [
    [onBranch, notAncestor(TEAM, "HEAD"), notAncestor("HEAD", TEAM)],
    [{ match: "symbolic-ref --short HEAD", stdout: "main\n" }, notAncestor("agent/T-1.1", TEAM), notAncestor(TEAM, "agent/T-1.1")],
  ] as ExecRule[][]) {
    setup([...rules, published(true)]);
    assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: true });
    assert.ok(joined().some((c) => c.endsWith(`${GIT} switch -C agent/T-1.1 team/agent/T-1.1`)), joined().join("\n"));
    await call(CONTROL, { op: "release", to: E1 });
  }
});

test("a local branch that differs from its published ref, diverged from the team mirror, is still refused", async () => {
  setup([onBranch, notAncestor(TEAM, "HEAD"), notAncestor("HEAD", TEAM), published(false)]);
  assert.deepEqual(await call(CONTROL, { op: "assign", to: E1, mission: spec() }), { ok: false, error: DIVERGED });
  assert.ok(!joined().some((c) => c.includes(" switch")));
});

// ------------------------------------------------ le rendu selon le genre

test("a QA report is checked field by field, each refusal naming its field", () => {
  const qa = (v: unknown) => () => parseQaReport(v, "T-1", ["tok-123"]);
  const defect = (over: Record<string, unknown> = {}) => ({ subtask: "T-1.1", text: "the list is empty", ...over });
  assert.throws(qa({ verdict: "ko", defects: [defect()], extra: 1 }), /qa: unknown field: "extra"/);
  assert.throws(qa({ verdict: "ko", defects: [] }), /qa\.defects: a ko report has 1 to 50 defects/);
  assert.throws(qa({ verdict: "ok", defects: [defect()] }), /qa\.defects: an ok report has no defect/);
  assert.throws(qa({ verdict: "ko", defects: [defect({ subtask: "T-2.1" })] }), /qa\.defects\[0\]\.subtask is not a sub-task of T-1/);
  assert.throws(qa({ verdict: "ko", defects: [defect(), defect({ text: "voici tok-123" })] }), /qa\.defects\[1\]\.text.*secret/);
  assert.throws(qa({ verdict: "ko", defects: Array.from({ length: 51 }, () => defect()) }), /qa\.defects: a ko report has 1 to 50 defects/);
  assert.throws(qa({ verdict: "maybe", defects: [] }), /qa\.verdict must be "ok" or "ko"/);
  assert.deepEqual(parseQaReport({ verdict: "ko", defects: [defect(), defect({ subtask: null })] }, "T-1", []),
    { verdict: "ko", defects: [defect(), defect({ subtask: null })] });
});

const qaHeld = () => held({ kind: "qa", subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" });
const rebaseHeld = () => held({ kind: "rebase", subtask: "T-1.2", branch: "agent/T-1.2", base: "agent/T-1.1" });
const KO = { verdict: "ko", defects: [{ subtask: "T-1.1", text: "empty" }, { subtask: null, text: "slow" }] };

test("a QA done with a valid ko report copies nothing, and its event carries the kind and the defects", async () => {
  hold(E1, qaHeld());
  assert.deepEqual(await call(E1, { op: "done", report: "ran it", qa: KO }), { ok: true, id: 1 });
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("fetch")), joined().join("\n"));
  const ev = await call(CONTROL, { op: "events", after: 0 });
  assert.deepEqual(ev, { ok: true, last: 1, events: [{
    id: 1, kind: "done", executor: E1, ticket: "T-1", subtask: "T-1.2", branch: "agent/T-1.2", report: "ran it", mission: "qa", qa: KO,
  }] });
  await withHost(async (host) => assert.deepEqual((await host.events(0)).events[0], (ev as { events: unknown[] }).events[0]));
});

test("a QA done without its report, a dev done carrying a report of QA: refused", async () => {
  hold(E1, qaHeld());
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error: "a QA mission ends with forge-team done --qa-report-file <file>" });
  hold(E1, held());
  setup([{ match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" }]);
  assert.deepEqual(await call(E1, { op: "done", qa: KO }), { ok: false, error: "this is not a QA mission" });
  assert.ok(d.journal.entries().every((e) => e.outcome !== "ok"));
});

test("a rebase done must stand on its base's tip, with a commit beyond it: refused and nothing copied otherwise", async () => {
  hold(E1, rebaseHeld());
  setup([notAncestor("team/agent/T-1.1", "agent/T-1.2"), { match: "rev-list --count", stdout: "1\n" }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error: "agent/T-1.2 does not stand on agent/T-1.1: rebase it, then report done again" });
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("fetch")));
  // Rendu vide : rien au-delà de la base, rien de copié.
  setup([{ match: "rev-list --count", stdout: "0\n" }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error: "nothing committed on agent/T-1.2 beyond agent/T-1.1" });
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("fetch") && c.includes("src")));
  setup([{ match: "rev-list --count", stdout: "1\n" }]);
  // Les refus d'avant ont pris les ids 1 et 2 du journal.
  assert.deepEqual(await call(E1, { op: "done", report: "no conflict" }), { ok: true, id: 3 });
  assert.ok(ctx.calls.some((c) => c[0] === "git" && c.at(-1) === "+refs/heads/agent/T-1.2:refs/heads/agent/T-1.2"));
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: { mission: string }[] };
  assert.equal(ev.events[0].mission, "rebase");
});

// ------------------------------------------------------------- le verbe stack

const tipRule = (mirror: string, ref: string, sha: string | null): ExecRule => ({
  match: `--git-dir=${mirror} rev-parse --verify --quiet ${ref}`, ...(sha === null ? { code: 1 } : { stdout: `${sha}\n` }),
});
const STACK = [
  { repository: "web", branch: "agent/T-1.1", base: "origin/main" },
  { repository: "web", branch: "agent/T-1.2", base: "agent/T-1.1" },
];

test("stack: each branch against the tip of its base today, from the host's mirrors, without a journal line", async () => {
  const TEAM_TIP = "3".repeat(40);
  recordBranch({ branch: "agent/T-1.1", repository: "web", ticket: "T-1", subtask: "T-1.1", base: "origin/main", executor: E1 });
  setBuiltOn("web", "agent/T-1.1", SHA);
  recordBranch({ branch: "agent/T-1.2", repository: "web", ticket: "T-1", subtask: "T-1.2", base: "agent/T-1.1", executor: E2 });
  setBuiltOn("web", "agent/T-1.2", OLD);
  setup([tipRule(repoOriginMirror("web"), "refs/heads/main", SHA), tipRule(repoTeamMirror("web"), "refs/heads/agent/T-1.1", TEAM_TIP)]);
  assert.deepEqual(await call(CONTROL, { op: "stack", branches: STACK }), { ok: true, branches: [
    { branch: "agent/T-1.1", current: true, builtOn: SHA },
    { branch: "agent/T-1.2", current: false, builtOn: OLD },
  ] });
  assert.ok(ctx.calls.every((c) => c[0] !== "incus"), joined().join("\n"));
  assert.deepEqual(d.journal.entries(), []);
  await withHost(async (host) => assert.deepEqual((await host.stack(STACK)).map((x) => x.current), [true, false]));
});

test("stack: a branch without a record is not current; one the team mirror lacks is refused; an executor may not ask", async () => {
  setup([tipRule(repoOriginMirror("web"), "refs/heads/main", SHA)]);
  assert.deepEqual(await call(CONTROL, { op: "stack", branches: [STACK[0]] }), { ok: true, branches: [
    { branch: "agent/T-1.1", current: false, builtOn: null },
  ] });
  setup([tipRule(repoTeamMirror("web"), "refs/heads/agent/T-1.2", null)]);
  assert.deepEqual(await call(CONTROL, { op: "stack", branches: STACK }), { ok: false, error: "agent/T-1.2 is not in the team mirror of web" });
  assert.deepEqual(await call(E1, { op: "stack", branches: STACK }), { ok: false, error: "stack is not a verb of the executor container" });
  const many = Array.from({ length: 51 }, () => STACK[0]);
  assert.deepEqual(await call(CONTROL, { op: "stack", branches: many }), { ok: false, error: "stack: branches must be a list of at most 50" });
  assert.deepEqual(await call(CONTROL, { op: "stack", branches: [{ ...STACK[0], repository: "nope" }] }),
    { ok: false, error: "repository nope is not declared in the project" });
});

test("a rebase mission stopped by a question (rebase aborted, so not on its base) may still ask", async () => {
  hold(E1, rebaseHeld());
  setup([notAncestor("team/agent/T-1.1", "agent/T-1.2"), { match: "rev-list --count", stdout: "1\n" }]);
  assert.deepEqual(await call(E1, { op: "ask", text: "Which side of the conflict?" }), { ok: true, id: 1 });
});

// Un correctif travaille sur la branche de la sous-tâche qu'il corrige : ses
// commits à elle sont déjà au-delà de la base.
test("a fix done with nothing beyond what the team mirror holds of its branch is refused; with a commit, accepted", async () => {
  const fix = held({ subtask: "T-1.3", branch: "agent/T-1.1" });
  hold(E1, fix);
  const TIP = "4".repeat(40);
  const inTeam = tipRule(repoTeamMirror("web"), "refs/heads/agent/T-1.1", TIP);
  setup([inTeam, { match: "rev-list --count origin/main..agent/T-1.1", stdout: "2\n" }, { match: `rev-list --count ${TIP}..agent/T-1.1`, stdout: "0\n" }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: false, error:
    "nothing committed on agent/T-1.1 beyond team/agent/T-1.1: a fix adds its own commits" });
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("src")));
  setup([inTeam, { match: "rev-list --count origin/main..agent/T-1.1", stdout: "3\n" }, { match: `rev-list --count ${TIP}..agent/T-1.1`, stdout: "1\n" }]);
  assert.deepEqual(await call(E1, { op: "done" }), { ok: true, id: 2 });
});


test("a QA may ask: nothing copied, its event says it is a QA's; on a dirty clone, refused", async () => {
  hold(E1, qaHeld());
  setup([{ match: "status --porcelain", stdout: " M greet.sh\n" }]);
  const dirty = await call(E1, { op: "ask", text: "Does an empty name greet the world?" }) as { ok: boolean; error?: string };
  assert.equal(dirty.ok, false);
  assert.match(dirty.error!, /has uncommitted changes: discard them, then ask again$/);
  setup([]);
  const r = await call(E1, { op: "ask", text: "Does an empty name greet the world?" }) as unknown as { ok: boolean; id: number };
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("fetch")), joined().join("\n"));
  const ev = await call(CONTROL, { op: "events", after: 0 }) as unknown as { events: unknown[] };
  assert.deepEqual(ev.events, [{
    id: r.id, kind: "ask", executor: E1, ticket: "T-1", subtask: "T-1.2", text: "Does an empty name greet the world?", recommended: null, mission: "qa",
  }]);
  await withHost(async (host) => assert.deepEqual((await host.events(0)).events, ev.events));
});
