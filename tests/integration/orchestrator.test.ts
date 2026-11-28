// De bout en bout (forge à tickets, plan 1d) : des tickets Markdown aux
// branches empilées, avec le vrai service de l'orchestrateur, sur un Incus
// jetable, opt-in.
//
//   FORGE_INTEGRATION=1 node --test --test-concurrency=1 tests/integration/orchestrator.test.ts
//
// Le même montage que project.test.ts (project-lib.ts) : un projet Incus
// jetable, forge-selftest-orchestrator, un miroir d'origine tiré d'un dépôt
// local, l'API servie dans ce process. Ici, l'orchestrateur n'est pas arrêté :
// le service forge-orchestrator du contrôle lit la base des tickets et
// distribue. Aucun Claude : le forge-agent de chaque exécuteur ne fait que
// dormir (la session reste vivante, la reprise reste muette), et la suite joue
// l'agent : un commit sur la branche de la mission, puis `forge-team done`.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executorName } from "../../cli/lib/project.ts";
import { openMarkdownBase } from "../../cli/lib/tickets/markdown-base.ts";
import { ENABLED, must, raw, run } from "./lib.ts";
import { REPO, git, pause, projectHarness, type ProjectHarness } from "./project-lib.ts";

const PROJECT = "forge-selftest-orchestrator";
// Les suites incus (1, 2), egress (3) et project (4) ont les leurs.
const SLOT = "5";
const EXECUTORS = [executorName(1), executorName(2)];
const TICKETS = ["T-1", "T-2"];
const SUBTASKS = TICKETS.flatMap((t) => [`${t}.1`, `${t}.2`]);
// L'attente bornée de la brique (3 min), un coup d'œil toutes les 2 s.
const DEADLINE_MS = 180_000;
const POLL_MS = 2_000;

const h: ProjectHarness | null = ENABLED ? projectHarness(PROJECT, SLOT, EXECUTORS.length) : null;

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  h!.before();
});

after(async () => {
  if (h) await h.after();
});

// Les fichiers tels que l'humain les écrit : un ticket `dev` d'un dépôt sur
// `main`, deux sous-tâches `ready` du même dépôt (positions 1 et 2 : la
// seconde s'empile sur la première).
function writeTicket(base: string, id: string) {
  const dir = join(base, id);
  mkdirSync(join(dir, "subtasks"), { recursive: true });
  writeFileSync(join(dir, "ticket.md"),
    `id: ${id}\ntitle: Ticket ${id}\nstatus: dev\npriority: 0\nrepositories: ${REPO}:main\n\nLe ticket ${id}, de bout en bout.\n`);
  for (const k of [1, 2]) {
    writeFileSync(join(dir, "subtasks", `${k}.md`),
      `id: ${id}.${k}\nrepository: ${REPO}\nposition: ${k}\nrank: ${k}\nstatus: ready\nkind: implementation\n` +
      `fixes:\nreason:\nbranch:\npr:\n\nÉcris ${id}.${k}.txt.\n`);
  }
}

// Tous les fichiers de la base, pour le message d'un échec.
function dumpBase(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`--- ${relative(dir, p)}\n${readFileSync(p, "utf8")}`);
    }
  };
  try {
    walk(dir);
  } catch (e) {
    out.push(`(cannot read ${dir}: ${String(e)})`);
  }
  return out.join("\n");
}

// La mission que tient un exécuteur, d'après `forge-team status` (par l'API) :
// son genre et son id (la sous-tâche, ou le ticket d'une QA), ou null.
async function heldBy(name: string): Promise<{ kind: string; id: string } | null> {
  const r = must(`forge-team status in ${name}`, await h!.asAiuser(name, ["forge-team", "status"]));
  const m = /^mission: (?:(rebase|qa) )?(\S+)/m.exec(r.stdout);
  assert.ok(m, raw(`forge-team status in ${name}`, r));
  return m[2] === "none" ? null : { kind: m[1] ?? "dev", id: m[2] };
}

test("tickets in a Markdown base become stacked branches through the real orchestrator", { skip: !ENABLED }, async (t: TestContext) => {
  if (!h!.prepareImage()) return t.skip("no agent-base in project agent-forge (run 'forge image build')");
  const cfg = h!.seed();

  const converged = h!.forge(["team", "converge"]);
  if (converged.status !== 0 && /the image has no forge-orch user/.test(converged.stderr)) {
    return t.skip("agent-base has no forge-orch user: run 'forge image build' with this branch");
  }
  must("team converge", converged);

  // Une session sans modèle : forge-agent dort, la session reste vivante.
  for (const name of EXECUTORS) h!.stubAgent(name, "#!/bin/sh\nexec sleep infinity\n");

  // Les tickets, en fichiers dans le dossier de l'hôte, comme l'humain les écrit.
  for (const id of TICKETS) writeTicket(h!.ticketBase, id);

  // Le service tourne (ses tours échouent tant que l'API ne répond pas), puis l'API.
  await h!.waitOrchestratorActive();
  await h!.serve(cfg);

  // La suite joue l'agent de chaque exécuteur qui tient une mission : un
  // commit sur la branche de la mission, puis `done`. Une sous-tâche n'est
  // jouée qu'une fois : l'exécuteur la tient encore jusqu'au tour suivant.
  const base = openMarkdownBase(h!.ticketBase);
  const played = new Set<string>();
  const deadline = Date.now() + DEADLINE_MS;
  let finished = false;
  while (!finished && Date.now() < deadline) {
    for (const name of EXECUTORS) {
      // Une QA (un ticket arrivé en `qa`) reste tenue : l'agent factice ne la rend pas.
      const held = await heldBy(name);
      if (held === null || held.kind !== "dev" || played.has(held.id)) continue;
      const s = held.id;
      const clone = `/workspace/${REPO}`;
      assert.equal(must(`branch of ${name}`, await h!.asAiuser(name, ["git", "-C", clone, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(),
        `agent/${s}`);
      must(`commit ${s} in ${name}`, await h!.asAiuser(name, ["sh", "-c",
        `cd ${clone} && echo '${s}' > '${s}.txt' && git add '${s}.txt' && git commit -q -m '${s}'`]));
      must(`forge-team done for ${s} in ${name}`, await h!.asAiuser(name, ["forge-team", "done"]));
      played.add(s);
    }
    const { tickets } = await base.listTickets({ status: ["qa"] });
    finished = TICKETS.every((id) => tickets.some((x) => x.id === id));
    if (!finished) await pause(POLL_MS);
  }
  if (!finished) {
    const journal = h!.inControl(["journalctl", "-u", "forge-orchestrator", "--no-pager", "-n", "50"]);
    assert.fail([
      `the tickets did not reach qa in ${DEADLINE_MS / 1000} s (played: ${[...played].join(", ") || "none"})`,
      raw("forge team status --json", h!.forge(["team", "status", "--json"])),
      raw("the orchestrator's journal", journal),
      `the ticket base:\n${dumpBase(h!.ticketBase)}`,
    ].join("\n"));
  }

  // Les tickets `qa`, chaque sous-tâche `done` avec le lien de sa branche.
  for (const id of TICKETS) {
    assert.equal((await base.getTicket({ id })).status, "qa", dumpBase(h!.ticketBase));
    const subtasks = await base.listSubtasks({ ticket: id });
    assert.deepEqual(subtasks.map((s) => [s.id, s.status, s.branch]),
      [1, 2].map((k) => [`${id}.${k}`, "done", `agent/${id}.${k}`]), dumpBase(h!.ticketBase));
  }
  assert.deepEqual([...played].sort(), SUBTASKS);
  // Chaque branche au miroir des agents ; la sous-tâche 2 descend de la 1.
  const mirror = h!.teamMirror;
  for (const s of SUBTASKS) git(["--git-dir", mirror, "rev-parse", "--verify", `refs/heads/agent/${s}`], h!.root);
  for (const id of TICKETS) {
    const ancestor = run("git", ["--git-dir", mirror, "merge-base", "--is-ancestor", `agent/${id}.1`, `agent/${id}.2`]);
    assert.equal(ancestor.status, 0, raw(`agent/${id}.2 does not descend from agent/${id}.1`, ancestor));
  }
  // Plus aucune mission de développement : un exécuteur ne tient plus, au plus, que la QA d'un ticket.
  for (const name of EXECUTORS) {
    const held = await heldBy(name);
    assert.ok(held === null || (held.kind === "qa" && TICKETS.includes(held.id)), `${name} still holds ${JSON.stringify(held)}`);
  }
});
