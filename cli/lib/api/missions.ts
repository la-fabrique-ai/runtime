// Les verbes de mission de l'API d'un projet (forge à tickets) : le container
// de contrôle (l'orchestrateur) confie, libère et observe ; un exécuteur dit
// qu'il a fini. Le contrat sur le fil est celui du client de l'orchestrateur,
// cli/lib/orchestrator/host.ts : mêmes clés, mêmes valeurs. `forge team assign`
// et `release`, la main de l'humain, passent par les mêmes fonctions.
//
// L'appelant vient de la socket, jamais de la requête ; une requête est
// validée à la main, champ par champ ; chaque appel laisse une
// ligne au journal, sauf les lectures acceptées (status, events, et le status d'un exécuteur, que forge-team sonde).
// `assign`, `release` et `done` passent un à la fois (`exclusive()`), et l'id
// d'un `done` se prend en l'écrivant au journal, dans cette file : un
// évènement d'id plus petit n'apparaît jamais après un plus grand.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, inTime, mustSucceed } from "../context.ts";
import { recordBranch } from "../branch-records.ts";
import { clearMessages, hcArgv, sessionState, startSession, stopSession } from "../hc-session.ts";
import { configGet, configSet, configUnset, execAsAgentArgv, listInstances } from "../incus.ts";
import { ensureBareTeamMirror, HOST_GIT_CWD } from "../mirror.ts";
import type { ExecutorStatus, HeldMission, HostEvent, MissionSpec, SessionState } from "../orchestrator/host.ts";
import { forgeCommand } from "../paths.ts";
import { projectMembers, repoTeamMirror, type ProjectMember } from "../project.ts";
import { cloneDir } from "../project-provision.ts";
import { REPO_NAME, type ProjectConfig } from "../project-config.ts";
import { ensureRunning } from "../session.ts";
import { shellQuote } from "../shell.ts";
import { isGitRef, isSubtaskId, isTicketId } from "../tickets/model.ts";
import { validateGitRef } from "../validate.ts";
import type { ForgeConfig } from "../config.ts";
import type { Entry, Journal, NewEntry } from "./journal.ts";
import { checkText, hasSecret, INSTRUCTION_MAX, REQUEST_MAX } from "./protocol.ts";
import { withMissionLock } from "./mission-lock.ts";

export type ApiDeps = { ctx: Context; cfg: ForgeConfig; journal: Journal; secrets: readonly string[]; now: () => Date };
export type ApiReply = { ok: true; [k: string]: unknown } | { ok: false; error: string };

// `assign`, `release` et `done` du service passent un à la fois, tous
// appelants confondus (l'orchestrateur, un exécuteur) : deux demandes au même
// instant ne voient pas le même exécuteur libre. `forge team assign|release`,
// la main de l'humain, tourne dans son propre processus : chaque changement de
// mission, du service comme de l'humain, prend aussi le verrou partagé
// (mission-lock.ts).
let exclusiveChain: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = exclusiveChain.then(fn, fn);
  exclusiveChain = run.catch(() => {});
  return run;
}

// La mission tenue par un exécuteur : le JSON d'une HeldMission, absent quand il est libre.
export const MISSION_KEY = "user.forge.mission";

export type MissionRequest =
  | { op: "status" }
  | { op: "assign"; to: string; mission: MissionSpec }
  | { op: "release"; to: string }
  | { op: "events"; after: number }
  | { op: "done" };

type Kind = ProjectMember["kind"];
export type MissionVerb = MissionRequest["op"];

// Les verbes de chaque socket : un exécuteur ne confie rien, le contrôle ne finit rien.
const VERBS: Record<Kind, readonly MissionVerb[]> = {
  control: ["status", "assign", "release", "events"],
  executor: ["done", "status"],
};
// Les champs exacts de chaque verbe ; `op` est lu à part.
const FIELDS: Record<MissionVerb, readonly string[]> = {
  status: [], assign: ["to", "mission"], release: ["to"], events: ["after"], done: [],
};
const MISSION_FIELDS = ["kind", "ticket", "subtask", "repository", "branch", "base", "instruction"] as const;
const HELD_FIELDS = MISSION_FIELDS.filter((k) => k !== "instruction");

const EXECUTOR = /^agent-executor-[1-9][0-9]*$/;
const PUT_IN_A_FILE = "put it in a file of your branch and send its path";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownFields(where: string, o: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new ForgeError(`${where}: unknown field${extra.length > 1 ? "s" : ""}: ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}`);
  }
}

// La base d'une mission : `origin/<branche>` (une branche de l'origine) ou
// `agent/<sous-tâche>` (la branche d'une autre sous-tâche, dans le miroir d'équipe).
function checkBase(base: string, subtask: string): void {
  if (base.startsWith("origin/") && isGitRef(base.slice("origin/".length))) {
    validateGitRef(base);
    return;
  }
  if (base.startsWith("agent/") && isSubtaskId(base.slice("agent/".length))) {
    if (base.slice("agent/".length) === subtask) throw new ForgeError(`assign: sub-task ${subtask} cannot start from itself`);
    return;
  }
  throw new ForgeError("assign: base must be origin/<branch> or agent/<sub-task>");
}

function parseMission(v: unknown, secrets: readonly string[]): MissionSpec {
  if (!isObj(v)) throw new ForgeError("assign: mission must be an object");
  unknownFields("assign: mission", v, MISSION_FIELDS);
  for (const k of MISSION_FIELDS) {
    if (typeof v[k] !== "string") throw new ForgeError(`assign: mission.${k} must be a string`);
  }
  const m = v as Record<(typeof MISSION_FIELDS)[number], string>;
  // Un secret n'a rien à faire dans un nom de branche ni dans une consigne.
  if (HELD_FIELDS.some((k) => hasSecret(m[k], secrets))) throw new ForgeError("assign: the mission holds a secret forge handed out: remove it");
  if (m.kind !== "dev") throw new ForgeError('assign: mission.kind must be "dev"');
  if (!isTicketId(m.ticket)) throw new ForgeError("assign: mission.ticket is not a ticket id");
  if (!isSubtaskId(m.subtask)) throw new ForgeError("assign: mission.subtask is not a sub-task id");
  if (m.subtask.slice(0, m.subtask.indexOf(".")) !== m.ticket) {
    throw new ForgeError(`assign: subtask ${m.subtask} is not a sub-task of ${m.ticket}`);
  }
  if (!REPO_NAME.test(m.repository)) throw new ForgeError("assign: mission.repository is not a repository name");
  if (m.branch !== `agent/${m.subtask}`) throw new ForgeError(`assign: branch must be agent/${m.subtask}`);
  checkBase(m.base, m.subtask);
  checkText(m.instruction, INSTRUCTION_MAX, "instruction", secrets);
  return { kind: "dev", ticket: m.ticket, subtask: m.subtask, repository: m.repository, branch: m.branch, base: m.base, instruction: m.instruction };
}

export function parseMissionRequest(line: string, from: Kind, secrets: readonly string[]): MissionRequest {
  if (Buffer.byteLength(line, "utf8") > REQUEST_MAX) {
    throw new ForgeError(`the request is longer than ${REQUEST_MAX} bytes: ${PUT_IN_A_FILE}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new ForgeError("the request is not valid JSON");
  }
  if (!isObj(json)) throw new ForgeError("the request must be a JSON object");
  const op = json.op;
  if (typeof op !== "string") throw new ForgeError("op must be a string");
  if (!(VERBS[from] as readonly string[]).includes(op)) {
    // Le nom n'est répété que s'il a la forme d'un verbe et ne cache pas un secret.
    const named = /^[a-z][a-z-]{0,30}$/.test(op) && !hasSecret(op, secrets) ? op : "this op";
    throw new ForgeError(`${named} is not a verb of the ${from} container`);
  }
  const verb = op as MissionVerb;
  unknownFields(verb, json, ["op", ...FIELDS[verb]]);
  const to = (): string => {
    const v = json.to;
    if (typeof v !== "string" || !EXECUTOR.test(v)) throw new ForgeError(`${verb}: to must be an executor name (agent-executor-<n>)`);
    return v;
  };
  switch (verb) {
    case "assign":
      return { op: "assign", to: to(), mission: parseMission(json.mission, secrets) };
    case "release":
      return { op: "release", to: to() };
    case "events": {
      const after = json.after;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
        throw new ForgeError("events: after must be a non-negative integer");
      }
      return { op: "events", after };
    }
    case "done":
      return { op: "done" };
    default:
      return { op: "status" };
  }
}

// ---------------------------------------------------------------- l'état tenu

const held = (m: MissionSpec): HeldMission => ({
  kind: m.kind, ticket: m.ticket, subtask: m.subtask, repository: m.repository, branch: m.branch, base: m.base,
});

// La valeur de MISSION_KEY : null quand l'exécuteur est libre, "unreadable"
// pour une valeur abîmée (éditée à la main) : il n'est alors pas libre.
export function readHeld(value: string | undefined): HeldMission | null | "unreadable" {
  if (value === undefined || value.trim() === "") return null;
  try {
    const v: unknown = JSON.parse(value);
    if (!isObj(v) || Object.keys(v).length !== HELD_FIELDS.length || !HELD_FIELDS.every((k) => typeof v[k] === "string") || v.kind !== "dev") {
      return "unreadable";
    }
    return { kind: "dev", ticket: v.ticket as string, subtask: v.subtask as string, repository: v.repository as string, branch: v.branch as string, base: v.base as string };
  } catch {
    return "unreadable";
  }
}

function requireProject(d: ApiDeps): ProjectConfig {
  if (d.cfg.project === null) throw new ForgeError("no project in the configuration");
  return d.cfg.project;
}

const executors = (p: ProjectConfig) => projectMembers(p).filter((m) => m.kind === "executor");

// ---------------------------------------------------------------- les verbes

export async function handleMission(d: ApiDeps, caller: ProjectMember, line: string): Promise<ApiReply> {
  let req: MissionRequest;
  try {
    req = parseMissionRequest(line, caller.kind, d.secrets);
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    d.journal.append(entryFields(caller, null, "refused", e.message), d.now());
    return { ok: false, error: e.message };
  }
  try {
    const out = await run(d, caller, req);
    if (out.quiet) return out.reply(0);
    // `done` a écrit sa ligne lui-même, dans la file d'`exclusive()`.
    const id = out.entry?.id ?? d.journal.append(entryFields(caller, req, "ok", null), d.now()).id;
    return out.reply(id);
  } catch (e) {
    const why = e instanceof ForgeError ? e.message : "internal error";
    d.journal.append(entryFields(caller, req, "refused", why), d.now());
    if (e instanceof ForgeError) return { ok: false, error: why };
    throw e;
  }
}

function entryFields(caller: ProjectMember, req: MissionRequest | null, outcome: Entry["outcome"], error: string | null, done?: HeldMission): NewEntry {
  const mission = req?.op === "assign" ? held(req.mission) : done;
  return {
    caller: caller.name, op: req?.op ?? null,
    to: req !== null && "to" in req ? req.to : null,
    task: mission?.subtask ?? null,
    outcome, error, summary: null,
    text: req?.op === "assign" ? req.mission.instruction : null,
    ...(mission === undefined ? {} : { mission }),
  };
}

// `quiet` : une lecture du contrôle (status, events), qu'il fait toutes les
// quelques secondes : acceptée, elle n'est pas journalisée ; refusée, si.
type Outcome = { reply: (id: number) => ApiReply; entry?: Entry; quiet?: boolean };

async function run(d: ApiDeps, caller: ProjectMember, req: MissionRequest): Promise<Outcome> {
  const p = requireProject(d);
  const requireExecutor = (to: string) => {
    if (!executors(p).some((m) => m.name === to)) throw new ForgeError(`${to} is not an executor of this project`);
  };
  switch (req.op) {
    case "assign": {
      requireExecutor(req.to);
      if (!Object.hasOwn(p.repositories, req.mission.repository)) {
        throw new ForgeError(`repository ${req.mission.repository} is not declared in the project`);
      }
      const { to, mission } = req;
      await exclusive(() => withMissionLock(() => assign(d.ctx, p, to, mission)));
      return { reply: () => ({ ok: true }) };
    }
    case "release": {
      requireExecutor(req.to);
      const { to } = req;
      await exclusive(() => withMissionLock(() => release(d.ctx, to)));
      return { reply: () => ({ ok: true }) };
    }
    case "status":
      if (caller.kind === "executor") {
        const mine = readHeld(await configGet(d.ctx, caller.name, MISSION_KEY));
        if (mine === "unreadable") throw new ForgeError(`${caller.name}'s mission key is unreadable: ask for it to be released`);
        return { reply: () => ({ ok: true, mission: mine }), quiet: true };
      }
      {
        const rows = await status(d.ctx, p);
        return { reply: () => ({ ok: true, executors: rows }), quiet: true };
      }
    case "events":
      return events(d, req.after);
    case "done":
      return exclusive(() => withMissionLock(() => done(d, caller)));
  }
}

// ---------------------------------------------------------------- la main de l'humain

// `forge team assign` et `forge team release` (spec §6.10) : les fonctions des
// verbes, appelées de l'hôte par l'humain, sans l'orchestrateur, sous le verrou
// partagé avec le service. La mission est lue comme celle de l'API (mêmes
// refus) ; chaque appel est journalisé, accepté ou refusé (ses arguments
// compris), sous l'appelant `human` et l'id 0, hors de la suite que le service
// numérote en mémoire (comme `forge notify`) : ce n'est jamais un évènement.
type HumanEntry = Omit<NewEntry, "caller" | "outcome" | "error">;

async function asHuman(journal: Journal, entry: HumanEntry, fn: () => Promise<void>): Promise<void> {
  const write = (outcome: Entry["outcome"], error: string | null) =>
    journal.append({ caller: "human", ...entry, outcome, error }, new Date(), 0);
  try {
    await fn();
  } catch (e) {
    write("refused", e instanceof ForgeError ? e.message : "internal error");
    throw e;
  }
  write("ok", null);
}

function requireHumanTarget(p: ProjectConfig, to: string): void {
  if (!EXECUTOR.test(to) || !executors(p).some((m) => m.name === to)) throw new ForgeError(`${to} is not an executor of this project`);
}

export async function humanAssign(
  ctx: Context, p: ProjectConfig, journal: Journal, secrets: readonly string[], to: string, spec: unknown,
): Promise<void> {
  // Complétée une fois la mission lue ; un refus des arguments garde ce qui est connu.
  const entry: HumanEntry = { op: "assign", to, task: null, summary: null, text: null };
  await asHuman(journal, entry, async () => {
    requireHumanTarget(p, to);
    const mission = parseMission(spec, secrets);
    Object.assign(entry, { task: mission.subtask, text: mission.instruction, mission: held(mission) });
    if (!Object.hasOwn(p.repositories, mission.repository)) {
      throw new ForgeError(`repository ${mission.repository} is not declared in the project`);
    }
    await withMissionLock(() => assign(ctx, p, to, mission));
  });
}

export async function humanRelease(ctx: Context, p: ProjectConfig, journal: Journal, to: string): Promise<void> {
  await asHuman(journal, { op: "release", to, task: null, summary: null, text: null }, async () => {
    requireHumanTarget(p, to);
    await withMissionLock(() => release(ctx, to));
  });
}

// Libre, ou tenant déjà cette sous-tâche (la reprise de l'orchestrateur : sa
// session repart) ; la sous-tâche n'est tenue par aucun autre exécuteur. Puis,
// dans le clone et en aiuser, la branche ; puis la fiche de la branche, la clé,
// et une session neuve dans le clone.
async function assign(ctx: Context, p: ProjectConfig, to: string, m: MissionSpec): Promise<void> {
  const instances = await listInstances(ctx);
  const target = instances.find((i) => i.name === to);
  if (target === undefined) throw new ForgeError(`${to} does not exist: converge the project first`);
  const mine = readHeld(target.config[MISSION_KEY]);
  if (mine === "unreadable") throw new ForgeError(`${to} has an unreadable mission key: release it first`);
  if (mine !== null && mine.subtask !== m.subtask) throw new ForgeError(`${to} holds ${mine.subtask}: release it first`);
  // Une reprise reprend la même mission : un autre dépôt ou une autre base
  // demande de libérer d'abord.
  if (mine !== null && (mine.repository !== m.repository || mine.base !== m.base)) {
    throw new ForgeError(`${m.subtask} is held with another repository or base`);
  }
  for (const other of executors(p)) {
    if (other.name === to) continue;
    const theirs = readHeld(instances.find((i) => i.name === other.name)?.config[MISSION_KEY]);
    if (theirs !== null && theirs !== "unreadable" && theirs.subtask === m.subtask) {
      throw new ForgeError(`${m.subtask} is held by ${other.name}`);
    }
  }

  await ensureRunning(ctx, to, { timeoutMs: INCUS_MS });
  await prepareBranch(ctx, to, m);
  recordBranch({ branch: m.branch, repository: m.repository, ticket: m.ticket, subtask: m.subtask, base: m.base, executor: to });
  await mustSucceed("record the mission",
    inTime(`recording the mission of ${to}`, INCUS_MS, configSet(ctx, to, MISSION_KEY, JSON.stringify(held(m)), { timeoutMs: INCUS_MS })));
  try {
    await startSession(ctx, { name: to }, m.subtask, m.instruction, { cwd: cloneDir(m.repository), timeoutMs: INCUS_MS });
  } catch (e) {
    // Une session qui ne démarre pas ne laisse pas l'exécuteur marqué occupé.
    await configUnset(ctx, to, MISSION_KEY, { timeoutMs: INCUS_MS });
    throw e;
  }
}

// Tout git passe par un argv, dans le container, en aiuser : l'hôte ne lance
// jamais git dans le clone d'un agent. Le clone est à l'agent, sa config aussi :
// git ne doit ni y lancer un programme qu'elle nomme (fsmonitor, hooks,
// uploadpack des remotes) ni sortir des chemins locaux ; et chaque appel a un
// délai, pour qu'un git qui attend ne bloque pas la file d'`exclusive()`, donc
// tout le projet. Un délai dépassé est un refus qui nomme l'étape. Les appels
// incus et hc de la file (démarrer le container, la clé, la session) ont le
// leur, INCUS_MS ; ceux de `status`, que l'orchestrateur lit toutes les
// quelques secondes, un plus court, STATUS_MS.
const FETCH_MS = 60_000;
const SWITCH_MS = 60_000;
const GIT_MS = 20_000;
const MIRROR_MS = 120_000;
const INCUS_MS = 30_000;
const STATUS_MS = 8_000;
const SAFE_GIT = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
  "-c", "remote.origin.uploadpack=git-upload-pack", "-c", "remote.team.uploadpack=git-upload-pack",
  "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
];

const gitIn = (ctx: Context, container: string, repository: string) =>
  async (timeoutMs: number, ...args: string[]): Promise<ExecResult> => {
    const r = await execAsAgentArgv(ctx, container, ["git", "-C", cloneDir(repository), ...SAFE_GIT, ...args], { timeoutMs });
    if (r.timedOut) throw new ForgeError(`git ${args[0]} in ${container}:${cloneDir(repository)} timed out after ${timeoutMs / 1000} s`);
    return r;
  };

// Les changements suivis du clone (`--untracked-files=no`) : un fichier non
// suivi reste où il est (un switch qui l'écraserait échoue, et le refus nomme
// l'étape). Un clone illisible ou muet est `unreadable`.
type CloneState = "clean" | "dirty" | "unreadable";
const TRACKED_STATUS = ["status", "--porcelain", "--untracked-files=no"];
const changeCount = (stdout: string) => stdout.split("\n").filter((l) => l.trim() !== "").length;

// L'état de chaque clone d'un exécuteur, un `git status` par clone, en
// parallèle, chacun avec son délai : ce que `status` (l'API) et `forge team
// status` lisent d'un exécuteur libre.
export async function cloneStates(
  ctx: Context, container: string, p: ProjectConfig, timeoutMs = STATUS_MS,
): Promise<{ repository: string; state: CloneState }[]> {
  return Promise.all(Object.keys(p.repositories).map(async (repository) => {
    const r = await execAsAgentArgv(ctx, container, ["git", "-C", cloneDir(repository), ...SAFE_GIT, ...TRACKED_STATUS], { timeoutMs });
    if (r.timedOut || r.code !== 0) return { repository, state: "unreadable" };
    return { repository, state: changeCount(r.stdout) > 0 ? "dirty" : "clean" };
  }));
}

// La reprise se lit dans le clone : sur `agent/<sous-tâche>`, la branche de
// cette sous-tâche, son travail (même non commité) est le sien. C'est le cas
// d'une session perdue que l'orchestrateur reprend par `release` puis
// `assign` : à l'assign, la clé est déjà vide. Mais le clone ne fait foi que
// s'il contient `team/<branche>` : une sous-tâche rendue puis reprise ailleurs
// a pu avancer dans le miroir d'équipe. Un clone en retard, propre, avance en
// fast-forward ; sale ou divergent, il est refusé : le garder ferait travailler
// l'agent sur une branche périmée, et la copie forcée de `done` écraserait
// ensuite le travail plus récent dans le miroir des agents. Jamais de switch
// sur un arbre aux changements suivis, jamais de `switch -C` par-dessus des
// commits que `team/<branche>` n'a pas.
async function prepareBranch(ctx: Context, to: string, m: MissionSpec): Promise<void> {
  const dir = cloneDir(m.repository);
  const git = gitIn(ctx, to, m.repository);
  await mustSucceed("git fetch team", git(FETCH_MS, "fetch", "team"));
  await mustSucceed("git fetch origin", git(FETCH_MS, "fetch", "origin"));
  const has = async (ref: string) => (await git(GIT_MS, "rev-parse", "--verify", "--quiet", ref)).code === 0;
  // `--is-ancestor` : 0 oui, 1 non, autre chose une erreur, lue comme un non
  // (qui mène au plus à un refus, jamais à un écrasement).
  const anc = async (x: string, y: string) => (await git(GIT_MS, "merge-base", "--is-ancestor", x, y)).code === 0;
  const team = `team/${m.branch}`;
  const inTeam = await has(`refs/remotes/${team}`);
  const diverged = () => new ForgeError(
    `${m.branch} in ${to} has commits that ${team} does not have, and the reverse: resolve by hand (release, inspect the clone)`);

  const head = await git(GIT_MS, "symbolic-ref", "--short", "HEAD");
  if (head.code === 0 && head.stdout.trim() === m.branch) {
    // Le clone contient le miroir (ou le miroir ne l'a jamais reçue) : la
    // reprise, l'arbre reste tel quel, sale ou non.
    if (!inTeam || await anc(team, "HEAD")) return;
    const dirty = changeCount((await mustSucceed("git status", git(GIT_MS, ...TRACKED_STATUS))).stdout);
    if (dirty > 0) {
      throw new ForgeError(`${to}: ${dir} is on ${m.branch} with uncommitted changes, and ${team} has moved beyond it: ` +
        "commit or discard them, then assign again");
    }
    if (!(await anc("HEAD", team))) throw diverged();
    await mustSucceed(`fast-forward ${m.branch}`, git(SWITCH_MS, "merge", "--ff-only", team));
    return;
  }
  const dirty = changeCount((await mustSucceed("git status", git(GIT_MS, ...TRACKED_STATUS))).stdout);
  if (dirty > 0) {
    throw new ForgeError(`${to}: ${dir} has ${dirty} uncommitted change${dirty === 1 ? "" : "s"} and is not on ${m.branch}: ` +
      "commit or discard them before assigning a mission");
  }
  const local = await has(`refs/heads/${m.branch}`);

  // La branche est dans le miroir d'équipe (une sous-tâche reprise, ici ou
  // ailleurs) : son travail repart de là. Une branche locale en retard est
  // recréée sur le miroir ; une branche locale qui le contient déjà (des
  // commits pas encore rendus) est gardée telle quelle ; divergente, refusée.
  if (inTeam) {
    if (!local || await anc(m.branch, team)) {
      await mustSucceed(`switch to ${m.branch}`, git(SWITCH_MS, "switch", "-C", m.branch, team));
    } else if (await anc(team, m.branch)) {
      await mustSucceed(`switch to ${m.branch}`, git(SWITCH_MS, "switch", m.branch));
    } else {
      throw diverged();
    }
    return;
  }
  // Jamais rendue, mais déjà commencée dans ce clone : on la reprend.
  if (local) {
    await mustSucceed(`switch to ${m.branch}`, git(SWITCH_MS, "switch", m.branch));
    return;
  }
  if (m.base.startsWith("origin/")) {
    await mustSucceed(`create ${m.branch}`, git(SWITCH_MS, "switch", "-c", m.branch, m.base));
    return;
  }
  // `agent/<sous-tâche>` : la branche d'une sous-tâche rendue, dans le miroir d'équipe.
  if (!(await has(`refs/remotes/team/${m.base}`))) throw new ForgeError(`base ${m.base} is not in the team mirror`);
  await mustSucceed(`create ${m.branch}`, git(SWITCH_MS, "switch", "-c", m.branch, `team/${m.base}`));
}

// Libérer un exécuteur libre ne change rien et n'est pas un refus. Un échec de
// l'arrêt de la session ne défait pas la libération.
async function release(ctx: Context, to: string): Promise<void> {
  if ((await configGet(ctx, to, MISSION_KEY)) !== "") {
    await mustSucceed("clear the mission",
      inTime(`clearing the mission of ${to}`, INCUS_MS, configUnset(ctx, to, MISSION_KEY, { timeoutMs: INCUS_MS })));
  }
  let stopped: boolean;
  try {
    stopped = await stopSession(ctx, to, { timeoutMs: INCUS_MS });
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    stopped = false;
  }
  if (!stopped) ctx.err(`WARNING: could not stop ${to}'s session: it stays as it is until the next assign.`);
  await clearMessages(ctx, to, { timeoutMs: INCUS_MS });
}

// Le contrat de `session` (orchestrator/host.ts) : `none` seulement pour un
// container démarré dont hc répond, sans terminal ; arrêté, ou hc injoignable,
// c'est `unknown`. sessionState rend `none` pour tout échec de `hc get` :
// seul un `hc ls` qui répond tranche « aucun terminal » ; sans lui, ou passé le
// délai, `unknown`, jamais `lost` (une panne passagère ne déclenche pas de
// reprise). Une mission tenue sans terminal est `lost`, que l'orchestrateur
// reprend. Un exécuteur libre dont un clone a des changements suivis (ou ne
// répond pas) est `unknown` : il refuserait toute mission, l'orchestrateur ne
// lui en donne pas, et `forge team status` le dit à l'humain.
async function executorSession(ctx: Context, p: ProjectConfig, name: string, running: boolean, holds: boolean): Promise<SessionState> {
  if (!running) return "unknown";
  let state = await sessionState(ctx, name, { timeoutMs: STATUS_MS });
  if (state === "none") {
    const ls = await ctx.exec(hcArgv(name, ["ls"]), { timeoutMs: STATUS_MS });
    if (ls.timedOut || ls.code !== 0) return "unknown";
    state = holds ? "lost" : "none";
  }
  if (holds || state === "unknown") return state;
  const clones = await cloneStates(ctx, name, p);
  return clones.every((c) => c.state === "clean") ? state : "unknown";
}

// Les exécuteurs en parallèle : le délai de l'orchestrateur (30 s) borne la
// réponse entière, pas celle d'un seul.
async function status(ctx: Context, p: ProjectConfig): Promise<ExecutorStatus[]> {
  const instances = await listInstances(ctx);
  return Promise.all(executors(p).map(async (m): Promise<ExecutorStatus> => {
    const inst = instances.find((i) => i.name === m.name);
    const mission = readHeld(inst?.config[MISSION_KEY]);
    if (mission === "unreadable") {
      // Ni libre ni reprenable : `unknown`, et l'humain est prévenu.
      ctx.err(`WARNING: ${m.name} has an unreadable ${MISSION_KEY}: release it.`);
      return { name: m.name, mission: null, session: "unknown" };
    }
    return { name: m.name, mission, session: await executorSession(ctx, p, m.name, inst?.status === "Running", mission !== null) };
  }));
}

// Les `done` acceptés d'id > after, par id croissant ; `last` est le plus
// grand id du journal (0 s'il est vide), lu dans le même instant.
function events(d: ApiDeps, after: number): Outcome {
  d.journal.refresh();
  const entries = d.journal.entries();
  const last = entries.reduce((max, e) => Math.max(max, e.id), 0);
  const list: HostEvent[] = entries
    .filter((e) => e.op === "done" && e.outcome === "ok" && e.id > after && e.mission !== undefined)
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ id: e.id, kind: "done", executor: e.caller, ticket: e.mission!.ticket, subtask: e.mission!.subtask, branch: e.mission!.branch }));
  return { reply: () => ({ ok: true, events: list, last }), quiet: true };
}

// Une mission tenue, des clones sans changements suivis, au moins un commit
// au-delà de sa base, la branche copiée dans le miroir d'équipe du dépôt ;
// puis la ligne du journal, dont l'id est celui de l'évènement. Les clones
// sont lus comme `status` les lit (tous, pas seulement celui de la mission) :
// un done accepté sur un clone sale libérerait un exécuteur que `status` dit
// ensuite `unknown`, et qui ne recevrait plus de mission.
async function done(d: ApiDeps, caller: ProjectMember): Promise<Outcome> {
  const { ctx } = d;
  const m = readHeld(await configGet(ctx, caller.name, MISSION_KEY));
  if (m === null) throw new ForgeError(`${caller.name} holds no mission: there is nothing to report done`);
  if (m === "unreadable") throw new ForgeError(`${caller.name}'s mission key is unreadable: ask for it to be released`);
  for (const c of await cloneStates(ctx, caller.name, requireProject(d))) {
    if (c.state === "dirty") {
      throw new ForgeError(`${caller.name}: ${cloneDir(c.repository)} has uncommitted changes: commit or discard them, then report done again`);
    }
    if (c.state === "unreadable") throw new ForgeError(`${caller.name}: git status in ${cloneDir(c.repository)} did not answer: try done again`);
  }
  const git = gitIn(ctx, caller.name, m.repository);
  // La base, à jour dans le clone : `origin/<b>` après `git fetch origin`,
  // `agent/<x>` est `team/agent/<x>` après `git fetch team`.
  const stacked = m.base.startsWith("agent/");
  await mustSucceed(stacked ? "git fetch team" : "git fetch origin", git(FETCH_MS, "fetch", stacked ? "team" : "origin"));
  const from = stacked ? `team/${m.base}` : m.base;
  const count = await mustSucceed("git rev-list", git(GIT_MS, "rev-list", "--count", `${from}..${m.branch}`));
  if (!(Number.parseInt(count.stdout.trim(), 10) > 0)) {
    throw new ForgeError(`nothing committed on ${m.branch} beyond ${m.base}`);
  }
  await copyToTeamMirror(ctx, caller.name, m.repository, m.branch);
  const entry = d.journal.append(entryFields(caller, { op: "done" }, "ok", null, m), d.now());
  return { entry, reply: (id) => ({ ok: true, id }) };
}

// Git de l'hôte n'ouvre que le miroir des agents du dépôt, hooks coupés, et ne
// prend que la branche de la mission (forcée : une branche réécrite remplace
// l'ancienne) ; le container répond par `forge upload-pack`, qui sert le clone
// nommé par l'URL du remote, /workspace/<dépôt>.
export async function copyToTeamMirror(ctx: Context, container: string, repository: string, branch: string): Promise<void> {
  const mirror = repoTeamMirror(repository);
  await ensureBareTeamMirror(ctx, mirror);
  const uploadpack = `FORGE_SIDE=host ${shellQuote(forgeCommand())} upload-pack ${container}`;
  const r = await ctx.exec([
    "git", `--git-dir=${mirror}`, "-c", "core.hooksPath=/dev/null",
    "-c", `remote.src.url=${cloneDir(repository)}`, "-c", `remote.src.uploadpack=${uploadpack}`,
    "fetch", "--no-tags", "src", `+refs/heads/${branch}:refs/heads/${branch}`,
  ], { cwd: HOST_GIT_CWD, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: MIRROR_MS });
  if (r.timedOut) throw new ForgeError(`copying ${branch} to the team mirror timed out after ${MIRROR_MS / 1000} s`);
  if (r.code !== 0) {
    throw new ForgeError(`${branch} could not be copied to the team mirror: ${r.stderr.trim().split("\n")[0] || `exit code ${r.code}`}`);
  }
}
