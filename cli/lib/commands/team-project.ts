// forge team converge | status | sync | for-repo | task-base | upload-pack pour
// un projet (forge à tickets) : un container de contrôle, N exécuteurs, et par
// dépôt un miroir d'origine et un miroir des agents. Les missions ne passent pas
// par ici : l'orchestrateur du contrôle les confie par l'API.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { restartApiService } from "../api/access.ts";
import { MISSION_KEY } from "../api/missions.ts";
import { readBranchRecords } from "../branch-records.ts";
import type { ForgeConfig } from "../config.ts";
import { provisioningMarker } from "../containers.ts";
import { readEnvFile } from "../dotenv.ts";
import { sessionState, type SessionState } from "../hc-session.ts";
import { forgeProject, listInstances, type Instance } from "../incus.ts";
import { fetchMirrorLfs, refreshMirror } from "../mirror.ts";
import type { HeldMission } from "../orchestrator/host.ts";
import { printableText } from "../printable.ts";
import { ensureRepoMirrors, projectMembers, repoOriginMirror, repoTeamMirror, type ProjectMember } from "../project.ts";
import type { ProjectConfig } from "../project-config.ts";
import { convergeControl, convergeExecutor, provisionControl, provisionExecutor } from "../project-provision.ts";
import { columnWidths, formatRow } from "../table.ts";
import { requireHostLfs } from "./provision.ts";
import { safeRef } from "./task-base.ts";

const USAGE = `Usage (with a project): forge team converge
       forge team status [--json] [--quick]
       forge team sync <repository>
       forge team for-repo <owner/repo> | task-base <repository> | upload-pack <repository>   (read by forge fetch and forge ship)`;

// Ce que `forge team status --json` dit d'un membre d'un projet.
export type ProjectMemberStatus = {
  name: string; kind: ProjectMember["kind"]; present: boolean;
  mission: HeldMission | null; // celle d'un exécuteur ; toujours null pour le contrôle
  session: SessionState; // "none" quand il est absent ou arrêté
};
export type ProjectStatus = { members: ProjectMemberStatus[] };

export async function projectCommand(
  ctx: Context, cfg: ForgeConfig, sub: string, a: string | undefined, opts: { json?: boolean },
): Promise<number> {
  const p = cfg.project as ProjectConfig;
  switch (sub) {
    case "converge": return converge(ctx, p, cfg, a);
    case "status": return status(ctx, p, opts.json === true);
    case "sync": return sync(ctx, p, a);
    case "for-repo": return forRepo(ctx, p, a);
    case "task-base": return taskBase(ctx, p, a);
    default: return uploadPack(ctx, p, a);
  }
}

function requireRepository(p: ProjectConfig, name: string | undefined): string {
  if (name === undefined || !Object.hasOwn(p.repositories, name)) {
    throw new ForgeError(`${name === undefined ? "a repository name is required" : `${name} is not a repository of the project`} ` +
      `(declared: ${Object.keys(p.repositories).join(", ")}).\n${USAGE}`);
  }
  return name;
}

// La mission que tient un exécuteur (MISSION_KEY) ; "unreadable" pour une
// valeur abîmée, qui n'est ni libre ni lisible.
function heldMission(i: Instance | undefined): HeldMission | null | "unreadable" {
  const value = i?.config[MISSION_KEY];
  if (value === undefined || value.trim() === "") return null;
  const keys = ["base", "branch", "kind", "repository", "subtask", "ticket"];
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).sort().join() !== keys.join() ||
      !keys.every((k) => typeof v[k] === "string") || v.kind !== "dev") return "unreadable";
    return { kind: "dev", ticket: v.ticket as string, subtask: v.subtask as string, repository: v.repository as string,
      branch: v.branch as string, base: v.base as string };
  } catch {
    return "unreadable";
  }
}

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
async function converge(ctx: Context, p: ProjectConfig, cfg: ForgeConfig, team: string | undefined): Promise<number> {
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
  return 0;
}

function printTable(ctx: Context, rows: string[][]): void {
  const head = ["NAME", "KIND", "STATUS", "MISSION"];
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
    members.push({ name: m.name, kind: m.kind, present: inst !== undefined, mission: held === "unreadable" ? null : held, session });
    rows.push([m.name, m.kind, inst?.status ?? "Missing", missionLabel(m, held)]);
  }
  if (json) {
    ctx.out(JSON.stringify({ members } satisfies ProjectStatus));
    return 0;
  }
  printTable(ctx, rows);
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
// qui n'est pas une ref sûre est écartée (task-base.ts).
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
