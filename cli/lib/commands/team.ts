// forge team converge | assign | release | status | sync (DX 5, §5.3, §5.5) :
// les équipes d'agents, du côté de l'hôte. Les équipes viennent de la config de
// forge ; chaque membre est un container, que `converge` provisionne.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { restartApiService } from "../api/access.ts";
import { readEnvFile } from "../dotenv.ts";
import { handedOutSecrets } from "./api.ts";
import { findQuestion, inbox, Journal, journalPath, memberWaitingOn, readEntries, type Question } from "../api/journal.ts";
import { BODY_MAX, checkSummary, checkText, INSTRUCTION_MAX, REQUEST_MAX } from "../api/protocol.ts";
import type { ForgeConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { baseKey, provisioningMarker } from "../containers.ts";
import { forgeProject, listInstances, type Instance } from "../incus.ts";
import { fetchMirrorLfs, originMirrorAge, refreshMirror } from "../mirror.ts";
import { configPath } from "../paths.ts";
import { ensureRunning } from "../session.ts";
import { deliverAnswer, sessionState, startSession, type SessionState } from "../hc-session.ts";
import { assign, busyState, release } from "../tasks.ts";
import { ageLabel, mirrorLine } from "../age.ts";
import { printableText } from "../printable.ts";
import { columnWidths, formatRow } from "../table.ts";
import { members, teamWantsLfs, type Member } from "../team.ts";
import { installMemberFiles, originMirrorPath, provisionMember } from "../team-provision.ts";
import { refreshTeamMirror } from "../team-mirror.ts";
import { teamMirrorPath } from "../mirror.ts";
import { hostReserveBytes, memoryWarning } from "../team-memory.ts";
import { containerConfig, safeRef } from "./task-base.ts";

const USAGE = `Usage: forge team converge [<team>]
       forge team assign <container> [<task>]   (the instruction is read from stdin)
       forge team release <container>
       forge team question <question id> [--json]   (the summary and the detail of a question of the Inbox)
       forge team answer <question id> [--json]   (the answer is read from stdin, as JSON: {"summary": "…", "body": "…"})
       forge team status [--json] [--quick]
       forge team sync <team>
       forge team for-repo <owner/repo> | task-base <team> | upload-pack <team>   (read by forge fetch and forge ship)`;


// `hostMemory` : la RAM de l'hôte, en octets ; les tests la fixent.
export type TeamOptions = { json?: boolean; quick?: boolean; stdin?: () => Promise<string>; hostMemory?: number };

async function readStdinUpTo(max: number, what: string, usage: string): Promise<string> {
  // Un terminal ne donne pas de consigne : le dire plutôt qu'attendre sans rien afficher.
  if (process.stdin.isTTY) throw new ForgeError(`the ${what} is read from stdin: ${usage}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > max) throw new ForgeError(`the ${what} is longer than ${max} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const readStdin = () => readStdinUpTo(INSTRUCTION_MAX, "instruction", "forge team assign <container> <task> < instruction.md");
// Le JSON de la réponse peut multiplier un texte par six en l'échappant : le plafond de l'API.
const readAnswer = () => readStdinUpTo(REQUEST_MAX, "answer", "forge answer <question id> \"<summary>\" from your machine");

export async function cmdTeam(ctx: Context, args: string[], opts: TeamOptions = {}): Promise<number> {
  const [sub, a, b] = args;
  if (opts.json && !["status", "question", "answer"].includes(sub ?? "")) {
    throw new ForgeError(`--json only goes with status, question and answer: forge team status --json\n${USAGE}`);
  }
  if (opts.quick && sub !== "status") throw new ForgeError(`--quick only goes with status: forge team status --quick\n${USAGE}`);
  if (!["converge", "assign", "release", "answer", "question", "status", "sync", "for-repo", "task-base", "upload-pack"].includes(sub ?? "")) {
    throw new ForgeError(USAGE);
  }
  const cfg = loadConfig(configPath());
  // Lu par une machine (forge fetch) : sans équipe, pas de message sur stdout.
  if (sub === "for-repo") return forRepo(ctx, cfg, a);
  if (Object.keys(cfg.teams).length === 0 && cfg.pilot === null) {
    throw new ForgeError(`no team in ${configPath()}: declare "teams" (and optionally "pilot") there first.`);
  }
  switch (sub) {
    case "converge": return converge(ctx, cfg, a, opts);
    case "assign": return assignCommand(ctx, cfg, a, b, opts.stdin ?? readStdin);
    case "release": return releaseCommand(ctx, cfg, a);
    case "question": return questionCommand(ctx, a, opts.json === true);
    case "answer": return answerCommand(ctx, cfg, a, opts.stdin ?? readAnswer, opts.json === true);
    case "status": return status(ctx, cfg, opts);
    case "task-base": return taskBase(ctx, cfg, a);
    case "upload-pack": return uploadPack(ctx, cfg, a);
    default: return sync(ctx, cfg, a);
  }
}

function requireTeam(cfg: ForgeConfig, team: string | undefined): string {
  if (team === undefined || !(team in cfg.teams)) {
    throw new ForgeError(`${team === undefined ? "a team name is required" : `${team} is not a declared team`} ` +
      `(declared: ${Object.keys(cfg.teams).join(", ") || "none"}).\n${USAGE}`);
  }
  return team;
}

async function converge(ctx: Context, cfg: ForgeConfig, team: string | undefined, opts: TeamOptions): Promise<number> {
  if (team !== undefined) requireTeam(cfg, team);
  const wanted = members(cfg).filter((m) => team === undefined || m.team === team);
  // Un .env illisible, ouvert aux autres ou mal formé arrête tout, avant le premier container.
  for (const m of wanted) if (m.env !== null) readEnvFile(m.env);
  const existing = new Map((await listInstances(ctx)).map((i) => [i.name, i]));
  // Dites en dernier : stderr et stdout n'arrivent pas dans l'ordre par SSH, et
  // une NOTE au milieu des lignes du membre suivant se lit mal.
  const notes: string[] = [];
  for (const m of wanted) {
    const instance = existing.get(m.name);
    let changed = false;
    if (!instance) {
      await provisionMember(ctx, cfg, m);
    } else if (await provisioningMarker(ctx, m.name) !== null) {
      ctx.err(`WARNING: ${m.name} is half-provisioned: left as is. Delete it (incus --project ${forgeProject()} delete ${m.name} --force) and run converge again.`);
      continue;
    } else {
      if (instance.status !== "Running") await ensureRunning(ctx, m.name);
      // Un container déjà là reçoit les fichiers de la version courante de forge
      // et du prompt de son rôle, comme un neuf : sans cela, une mise à jour
      // n'atteindrait que les containers créés après elle.
      // Le clone se fait une fois : un rôle qui change de mode LFS ne change pas
      // le container déjà là. forge le dit, il ne reconvertit rien.
      if ((instance.config?.["user.forge.lfs"] ?? "false") !== String(m.lfs)) {
        notes.push(`NOTE: ${m.name} was created with lfs ${m.lfs ? "off" : "on"}, its role now says lfs ${m.lfs}. ` +
          `Delete it (incus --project ${forgeProject()} delete ${m.name} --force; its workspace survives) and run converge again.`);
      }
      ctx.out(`Updating ${m.name}...`);
      changed = (await installMemberFiles(ctx, m)).instructionsChanged;
    }
    // Le Pilote a une session permanente : elle repart si elle manque ou si elle
    // est morte (startSession retire d'abord l'ancien terminal).
    if (m.role === "pilot") {
      const state = await sessionState(ctx, m.name);
      if (["none", "exited", "lost"].includes(state)) {
        await startSession(ctx, m, null, "");
        ctx.out(`Started ${m.name}'s session.`);
      } else if (changed) {
        // Elle ne relit pas ses instructions, et la tuer perdrait la conversation
        // avec l'humain : forge le dit, l'humain choisit le moment.
        notes.push(`NOTE: ${m.name}'s instructions or environment changed, but its running session keeps the old ones. ` +
          "To restart it (the conversation is lost): stop its `agent` terminal in Herdr App (or `hc kill <the Pilot's machine>/agent`), " +
          "then run forge team up again.");
      }
    }
  }
  // Le service ne connaît que les membres de la config qu'il a lue au démarrage.
  await restartApiService(ctx);
  for (const t of Object.keys(cfg.teams).filter((x) => team === undefined || x === team)) {
    const r = await refreshTeamMirror(ctx, cfg, t);
    for (const name of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${name}.`);
  }
  await printMembers(ctx, cfg, wanted, team);
  // Un avertissement, jamais un refus : les limites ne sont pas toutes atteintes en même temps.
  const overbooked = memoryWarning(cfg, await hostReserveBytes(ctx), opts.hostMemory);
  if (overbooked !== null) ctx.err(overbooked);
  for (const note of notes) ctx.err(note);
  return 0;
}

// Une ligne par membre déclaré, puis une par container d'équipe que la config
// ne déclare plus : converge ne supprime jamais un container.
async function printMembers(ctx: Context, cfg: ForgeConfig, wanted: Member[], team: string | undefined): Promise<void> {
  const instances = await listInstances(ctx);
  const rows: string[][] = [];
  for (const m of wanted) {
    const busy = await busyState(ctx, m.name);
    rows.push([m.name, m.role, instances.find((i) => i.name === m.name)?.status ?? "Missing", taskLabel(busy?.task ?? null)]);
  }
  const widths = columnWidths(rows);
  for (const row of rows) ctx.out(formatRow(row, widths));
  const declared = new Set(members(cfg).map((m) => m.name));
  for (const i of instances) {
    const t = i.config["user.forge.team"];
    if (t !== undefined && !declared.has(i.name) && (team === undefined || t === team)) {
      ctx.out(`${i.name}: not in the config, left as is`);
    }
  }
}

const taskLabel = (task: string | null) => task ?? "free";

async function assignCommand(
  ctx: Context, cfg: ForgeConfig, to: string | undefined, task: string | undefined, stdin: () => Promise<string>,
): Promise<number> {
  if (to === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
  const text = (await stdin()).trim();
  if (text === "") throw new ForgeError("the instruction is empty: give it on stdin (forge team assign <container> <task> < instruction.md).");
  await assign(ctx, cfg, { to, task: task ?? null, text, by: "human" });
  ctx.out(`Assigned ${task ?? "a task"} to ${to}.`);
  return 0;
}

async function releaseCommand(ctx: Context, cfg: ForgeConfig, to: string | undefined): Promise<number> {
  if (to === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
  await release(ctx, cfg, { to, by: "human" });
  ctx.out(`Released ${to}.`);
  return 0;
}

// Le résumé et le corps d'une question, pour que l'humain puisse y répondre. Le
// texte vient d'un agent : il passe par printableText (le saut de ligne reste).
// Avec --json, un seul objet sur une ligne : ce que lit la boîte du mod de Herdr App.
async function questionCommand(ctx: Context, idArg: string | undefined, json: boolean): Promise<number> {
  if (idArg === undefined || !/^[0-9]{1,15}$/.test(idArg)) throw new ForgeError(`a question number is required.\n${USAGE}`);
  const id = Number(idArg);
  const entries = readEntries(journalPath());
  const ask = entries.find((e) => e.id === id && e.op === "ask-human" && e.outcome === "ok");
  if (ask === undefined) throw new ForgeError(`no question ${id}: forge team status lists the open ones`);
  const state = findQuestion(entries, id) === "answered" ? "answered" : "open";
  if (json) {
    ctx.out(JSON.stringify({
      id, from: printableText(ask.caller), time: ask.time, state,
      summary: printableText(ask.summary ?? ""), body: ask.text === null ? null : printableText(ask.text),
    }));
    return 0;
  }
  ctx.out(`#${id} from ${printableText(ask.caller)}, ${ageLabel(Date.now() - Date.parse(ask.time))} ago (${state})`);
  ctx.out(printableText(ask.summary ?? ""));
  if (ask.text !== null) {
    ctx.out("");
    ctx.out(printableText(ask.text));
  }
  return 0;
}

// La réponse de l'humain à une question de la boîte (`forge answer`, de son
// poste). Ce n'est pas un verbe de l'API : seul l'hôte la lance, aucun agent ne
// peut l'appeler. Une réponse qui ne peut pas être livrée (la session de l'agent
// n'est plus là) est quand même consignée, et la question se ferme : l'humain
// l'apprend ici, il ne la pose pas deux fois.
async function answerCommand(
  ctx: Context, cfg: ForgeConfig, idArg: string | undefined, stdin: () => Promise<string>, json: boolean,
): Promise<number> {
  if (idArg === undefined || !/^[0-9]{1,15}$/.test(idArg)) throw new ForgeError(`a question number is required.\n${USAGE}`);
  const id = Number(idArg);
  const journal = Journal.open(journalPath());
  const question = findQuestion(journal.entries(), id);
  if (question === null) throw new ForgeError(`no question ${id} in the Inbox: forge team status lists the open ones`);
  if (question === "answered") throw new ForgeError(`question ${id} is already answered`);
  const { summary, body } = parseAnswer(await stdin(), handedOutSecrets(ctx));
  const delivery = await deliverAnswer(ctx, question.from, id, summary, body);
  journal.append({
    caller: "human", op: "answer", to: question.from, task: null, outcome: "ok",
    error: delivery === "delivered" ? null : `not delivered: ${question.from} has no live session`,
    summary, text: body, question: id,
  }, new Date(), 0);
  // Avec --json, ce que la boîte du mod de Herdr App montre après l'envoi.
  if (json) ctx.out(JSON.stringify({ id, to: question.from, delivered: delivery === "delivered" }));
  else ctx.out(delivery === "delivered"
    ? `Answered #${id} (delivered to ${question.from}).`
    : `Answered #${id}: ${question.from} has no live session, the answer is recorded but not delivered.`);
  return 0;
}

// `{"summary": …, "body"?: …}` : les règles de l'API sur un résumé et un corps,
// les mêmes secrets refusés, avant que rien ne soit écrit ou tapé.
function parseAnswer(raw: string, secrets: readonly string[]): { summary: string; body: string | null } {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new ForgeError("the answer on stdin is not valid JSON: {\"summary\": \"…\", \"body\": \"…\"}");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new ForgeError("the answer on stdin must be a JSON object");
  const { summary, body, ...extra } = o as Record<string, unknown>;
  if (Object.keys(extra).length > 0) throw new ForgeError("the answer has a summary and an optional body, nothing else");
  if (typeof summary !== "string") throw new ForgeError("the answer's summary must be a string");
  if (body !== undefined && (typeof body !== "string" || body === "")) throw new ForgeError("the answer's body must be a non-empty string: leave it out");
  checkSummary(summary, secrets);
  if (body !== undefined) checkText(body as string, BODY_MAX, "body", secrets);
  return { summary, body: (body as string | undefined) ?? null };
}

// Ce que l'hôte sait d'un membre : l'objet que `forge team status --json` donne
// aux affichages (watch, le mod de Herdr App, `team up`).
export type MemberStatus = {
  name: string; team: string | null; role: string; present: boolean;
  task: string | null; // la branche, ou NO_BRANCH ; null quand il est libre
  assignedBy: string | null;
  session: SessionState; // "none" quand il est absent ou arrêté
  waitingOn: string | null; // null sauf session idle ou done
};
export type TeamStatus = {
  members: MemberStatus[];
  inbox: Question[];
  mirrors: { team: string; originAgeSeconds: number | null }[];
};

// `--quick` : sans rafraîchir le miroir d'équipe, que ses clients interrogent
// toutes les quelques secondes (§5.4). Sinon, le miroir d'équipe se rafraîchit
// d'abord (§5.5) : un échec est un avertissement sur stderr, jamais un échec de status.
async function status(ctx: Context, cfg: ForgeConfig, opts: TeamOptions): Promise<number> {
  if (opts.quick !== true) {
    for (const t of Object.keys(cfg.teams)) {
      try {
        const r = await refreshTeamMirror(ctx, cfg, t);
        for (const name of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${name}.`);
      } catch (e) {
        ctx.err(`WARNING: could not refresh the team mirror of ${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const instances = new Map((await listInstances(ctx)).map((i: Instance) => [i.name, i]));
  const journal = readEntries(journalPath());
  const members_: MemberStatus[] = [];
  for (const m of members(cfg)) {
    const running = instances.get(m.name)?.status === "Running";
    const busy = instances.has(m.name) ? await busyState(ctx, m.name) : null;
    const session = running ? await sessionState(ctx, m.name) : "none";
    members_.push({
      name: m.name, team: m.team, role: m.role, present: instances.has(m.name),
      task: busy?.task ?? null, assignedBy: busy === null || busy.assignedBy === "" ? null : busy.assignedBy,
      session, waitingOn: memberWaitingOn(journal, m.name, session),
    });
  }
  const now = new Date();
  const result: TeamStatus = {
    members: members_, inbox: inbox(journal),
    mirrors: Object.keys(cfg.teams).map((team) => ({ team, originAgeSeconds: originMirrorAge(team, now) })),
  };
  if (opts.json) {
    ctx.out(JSON.stringify(result));
    return 0;
  }
  // Ce qui vient d'un agent (un résumé) passe par printableText, comme partout où il atteint un terminal.
  const head = ["NAME", "ROLE", "TASK", "SESSION", "WAITING"];
  const table = members_.map((r) => [r.name, r.role, taskLabel(r.task), r.session, r.waitingOn ?? "-"].map(printableText));
  const widths = columnWidths([head, ...table]);
  ctx.out(formatRow(head, widths));
  for (const row of table) ctx.out(formatRow(row, widths));
  if (result.inbox.length > 0) {
    ctx.out("INBOX");
    for (const q of result.inbox) {
      ctx.out(`#${q.id} ${printableText(q.from)} ${ageLabel(now.getTime() - Date.parse(q.time))}: ${printableText(q.summary)}`);
    }
  }
  for (const m of result.mirrors) {
    ctx.out(mirrorLine(m.team, m.originAgeSeconds));
  }
  return 0;
}

// Le miroir d'origine de l'équipe (GitHub, par l'agent SSH transmis), puis le
// miroir d'équipe.
async function sync(ctx: Context, cfg: ForgeConfig, team: string | undefined): Promise<number> {
  const name = requireTeam(cfg, team);
  const origin = await refreshMirror(ctx, originMirrorPath(name), cfg.teams[name].repo);
  if (origin.code !== 0) {
    throw new ForgeError(`refreshing the mirror of ${cfg.teams[name].repo} failed: ${origin.stderr.trim() || `exit code ${origin.code}`}\n` +
      `Did your SSH agent reach the host? Run forge team sync ${name} from your machine: it forwards the agent.`);
  }
  if (teamWantsLfs(cfg, name)) {
    const lfs = await fetchMirrorLfs(ctx, originMirrorPath(name), cfg.teams[name].repo);
    if (lfs.code !== 0) {
      throw new ForgeError(`fetching the LFS objects of ${cfg.teams[name].repo} failed: ${lfs.stderr.trim() || `exit code ${lfs.code}`}\n` +
        `Did your SSH agent reach the host? Run forge team sync ${name} from your machine: it forwards the agent.`);
    }
  }
  const r = await refreshTeamMirror(ctx, cfg, name);
  for (const failed of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${failed}.`);
  ctx.out(`Synced ${name}.`);
  return 0;
}

// Le laptop demande quelle équipe tient un dépôt : le nom sur stdout, ou rien et 1.
async function forRepo(ctx: Context, cfg: ForgeConfig, ownerRepo: string | undefined): Promise<number> {
  if (ownerRepo === undefined) throw new ForgeError(`an owner/repo is required.\n${USAGE}`);
  const found = Object.entries(cfg.teams).find(([, t]) => t.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (!found) return 1;
  ctx.out(found[0]);
  return 0;
}

// Une ligne `<tâche>\t<base>` par tâche que les développeurs de l'équipe
// possèdent, triées ; stdout est lu par une machine. Une base qui n'est pas une
// ref sûre est lue comme inconnue (task-base.ts).
async function taskBase(ctx: Context, cfg: ForgeConfig, team: string | undefined): Promise<number> {
  const name = requireTeam(cfg, team);
  const owned = new Map<string, string>();
  for (const m of members(cfg).filter((x) => x.team === name && x.capabilities.includes("publish"))) {
    const config = await containerConfig(ctx, m.name);
    for (const key of Object.keys(config)) {
      if (!key.startsWith(baseKey(""))) continue;
      const base = safeRef(config[key]);
      const task = key.slice(baseKey("").length);
      if (base && !owned.has(task)) owned.set(task, base);
    }
  }
  for (const task of [...owned.keys()].sort()) ctx.out(`${task}\t${owned.get(task)}`);
  return 0;
}

// Invoqué par le `git fetch` du laptop (remote.<c>.uploadpack = "forge team
// upload-pack <team>") : le miroir d'équipe est rafraîchi, puis servi. stdout
// porte le protocole git : rien n'y est écrit avant l'attach, les avertissements
// vont sur stderr. Le chemin que git ajoute est ignoré.
async function uploadPack(ctx: Context, cfg: ForgeConfig, team: string | undefined): Promise<number> {
  const name = requireTeam(cfg, team);
  try {
    const r = await refreshTeamMirror(ctx, cfg, name);
    for (const failed of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${failed}.`);
  } catch (e) {
    ctx.err(`WARNING: could not refresh the team mirror of ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const protocol = process.env.GIT_PROTOCOL;
  const env = protocol !== undefined && /^version=[0-9]$/.test(protocol) ? { GIT_PROTOCOL: protocol } : undefined;
  return ctx.attach(["git", "-c", "core.hooksPath=/dev/null", "upload-pack", teamMirrorPath(name)], env ? { env } : undefined);
}
