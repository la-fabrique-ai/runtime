// Layer 3 for the project model (forge à tickets, plans 1c and 3b): a control
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
// sleeps, so a session stays live without a model. The harness is shared with
// orchestrator.test.ts (project-lib.ts).
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hcArgv } from "../../cli/lib/hc-session.ts";
import { CONTROL, executorName } from "../../cli/lib/project.ts";
import { ENABLED, incus, must, raw, run } from "./lib.ts";
import { REPO, git, pause, projectHarness, type ProjectHarness } from "./project-lib.ts";

const PROJECT = "forge-selftest-project";
// Les suites incus (1, 2), egress (3) et orchestrator (5) ont les leurs.
const SLOT = "4";
const EX1 = executorName(1);
const EX2 = executorName(2);

// L'environnement jetable est posé au chargement : serveApi et le `forge` lancé le lisent.
const h: ProjectHarness | null = ENABLED ? projectHarness(PROJECT, SLOT, 2) : null;
const root = h?.root ?? "";
const forge = (args: string[]) => h!.forge(args);
const asAiuser = (name: string, argv: string[], input = "") => h!.asAiuser(name, argv, input);
const asOrch = (argv: string[], input = "") => h!.asOrch(argv, input);
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
  files: { spec: `# Spec de ${subtask}\n`, answers: null, split: null },
});
const hc = (name: string, args: string[]) => run("incus", hcArgv(name, args).slice(1));

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  h!.before();
});

after(async () => {
  if (h) await h.after();
});

test("a project: the control's socket and home, assign, done, a stacked sub-task, a resumed one, session states", { skip: !ENABLED }, async (t: TestContext) => {
  if (!h!.prepareImage()) return t.skip("no agent-base in project agent-forge (run 'forge image build')");

  // La config : un projet d'un dépôt et deux exécuteurs (une sous-tâche reprise
  // ailleurs demande un second exécuteur) ; le miroir d'origine tiré d'un dépôt local.
  const cfg = h!.seed();
  const teamMirror = h!.teamMirror;

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
  const inControl = h!.inControl;
  await h!.waitOrchestratorActive();
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
    h!.stubAgent(name, "#!/bin/sh\nprintf '\\033]7501;state=idle:app=stub\\033\\\\'\nexec sleep infinity\n");
  }

  await h!.serve(cfg);

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

  // Claude Code demande la confiance pour tout dossier non accepté : le clone,
  // où assign lance la session, l'est dans le vrai ~/.claude.json d'aiuser.
  const claudeJson = JSON.parse(must("read aiuser's .claude.json", await asAiuser(EX1, ["cat", "/home/aiuser/.claude.json"])).stdout);
  const trusted = claudeJson.projects?.[`/workspace/${REPO}`];
  assert.deepEqual([trusted?.hasTrustDialogAccepted, trusted?.hasCompletedProjectOnboarding], [true, true], JSON.stringify(claudeJson.projects));

  // Sous-tâche 1 : une branche neuve depuis origin/main, une session.
  let r = await orch({ op: "assign", to: EX1, mission: mission("T-1.1", "origin/main") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(must("branch of ex-1", await gitIn(EX1, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "agent/T-1.1");
  rows = await statusRows();
  assert.equal(rows[EX1].mission?.subtask, "T-1.1");
  assert.equal(rows[EX1].session, "idle", JSON.stringify(rows));
  // La copie des fichiers de mission : lisible par l'agent, pas modifiable.
  const spec = "/etc/forge/mission/spec.md";
  assert.equal(must("read spec.md", await asAiuser(EX1, ["cat", spec])).stdout, "# Spec de T-1.1\n");
  assert.notEqual((await asAiuser(EX1, ["sh", "-c", `echo x >> ${spec}`])).status, 0, "aiuser could write spec.md");

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

  // ---------------------------------------------------------------- partie 3
  // Une pile rebasée dans un exécuteur se reprend dans un autre, et une QA rend
  // son compte rendu. Le ticket T-2 : A (T-2.1) sur origin/main, B (T-2.2) sur A.
  must("discard ex-2's work", await gitIn(EX2, ["restore", "README.md"]));
  must("start ex-1", incus(PROJECT, ["start", EX1]));
  for (let i = 0; i < 60 && hc(EX1, ["ls"]).status !== 0; i++) await pause(1000);
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);
  const job = (kind: string, subtask: string, branch: string, base: string) => ({
    kind, ticket: "T-2", subtask, repository: REPO, branch, base, instruction: `${kind} ${subtask}.`,
    files: { spec: "# Spec de T-2\n", answers: null, split: null },
  });
  const A = "agent/T-2.1";
  const B = "agent/T-2.2";
  const commitIn = async (name: string, file: string) => {
    must(`commit ${file} in ${name}`, await asAiuser(name, ["sh", "-c", `cd /workspace/${REPO} && echo ${file} > ${file} && git add ${file} && git commit -q -m ${file}`]));
    return must(`head of ${name}`, await gitIn(name, ["rev-parse", "HEAD"])).stdout.trim();
  };
  const handBack = async (name: string, to: unknown) => {
    const a = await orch({ op: "assign", to: name, mission: to });
    assert.equal(a.ok, true, JSON.stringify(a));
  };
  const stackOf = async () => {
    const s = await orch({ op: "stack", branches: [
      { repository: REPO, branch: A, base: "origin/main" }, { repository: REPO, branch: B, base: A },
    ] });
    assert.equal(s.ok, true, JSON.stringify(s));
    return (s.branches as { current: boolean }[]).map((x) => x.current);
  };

  // A puis B, rendues depuis ex-1.
  await handBack(EX1, job("dev", "T-2.1", A, "origin/main"));
  const a1 = await commitIn(EX1, "a1.txt");
  must("done A", await asAiuser(EX1, ["forge-team", "done"]));
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);
  await handBack(EX1, job("dev", "T-2.2", B, A));
  const b1 = await commitIn(EX1, "b1.txt");
  must("done B", await asAiuser(EX1, ["forge-team", "done"]));
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);
  assert.deepEqual(await stackOf(), [true, true]);

  // Un correctif de A depuis ex-2 : un commit de plus sur A, rendu. B n'est plus à jour.
  await handBack(EX2, job("dev", "T-2.3", A, "origin/main"));
  assert.equal(must("A in ex-2", await gitIn(EX2, ["rev-parse", "HEAD"])).stdout.trim(), a1);
  const a2 = await commitIn(EX2, "a2.txt");
  must("done the fix", await asAiuser(EX2, ["forge-team", "done"]));
  assert.equal((await orch({ op: "release", to: EX2 })).ok, true);
  assert.deepEqual(await stackOf(), [true, false]);

  // Le rebase de B sur ex-2, qui n'en a aucune copie : rejoué sur A, rendu.
  await handBack(EX2, job("rebase", "T-2.2", B, A));
  assert.equal(must("B in ex-2", await gitIn(EX2, ["rev-parse", "HEAD"])).stdout.trim(), b1);
  must("fetch team in ex-2", await gitIn(EX2, ["fetch", "-q", "team"]));
  must("rebase B in ex-2", await gitIn(EX2, ["rebase", "-q", "--onto", `team/${A}`, a1]));
  const b2 = must("rebased B", await gitIn(EX2, ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(must("B's parent", await gitIn(EX2, ["rev-parse", "HEAD~1"])).stdout.trim(), a2);
  must("done the rebase", await asAiuser(EX2, ["forge-team", "done"]));
  assert.equal((await orch({ op: "release", to: EX2 })).ok, true);
  assert.deepEqual(await stackOf(), [true, true]);

  // ex-1 garde l'ancienne B, qu'il avait rendue : une mission sur B y démarre, sur la B rebasée.
  await handBack(EX1, job("dev", "T-2.2", B, A));
  assert.equal(must("B in ex-1", await gitIn(EX1, ["rev-parse", "HEAD"])).stdout.trim(), b2);
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);

  // La QA sur ex-1 : un HEAD détaché sur la pointe de B, puis son compte rendu.
  await handBack(EX1, job("qa", "T-2.2", B, A));
  assert.equal(must("ex-1 detached", await gitIn(EX1, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "HEAD");
  assert.equal(must("ex-1 on B's tip", await gitIn(EX1, ["rev-parse", "HEAD"])).stdout.trim(), b2);
  const qa = { verdict: "ko", defects: [{ subtask: "T-2.1", text: "a1.txt says a1" }] };
  must("write the QA report", await asAiuser(EX1, ["sh", "-c", "cat > /tmp/qa.json"], JSON.stringify(qa)));
  must("done the QA", await asAiuser(EX1, ["forge-team", "done", "--qa-report-file", "/tmp/qa.json"]));
  r = await orch({ op: "events", after: 0 });
  const last = (r.events as { mission: string; qa: unknown; subtask: string }[]).at(-1)!;
  assert.deepEqual([last.mission, last.subtask, last.qa], ["qa", "T-2.2", qa]);
  assert.equal((await orch({ op: "release", to: EX1 })).ok, true);
});
