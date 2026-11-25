// Layer 3 for the project model (forge à tickets, plan 1c): a control
// container and two executors on a real Incus, opt-in, on a disposable Incus.
//
//   FORGE_INTEGRATION=1 node --test --test-concurrency=1 tests/integration/project.test.ts
//
// The project's container names are fixed (agent-control, agent-executor-<n>):
// they cannot carry the test prefix, so everything happens in a throwaway Incus
// project, forge-selftest-project (its own proxy slot, a copy of agent-base),
// like incus.test.ts. Nothing talks to GitHub: the origin mirror is seeded from
// a local repository, and the token is a throwaway string. The converge is the
// real `forge team converge`; the API runs in this process (serveApi), with the
// same environment, as the forge-api service does. A session is never a real Claude: each
// executor's forge-agent is replaced by a stub that announces itself idle and
// sleeps, so a session stays live without a model.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../cli/lib/api/journal.ts";
import { hostSocketPath, serveApi } from "../../cli/lib/api/server.ts";
import { parseConfig } from "../../cli/lib/config.ts";
import { createContext } from "../../cli/lib/context.ts";
import { hcArgv } from "../../cli/lib/hc-session.ts";
import { CONTROL, executorName } from "../../cli/lib/project.ts";
import { ORCH_HOME, ORCH_USER } from "../../cli/lib/project-provision.ts";
import { ENABLED, FORGE, SENTINEL, copyImage, incus, must, raw, run, teardownProject, type Run } from "./lib.ts";

const PROJECT = "forge-selftest-project";
// Les suites incus (1, 2) et egress (3) ont les leurs.
const SLOT = "4";
const EX1 = executorName(1);
const EX2 = executorName(2);
const NAMES = [CONTROL, EX1, EX2];
const REPO = "web";

const saved: Record<string, string | undefined> = {};
const VARS = ["FORGE_INCUS_PROJECT", "FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_MIRRORS",
  "FORGE_WORKSPACES", "FORGE_API_RUNTIME", "FORGE_PROXY_SLOT", "INCUS_CONF", "FORGE_INVOKED_AS"] as const;
const root = ENABLED ? mkdtempSync(join(tmpdir(), "forge-selftest-project-")) : "";
const stop = new AbortController();
let served: Promise<void> | null = null;

// Le même environnement pour ce process (serveApi, et le `forge upload-pack`
// que lance un `done`) et pour le `forge` qu'il lance : un projet Incus, des
// dossiers et une config jetables. Le client incus garde sa configuration
// (INCUS_CONF), puisque XDG_CONFIG_HOME change.
if (ENABLED) {
  for (const k of VARS) saved[k] = process.env[k];
  Object.assign(process.env, {
    FORGE_INCUS_PROJECT: PROJECT,
    FORGE_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    FORGE_MIRRORS: join(root, "mirrors"),
    FORGE_WORKSPACES: join(root, "workspaces"),
    FORGE_API_RUNTIME: join(root, "run"),
    FORGE_PROXY_SLOT: SLOT,
    INCUS_CONF: process.env.INCUS_CONF ?? join(homedir(), ".config", "incus"),
    // Le `forge upload-pack` que lance un `done` (forgeCommand) : celui de ce
    // checkout, comme le service lancé par le shim, jamais un forge installé.
    FORGE_INVOKED_AS: FORGE,
  });
}

// `forge` en hôte. Un XDG_RUNTIME_DIR jetable : le `systemctl --user
// try-restart forge-api` de converge n'atteint pas le service de l'utilisateur
// (il avertit, et le service de ce test tourne ici).
const forge = (args: string[]) => run(FORGE, args, {
  env: { FORGE_SIDE: "host", XDG_RUNTIME_DIR: join(root, "xdg-runtime") }, timeout: 1_800_000,
});
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// L'API tourne dans ce process : un appel qui l'attend ne doit pas bloquer la
// boucle d'évènements (`run` de lib.ts est synchrone).
function runAsync(cmd: string, args: string[], input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
// `runuser` plutôt que `incus exec --user --group` : il garde les groupes
// supplémentaires (forge-orch est du groupe 1001, qui lui ouvre la base des tickets).
const execAs = (name: string, user: string, home: string, argv: string[], input = "") =>
  runAsync("incus", ["--project", PROJECT, "exec", name, "--env", `HOME=${home}`, "--", "runuser", "-u", user, "--", ...argv], input);
const asAiuser = (name: string, argv: string[], input = "") => execAs(name, "aiuser", "/home/aiuser", argv, input);
const asOrch = (argv: string[], input = "") => execAs(CONTROL, ORCH_USER, ORCH_HOME, argv, input);
const gitIn = (name: string, args: string[]) => asAiuser(name, ["git", "-C", `/workspace/${REPO}`, ...args]);

// Une requête d'une ligne sur la socket du container, comme le client de
// l'orchestrateur : la réponse sur stdout, ou le code de l'erreur de connexion
// sur stderr (sortie 2).
const CALL = `const net = require("net"); let i = "";
process.stdin.on("data", (c) => (i += c)).on("end", () => {
  const s = net.connect("/var/lib/forge/api.sock"); let o = ""; s.setEncoding("utf8");
  s.on("connect", () => s.write(i.trim() + "\\n"));
  s.on("data", (c) => (o += c));
  s.on("error", (e) => { process.stderr.write(String(e.code || e.message)); process.exit(2); });
  s.on("close", () => process.stdout.write(o));
});`;
type Reply = { ok: boolean; error?: string; [k: string]: unknown };
async function orch(req: unknown): Promise<Reply> {
  const r = must("a call as forge-orch", await asOrch(["node", "-e", CALL], JSON.stringify(req)));
  return JSON.parse(r.stdout) as Reply;
}
type Row = { name: string; mission: { subtask: string } | null; session: string };
async function statusRows(): Promise<Record<string, Row>> {
  const r = await orch({ op: "status" });
  assert.equal(r.ok, true, JSON.stringify(r));
  return Object.fromEntries((r.executors as Row[]).map((e) => [e.name, e]));
}

const mission = (subtask: string, base: string) => ({
  kind: "dev", ticket: "T-1", subtask, repository: REPO, branch: `agent/${subtask}`, base, instruction: `Fais ${subtask}.`,
});
const hc = (name: string, args: string[]) => run("incus", hcArgv(name, args).slice(1));

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  must("no usable incus client", run("incus", ["--version"]));
  removeOurs();
  teardownProject(PROJECT);
});

// Les noms du projet ne portent pas le préfixe : dans ce projet Incus jetable,
// tout est à nous ; la garde est le nom du projet.
function removeOurs() {
  assert.ok(PROJECT.startsWith("forge-selftest"));
  for (const name of NAMES) incus(PROJECT, ["delete", name, "--force"]);
}

after(async () => {
  if (!ENABLED) return;
  stop.abort();
  await served;
  removeOurs();
  teardownProject(PROJECT);
  rmSync(root, { recursive: true, force: true });
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("a project: the control's socket and home, assign, done, a stacked sub-task, a resumed one, session states", { skip: !ENABLED }, async (t: TestContext) => {
  if (incus("agent-forge", ["image", "info", "agent-base"]).status !== 0) {
    return t.skip("no agent-base in project agent-forge (run 'forge image build')");
  }

  // Le projet Incus : forge setup, puis l'image, dont on reporte le commit.
  must("forge setup", forge(["setup"]));
  must("copy agent-base", copyImage("agent-forge", PROJECT));
  const commit = incus("agent-forge", ["image", "get-property", "agent-base", "user.forge.commit"]).stdout.trim();
  if (commit) must("stamp the copy", incus(PROJECT, ["image", "set-property", "agent-base", "user.forge.commit", commit]));

  // La config : un projet d'un dépôt et deux exécuteurs (une sous-tâche reprise
  // ailleurs demande un second exécuteur).
  const rawCfg = {
    project: {
      repositories: { [REPO]: { repo: SENTINEL } },
      executors: { count: 2 },
      tickets: { base: join(root, "tickets") },
      gitIdentity: { name: "Selftest", email: "selftest@example.com" },
    },
  };
  mkdirSync(join(root, "config", "agent-forge"), { recursive: true });
  writeFileSync(join(root, "config", "agent-forge", "config.json"), JSON.stringify(rawCfg));
  const cfg = parseConfig("/c.json", rawCfg);

  // L'hôte : un token jetable, et le miroir d'origine tiré d'un dépôt local.
  mkdirSync(join(root, "home", ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(root, "home", ".config", "agent-forge", "claude-token"), "throwaway-token\n", { mode: 0o600 });
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(["init", "-q", "-b", "main", "."], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "."], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"], seed);
  const origin = join(root, "mirrors", `repo-${REPO}.git`);
  const teamMirror = join(root, "mirrors", `repo-${REPO}.agents.git`);
  mkdirSync(join(root, "mirrors"), { recursive: true });
  git(["clone", "-q", "--bare", seed, origin], root);
  git(["--git-dir", origin, "remote", "set-url", "origin", `git@github.com:${SENTINEL}.git`], root);

  const converged = forge(["team", "converge"]);
  if (converged.status !== 0 && /the image has no forge-orch user/.test(converged.stderr)) {
    return t.skip("agent-base has no forge-orch user: run 'forge image build' with this branch");
  }
  must("team converge", converged);
  for (const [name, kind] of [[CONTROL, "control"], [EX1, "executor"], [EX2, "executor"]]) {
    assert.match(converged.stdout, new RegExp(`^${name}\\s+${kind}\\s+Running\\s+${kind === "control" ? "-" : "free"}`, "m"), raw("converge", converged));
  }

  // L'orchestrateur tourne en service dans le contrôle, en forge-orch avec son
  // groupe supplémentaire 1001 (systemd fait initgroups), et `forge team status`
  // le dit. L'API ne tourne pas encore : ses tours échouent sans qu'il sorte.
  const inControl = (argv: string[]) => incus(PROJECT, ["exec", CONTROL, "--", ...argv]);
  let state = "";
  for (let i = 0; i < 50 && state !== "active"; i++) {
    state = inControl(["systemctl", "is-active", "forge-orchestrator"]).stdout.trim();
    if (state !== "active") await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(state, "active", raw("the orchestrator's journal", inControl(["journalctl", "-u", "forge-orchestrator", "--no-pager", "-n", "30"])));
  const mainPid = () => must("the orchestrator's MainPID",
    inControl(["systemctl", "show", "-p", "MainPID", "--value", "forge-orchestrator"])).stdout.trim();
  const pid = mainPid();
  assert.match(pid, /^[1-9][0-9]*$/);
  const proc = must("the orchestrator's /proc status", inControl(["cat", `/proc/${pid}/status`])).stdout;
  assert.match(proc, /^Uid:\s+1002\s/m, proc);
  const groups = (/^Groups:\s*(.*)$/m.exec(proc)?.[1] ?? "").trim().split(/\s+/);
  assert.ok(groups.includes("1001"), `Groups: ${groups.join(" ")}`);
  assert.equal(must("the orchestrator's command line", inControl(["cat", `/proc/${pid}/cmdline`])).stdout.split("\0").slice(0, 2).join(" "),
    "/usr/bin/node /opt/forge/orchestrator.ts");
  const statusJson = JSON.parse(must("team status --json", forge(["team", "status", "--json"])).stdout) as { members: { name: string; orchestrator?: string }[] };
  assert.equal(statusJson.members.find((m) => m.name === CONTROL)?.orchestrator, "active");
  // Un second converge sans changement ne le relance pas.
  must("second team converge", forge(["team", "converge"]));
  assert.equal(inControl(["systemctl", "is-active", "forge-orchestrator"]).stdout.trim(), "active");
  assert.equal(mainPid(), pid, "the second converge restarted the orchestrator");
  // La suite joue le rôle de l'orchestrateur sur la socket : le vrai, qui
  // reprendrait les missions perdues, s'arrête.
  must("stop the orchestrator", inControl(["systemctl", "stop", "forge-orchestrator"]));

  // Une session sans modèle : le forge-agent de chaque exécuteur se dit idle et dort.
  for (const name of [EX1, EX2]) {
    must(`a stub forge-agent in ${name}`, incus(PROJECT, ["file", "push", "-", `${name}/usr/local/bin/forge-agent`, "--uid", "0", "--gid", "0", "--mode", "755"],
      "#!/bin/sh\nprintf '\\033]7501;state=idle:app=stub\\033\\\\'\nexec sleep infinity\n"));
  }

  served = serveApi({
    ctx: createContext(), cfg, journal: Journal.open(join(root, "data", "agent-forge", "api", "journal.jsonl")), secrets: [], now: () => new Date(),
  }, stop.signal);
  for (let i = 0; i < 100 && !NAMES.every((n) => existsSync(hostSocketPath(n))); i++) await new Promise((r) => setTimeout(r, 50));

  // Le contrôle : la socket et la maison de l'orchestrateur sont à forge-orch seul.
  assert.equal(must("stat the control's socket", incus(PROJECT, ["exec", CONTROL, "--", "stat", "-c", "%u %g %a", "/var/lib/forge/api.sock"])).stdout.trim(),
    "1002 1002 600");
  const aiuserCall = await asAiuser(CONTROL, ["node", "-e", CALL], JSON.stringify({ op: "status" }));
  assert.equal(aiuserCall.status, 2, raw("aiuser reached the control's socket", aiuserCall));
  assert.match(aiuserCall.stderr, /EACCES/);
  const aiuserLs = await asAiuser(CONTROL, ["ls", "/var/lib/forge-orch"]);
  assert.notEqual(aiuserLs.status, 0, raw("aiuser listed the orchestrator's home", aiuserLs));
  assert.match(must("forge-orch lists its home", await asOrch(["ls", "/var/lib/forge-orch"])).stdout, /^tickets$/m);
  // La base des tickets : écrite par forge-orch, lisible et inscriptible par l'humain sur l'hôte.
  must("forge-orch writes a ticket", await asOrch(["sh", "-c", "echo t > /var/lib/forge-orch/tickets/T-1.md"]));
  writeFileSync(join(root, "tickets", "T-1.md"), "edited by the human\n");
  // Après l'humain, forge-orch réécrit le fichier (l'ACL par défaut) ; aiuser, lui, ne le lit pas.
  must("forge-orch rewrites the human's ticket", await asOrch(["sh", "-c", "echo again > /var/lib/forge-orch/tickets/T-1.md"]));
  assert.equal(readFileSync(join(root, "tickets", "T-1.md"), "utf8"), "again\n");
  const aiuserCat = await asAiuser(CONTROL, ["cat", "/var/lib/forge-orch/tickets/T-1.md"]);
  assert.notEqual(aiuserCat.status, 0, raw("aiuser read a ticket", aiuserCat));

  // Un exécuteur démarré, hc qui répond, sans terminal ni mission : `none`.
  let rows = await statusRows();
  assert.deepEqual([rows[EX1].session, rows[EX1].mission], ["none", null], JSON.stringify(rows));
  // Un exécuteur ne confie rien.
  const fromExecutor = await asAiuser(EX1, ["forge-team", "status"]);
  assert.match(must("forge-team status in an executor", fromExecutor).stdout, /^mission: none$/m);

  // Sous-tâche 1 : une branche neuve depuis origin/main, une session.
  let r = await orch({ op: "assign", to: EX1, mission: mission("T-1.1", "origin/main") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(must("branch of ex-1", await gitIn(EX1, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "agent/T-1.1");
  rows = await statusRows();
  assert.equal(rows[EX1].mission?.subtask, "T-1.1");
  assert.equal(rows[EX1].session, "idle", JSON.stringify(rows));

  // Rien de commité : `done` refusé. Puis un commit, et `done` le range au miroir des agents.
  const early = await asAiuser(EX1, ["forge-team", "done"]);
  assert.equal(early.status, 1, raw("done without a commit", early));
  assert.match(early.stderr, /nothing committed on agent\/T-1\.1 beyond origin\/main/);
  must("commit in ex-1", await asAiuser(EX1, ["sh", "-c", `cd /workspace/${REPO} && echo one > one.txt && git add one.txt && git commit -q -m one`]));
  const c1 = must("head of ex-1", await gitIn(EX1, ["rev-parse", "HEAD"])).stdout.trim();
  must("forge-team done", await asAiuser(EX1, ["forge-team", "done"]));
  assert.equal(git(["--git-dir", teamMirror, "rev-parse", "refs/heads/agent/T-1.1"], root), c1, "the team mirror lacks sub-task 1's commit");
  r = await orch({ op: "events", after: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual((r.events as { executor: string; subtask: string }[]).map((e) => [e.executor, e.subtask]), [[EX1, "T-1.1"]]);

  // Sous-tâche 2, empilée : sa branche part du commit de la sous-tâche 1.
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);
  r = await orch({ op: "assign", to: EX1, mission: mission("T-1.2", "agent/T-1.1") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(must("branch of ex-1", await gitIn(EX1, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "agent/T-1.2");
  assert.equal(must("head of ex-1", await gitIn(EX1, ["rev-parse", "HEAD"])).stdout.trim(), c1);

  // Sous-tâche 1 reprise sur un autre exécuteur : sa branche vient du miroir des agents, avec son commit.
  r = await orch({ op: "assign", to: EX2, mission: mission("T-1.1", "origin/main") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(must("branch of ex-2", await gitIn(EX2, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "agent/T-1.1");
  assert.equal(must("head of ex-2", await gitIn(EX2, ["rev-parse", "HEAD"])).stdout.trim(), c1);

  // Une mission tenue dont le terminal a disparu : `lost`. Un exécuteur arrêté : `unknown`.
  must("kill ex-2's session", hc(EX2, ["kill", "agent"]));
  must("remove ex-2's terminal", hc(EX2, ["rm", "agent"]));
  must("stop ex-1", incus(PROJECT, ["stop", EX1, "--force"]));
  rows = await statusRows();
  assert.deepEqual([rows[EX2].mission?.subtask, rows[EX2].session], ["T-1.1", "lost"], JSON.stringify(rows));
  assert.equal(rows[EX1].session, "unknown", JSON.stringify(rows));

  // La reprise, comme l'orchestrateur la fait : release puis assign de la même
  // mission. Le travail non commité de la session perdue reste tel quel.
  must("uncommitted work in ex-2", await asAiuser(EX2, ["sh", "-c", `cd /workspace/${REPO} && echo wip >> README.md`]));
  assert.equal((await orch({ op: "release", to: EX2 })).ok, true);
  r = await orch({ op: "assign", to: EX2, mission: mission("T-1.1", "origin/main") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(must("branch of ex-2", await gitIn(EX2, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "agent/T-1.1");
  assert.equal(must("status of ex-2", await gitIn(EX2, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim(), "M README.md");
  rows = await statusRows();
  assert.deepEqual([rows[EX2].mission?.subtask, rows[EX2].session], ["T-1.1", "idle"], JSON.stringify(rows));

  // Libre mais sale, ex-2 refuserait toute mission : `unknown`, jamais donné.
  assert.equal((await orch({ op: "release", to: EX2 })).ok, true);
  rows = await statusRows();
  assert.deepEqual([rows[EX2].mission, rows[EX2].session], [null, "unknown"], JSON.stringify(rows));
});
