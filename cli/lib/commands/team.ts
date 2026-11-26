// forge team converge | status | sync | assign | release | for-repo |
// task-base | upload-pack, du côté de l'hôte : un projet (forge à tickets),
// c'est-à-dire un container de contrôle, N exécuteurs, et par dépôt un miroir
// d'origine et un miroir des agents. Les missions viennent de l'orchestrateur
// du contrôle, par l'API ; `assign` et `release` sont la main de l'humain sur un
// exécuteur, sans l'orchestrateur.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { restartApiService } from "../api/access.ts";
import { Journal, journalPath } from "../api/journal.ts";
import { cloneStates, humanAssign, humanRelease, MISSION_KEY, readHeld } from "../api/missions.ts";
import { INSTRUCTION_MAX } from "../api/protocol.ts";
import { readBranchRecords } from "../branch-records.ts";
import type { ForgeConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { provisioningMarker } from "../containers.ts";
import { readEnvFile } from "../dotenv.ts";
import { sessionState, type SessionState } from "../hc-session.ts";
import { forgeProject, listInstances, type Instance } from "../incus.ts";
import { fetchMirrorLfs, refreshMirror } from "../mirror.ts";
import type { HeldMission } from "../orchestrator/host.ts";
import { configPath } from "../paths.ts";
import { printableText } from "../printable.ts";
import { ensureRepoMirrors, projectMembers, repoOriginMirror, repoTeamMirror, type ProjectMember } from "../project.ts";
import type { ProjectConfig } from "../project-config.ts";
import {
  convergeControl, convergeExecutor, orchestratorState, provisionControl, provisionExecutor, type OrchestratorState,
} from "../project-provision.ts";
import { columnWidths, formatRow } from "../table.ts";
import { hostReserveBytes, memoryWarning } from "../team-memory.ts";
import { validateGitRef } from "../validate.ts";
import { handedOutSecrets } from "./api.ts";
import { requireHostLfs } from "./provision.ts";

const USAGE = `Usage: forge team converge
       forge team status [--json] [--quick]
       forge team sync <repository>
       forge team assign <executor> <sub-task> [--repository <name>] [--base <ref>]   (the instruction is read from stdin)
       forge team release <executor>
       forge team for-repo <owner/repo> | task-base <repository> | upload-pack <repository>   (read by forge fetch and forge ship)`;

// `hostMemory` : la RAM de l'hôte, en octets ; les tests la fixent.
export type TeamOptions = {
  json?: boolean; quick?: boolean; repository?: string; base?: string; stdin?: () => Promise<string>; hostMemory?: number;
};

// Ce que `forge team status --json` dit d'un membre d'un projet.
export type ProjectMemberStatus = {
  name: string; kind: ProjectMember["kind"]; present: boolean;
  mission: HeldMission | null; // celle d'un exécuteur ; toujours null pour le contrôle
  session: SessionState; // "none" quand il est absent ou arrêté
  // Le contrôle seul : l'état du service forge-orchestrator ; "inactive"
  // quand le container est absent ou arrêté.
  orchestrator?: OrchestratorState;
};
export type ProjectStatus = { members: ProjectMemberStatus[] };

const SUBCOMMANDS = ["converge", "status", "sync", "assign", "release", "for-repo", "task-base", "upload-pack"];

export async function cmdTeam(ctx: Context, args: string[], opts: TeamOptions = {}): Promise<number> {
  const [sub, a, b] = args;
  if (!SUBCOMMANDS.includes(sub ?? "")) throw new ForgeError(USAGE);
  if (opts.json && sub !== "status") throw new ForgeError(`--json only goes with status: forge team status --json\n${USAGE}`);
  if (opts.quick && sub !== "status") throw new ForgeError(`--quick only goes with status: forge team status --quick\n${USAGE}`);
  if ((opts.repository !== undefined || opts.base !== undefined) && sub !== "assign") {
    throw new ForgeError(`--repository and --base only go with assign\n${USAGE}`);
  }
  const cfg = loadConfig(configPath());
  // Lu par une machine (forge fetch) : sans projet, pas de message sur stdout.
  if (cfg.project === null) {
    if (sub === "for-repo") return 1;
    throw new ForgeError(`no project in ${configPath()}: declare "project" there first (see the README).`);
  }
  const p = cfg.project;
  switch (sub) {
    case "converge": return converge(ctx, p, cfg, a, opts);
    case "status": return status(ctx, p, opts.json === true);
    case "sync": return sync(ctx, p, a);
    case "assign": return assignCommand(ctx, p, a, b, opts);
    case "release": return releaseCommand(ctx, p, a);
    case "for-repo": return forRepo(ctx, p, a);
    case "task-base": return taskBase(ctx, p, a);
    default: return uploadPack(ctx, p, a);
  }
}

async function readStdin(): Promise<string> {
  // Un terminal ne donne pas de consigne : le dire plutôt qu'attendre sans rien afficher.
  if (process.stdin.isTTY) throw new ForgeError("the instruction is read from stdin: forge team assign <executor> <sub-task> < instruction.md");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > INSTRUCTION_MAX) throw new ForgeError(`the instruction is longer than ${INSTRUCTION_MAX} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// La main de l'humain sur un exécuteur (spec §6.10) : une mission `dev` de la
// sous-tâche, sa consigne lue sur stdin. Le dépôt et la base viennent des
// options, sinon de la fiche de la branche (une sous-tâche déjà confiée), sinon
// du seul dépôt du projet et de origin/main. Ni l'orchestrateur ni les tickets
// ne sont consultés ; l'hôte garde ses propres refus (un exécuteur occupé, une
// sous-tâche tenue ailleurs).
async function assignCommand(
  ctx: Context, p: ProjectConfig, to: string | undefined, subtask: string | undefined, opts: TeamOptions,
): Promise<number> {
  if (to === undefined || subtask === undefined) throw new ForgeError(`an executor and a sub-task are required.\n${USAGE}`);
  const record = readBranchRecords().find((r) => r.branch === `agent/${subtask}`);
  const repos = Object.keys(p.repositories);
  const repository = opts.repository ?? record?.repository ?? (repos.length === 1 ? repos[0] : undefined);
  if (repository === undefined) {
    throw new ForgeError(`the project has several repositories: say which one with --repository (${repos.join(", ")})`);
  }
  const base = opts.base ?? record?.base ?? "origin/main";
  if (opts.base !== undefined) validateGitRef(base);
  const instruction = await (opts.stdin ?? readStdin)();
  const mission = {
    kind: "dev", ticket: subtask.slice(0, Math.max(0, subtask.indexOf("."))), subtask, repository,
    branch: `agent/${subtask}`, base, instruction,
    // La main de l'humain n'envoie aucun fichier de mission.
    files: { spec: null, answers: null, split: null },
  };
  await humanAssign(ctx, p, Journal.open(journalPath()), handedOutSecrets(ctx), to, mission);
  ctx.out(`Assigned ${subtask} to ${to} (${repository}, from ${base}).`);
  return 0;
}

async function releaseCommand(ctx: Context, p: ProjectConfig, to: string | undefined): Promise<number> {
  if (to === undefined) throw new ForgeError(`an executor is required.\n${USAGE}`);
  await humanRelease(ctx, p, Journal.open(journalPath()), to);
  ctx.out(`Released ${to}.`);
  return 0;
}

function requireRepository(p: ProjectConfig, name: string | undefined): string {
  if (name === undefined || !Object.hasOwn(p.repositories, name)) {
    throw new ForgeError(`${name === undefined ? "a repository name is required" : `${name} is not a repository of the project`} ` +
      `(declared: ${Object.keys(p.repositories).join(", ")}).\n${USAGE}`);
  }
  return name;
}

// La mission que tient un exécuteur (MISSION_KEY), lue comme l'API la lit ;
// "unreadable" pour une valeur abîmée, qui n'est ni libre ni lisible.
const heldMission = (i: Instance | undefined) => readHeld(i?.config[MISSION_KEY]);

function missionLabel(m: ProjectMember, held: HeldMission | null | "unreadable"): string {
  if (m.kind === "control") return "-";
  if (held === "unreadable") return "unreadable";
  return held === null ? "free" : `${held.subtask} (${held.repository})`;
}

// Les miroirs de chaque dépôt (l'agent SSH transmis), puis chaque membre :
// absent, il est provisionné ; à moitié provisionné, laissé tel quel ; présent,
// il reçoit les fichiers, devices et clones de la version courante. converge ne
// supprime jamais un container, et ne remplit pas les miroirs des agents : c'est
// le `done` de l'API qui y range une branche.
async function converge(ctx: Context, p: ProjectConfig, cfg: ForgeConfig, team: string | undefined, opts: TeamOptions): Promise<number> {
  if (team !== undefined) {
    throw new ForgeError(`a project converges as a whole: forge team converge, without a team (got ${printableText(team)}).\n${USAGE}`);
  }
  // Un .env illisible, ouvert aux autres ou mal formé arrête tout, avant le premier container.
  if (p.executors.env !== null) readEnvFile(p.executors.env);
  if (Object.values(p.repositories).some((r) => r.lfs)) await requireHostLfs(ctx);
  await ensureRepoMirrors(ctx, p);

  const existing = new Map((await listInstances(ctx)).map((i) => [i.name, i]));
  const wanted = projectMembers(p);
  for (const m of wanted) {
    if (!existing.has(m.name)) {
      await (m.kind === "control" ? provisionControl : provisionExecutor)(ctx, cfg, m);
      continue;
    }
    if (await provisioningMarker(ctx, m.name) !== null) {
      ctx.err(`WARNING: ${m.name} is half-provisioned: left as is. Delete it (incus --project ${forgeProject()} delete ${m.name} --force) and run converge again.`);
      continue;
    }
    ctx.out(`Updating ${m.name}...`);
    await (m.kind === "control" ? convergeControl : convergeExecutor)(ctx, cfg, m);
  }
  // Le service ne connaît que les membres de la config qu'il a lue au démarrage.
  await restartApiService(ctx);

  const instances = new Map((await listInstances(ctx)).map((i) => [i.name, i]));
  printTable(ctx, wanted.map((m) => [m.name, m.kind, instances.get(m.name)?.status ?? "Missing", missionLabel(m, heldMission(instances.get(m.name)))]));
  // Un exécuteur en trop (count abaissé) reste : son clone peut porter du travail.
  const declared = new Set(wanted.map((m) => m.name));
  for (const i of instances.values()) {
    const role = i.config["user.forge.role"];
    if ((role === "executor" || role === "control") && !declared.has(i.name)) ctx.out(`${i.name}: not in the config, left as is`);
  }
  // Un avertissement, jamais un refus : les limites ne sont pas toutes atteintes en même temps.
  const overbooked = memoryWarning(cfg, await hostReserveBytes(ctx), opts.hostMemory);
  if (overbooked !== null) ctx.err(overbooked);
  return 0;
}

function printTable(ctx: Context, rows: string[][], head = ["NAME", "KIND", "STATUS", "MISSION"]): void {
  const table = rows.map((r) => r.map(printableText));
  const widths = columnWidths([head, ...table]);
  ctx.out(formatRow(head, widths));
  for (const row of table) ctx.out(formatRow(row, widths));
}

// Aucun miroir à rafraîchir en mode projet : `--quick` ne retire rien.
async function status(ctx: Context, p: ProjectConfig, json: boolean): Promise<number> {
  const instances = new Map((await listInstances(ctx)).map((i) => [i.name, i]));
  const members: ProjectMemberStatus[] = [];
  const rows: string[][] = [];
  for (const m of projectMembers(p)) {
    const inst = instances.get(m.name);
    const held = m.kind === "executor" ? heldMission(inst) : null;
    if (held === "unreadable") ctx.err(`WARNING: ${m.name} has an unreadable ${MISSION_KEY}: release it.`);
    const session = inst?.status === "Running" ? await sessionState(ctx, m.name) : "none";
    // L'agent attend à son écran (l'écran de confiance de Claude Code, une
    // question) : la mission n'avance plus sans l'humain.
    if (m.kind === "executor" && held !== null && held !== "unreadable" && session === "blocked") {
      ctx.err(`WARNING: ${m.name} holds ${held.subtask} but its agent is blocked, waiting for an answer on its screen: read it with hc read <machine>/agent`);
    }
    // Un exécuteur libre dont un clone a des changements suivis refuserait
    // toute mission : l'API le dit `unknown` à l'orchestrateur, qui ne lui en
    // donne plus ; l'humain, lui, l'apprend ici.
    if (m.kind === "executor" && held === null && inst?.status === "Running") {
      for (const c of await cloneStates(ctx, m.name, p)) {
        if (c.state === "clean") continue;
        ctx.err(c.state === "dirty"
          ? `WARNING: ${m.name} is free but /workspace/${c.repository} has uncommitted changes: it gets no mission until they are committed or discarded.`
          : `WARNING: ${m.name} is free but git status in /workspace/${c.repository} failed or did not answer: it gets no mission until it does.`);
      }
    }
    const row: ProjectMemberStatus = { name: m.name, kind: m.kind, present: inst !== undefined, mission: held === "unreadable" ? null : held, session };
    let label = missionLabel(m, held);
    if (m.kind === "control") {
      row.orchestrator = inst?.status === "Running" ? await orchestratorState(ctx, m.name) : "inactive";
      label = `orchestrator ${row.orchestrator}`;
    }
    members.push(row);
    rows.push([m.name, m.kind, inst?.status ?? "Missing", session, label]);
  }
  if (json) {
    ctx.out(JSON.stringify({ members } satisfies ProjectStatus));
    return 0;
  }
  printTable(ctx, rows, ["NAME", "KIND", "STATUS", "SESSION", "MISSION"]);
  return 0;
}

// Le miroir d'origine d'un dépôt, depuis GitHub par l'agent SSH transmis.
async function sync(ctx: Context, p: ProjectConfig, name: string | undefined): Promise<number> {
  const repo = requireRepository(p, name);
  const { repo: ownerRepo, lfs } = p.repositories[repo];
  // Avant tout fetch : sans le paquet, l'étape LFS échouerait sur un message de git.
  if (lfs) await requireHostLfs(ctx);
  const hint = `Did your SSH agent reach the host? Run forge team sync ${repo} from your machine: it forwards the agent.`;
  const r = await refreshMirror(ctx, repoOriginMirror(repo), ownerRepo);
  if (r.code !== 0) throw new ForgeError(`refreshing the mirror of ${ownerRepo} failed: ${r.stderr.trim() || `exit code ${r.code}`}\n${hint}`);
  if (lfs) {
    const l = await fetchMirrorLfs(ctx, repoOriginMirror(repo), ownerRepo);
    if (l.code !== 0) throw new ForgeError(`fetching the LFS objects of ${ownerRepo} failed: ${l.stderr.trim() || `exit code ${l.code}`}\n${hint}`);
    if (l.warning) ctx.err(`WARNING: ${l.warning}`);
  }
  ctx.out(`Synced ${repo}.`);
  return 0;
}

// Le laptop demande quel dépôt du projet est son clone : le nom sur stdout
// (le remote forge-<nom> du clone), ou rien et 1.
async function forRepo(ctx: Context, p: ProjectConfig, ownerRepo: string | undefined): Promise<number> {
  if (ownerRepo === undefined) throw new ForgeError(`an owner/repo is required.\n${USAGE}`);
  const found = Object.entries(p.repositories).find(([, r]) => r.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (!found) return 1;
  ctx.out(found[0]);
  return 0;
}

// Une ligne `<sous-tâche>\t<base>` par branche `agent/<sous-tâche>` du dépôt,
// triées, depuis les enregistrements de branches : la forme que lisent fetch et
// ship (la tâche sans `agent/`, la base `origin/<b>` ou `agent/<x>`). Une base
// qui n'est pas une ref sûre est écartée (safeRef).
// Une valeur qui n'est pas une ref sûre se lit comme « inconnue » : le
// consommateur ne doit jamais recevoir de quoi injecter une option ou un
// séparateur de commande.
function safeRef(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    validateGitRef(value);
    return value;
  } catch {
    return "";
  }
}

async function taskBase(ctx: Context, p: ProjectConfig, name: string | undefined): Promise<number> {
  const repo = requireRepository(p, name);
  const bases = new Map<string, string>();
  for (const r of readBranchRecords()) {
    if (r.repository !== repo || !r.branch.startsWith("agent/")) continue;
    const base = safeRef(r.base);
    if (base) bases.set(r.branch.slice("agent/".length), base);
  }
  for (const task of [...bases.keys()].sort()) ctx.out(`${task}\t${bases.get(task)}`);
  return 0;
}

// Invoqué par le `git fetch` du laptop (remote.forge-<nom>.uploadpack) : le
// miroir des agents du dépôt, tel que les `done` l'ont rempli. stdout porte le
// protocole git : rien n'y est écrit avant l'attach. Le chemin que git ajoute est ignoré.
async function uploadPack(ctx: Context, p: ProjectConfig, name: string | undefined): Promise<number> {
  const repo = requireRepository(p, name);
  const protocol = process.env.GIT_PROTOCOL;
  const env = protocol !== undefined && /^version=[0-9]$/.test(protocol) ? { GIT_PROTOCOL: protocol } : undefined;
  return ctx.attach(["git", "-c", "core.hooksPath=/dev/null", "upload-pack", repoTeamMirror(repo)], env ? { env } : undefined);
}
