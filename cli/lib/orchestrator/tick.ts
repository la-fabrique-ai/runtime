// Un tour de l'orchestrateur : lire les évènements de l'hôte, reprendre les
// missions perdues, distribuer les sous-tâches prêtes aux exécuteurs libres.
// Le tour ne journalise rien : il renvoie un compte rendu.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError } from "../tickets/model.ts";
import type { Request, Subtask, Ticket } from "../tickets/model.ts";
import { HostError } from "./host.ts";
import type { AskEvent, DoneEvent, ExecutorStatus, HeldMission, HostApi, MissionSpec } from "./host.ts";
import { branchOf, candidates, missionBase, qaCandidates, RuleError } from "./rule.ts";
import type { Candidate, QaCandidate } from "./rule.ts";
import { devInstruction, missionFiles, qaInstruction, rebaseInstruction } from "./instruction.ts";
import { addFix } from "./fixes.ts";

export type Cursor = { read(): number; write(id: number): void };

export type TickReport = {
  completed: string[];
  assigned: { subtask: string; executor: string }[];
  recovered: string[];
  problems: string[];
  // Les QA de ce tour : lancées (`started`) ou rendues (`ok`, `ko`).
  qa: { ticket: string; verdict: "ok" | "ko" | "started" }[];
};

type Picture = { ticket: Ticket; subtasks: Subtask[]; requests: Request[] };

// Le curseur dans un fichier. Un fichier absent ou illisible vaut 0 : relire
// les évènements est sans effet (une sous-tâche déjà `done` est sautée).
export function fileCursor(path: string): Cursor {
  return {
    read() {
      try {
        const text = readFileSync(path, "utf8").trim();
        const n = Number(text);
        return /^[0-9]+$/.test(text) && Number.isSafeInteger(n) ? n : 0;
      } catch {
        return 0;
      }
    },
    write(id) {
      // Temporaire du même dossier puis rename : jamais de curseur à moitié écrit.
      const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
      writeFileSync(tmp, `${id}\n`, { flag: "wx" });
      try {
        renameSync(tmp, path);
      } catch (e) {
        // Le rename a échoué : on ne laisse pas le temporaire derrière soi.
        try {
          unlinkSync(tmp);
        } catch {}
        throw e;
      }
    },
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// Une erreur qui ne concerne qu'un ticket : le tour continue avec les autres.
const local = (e: unknown): boolean => e instanceof ConnectorError || e instanceof RuleError;
// Une erreur hors du domaine (ni hôte, ni base, ni règle) est un bug : `internal: `
// la distingue d'une panne.
const describe = (e: unknown): string => (local(e) || e instanceof HostError ? message(e) : `internal: ${message(e)}`);
// Seules ces sessions déclenchent une reprise (spec §6.4). `none` (aucun
// terminal) et `unknown` (container arrêté, exec en échec) ne la déclenchent pas.
const LOST: readonly string[] = ["exited", "lost"];

// Une sous-tâche que l'hôte a refusé d'assigner n'est retentée qu'après ce
// délai : refusée à chaque tour (dépôt inconnu de l'hôte, base absente), elle
// prendrait sinon l'exécuteur à chaque tour et ferait l'aller-retour
// in-dev/ready dans la base. `refusals` garde, d'un tour à l'autre, l'instant
// avant lequel chacune n'est pas retentée ; en mémoire, un redémarrage l'oublie.
export const RETRY_AFTER_REFUSAL_MS = 5 * 60_000;
// Un exécuteur qui refuse autant de sous-tâches dans un tour en sort : le
// refus vient sans doute de lui, il ne doit pas consommer toute la file.
const REFUSALS_PER_EXECUTOR = 2;

// Une mission tenue dont la session n'annonce aucun état (`unknown`) depuis ce
// délai est signalée : rien ne la reprend (une panne passagère ne doit pas
// tuer un agent qui travaille), mais l'humain doit l'apprendre. `silent` garde,
// d'un tour à l'autre, depuis quand chaque mission est muette.
export const SILENT_SESSION_MS = 2 * 60_000;

type TickDeps = {
  tickets: Connector; host: HostApi; cursor: Cursor;
  refusals?: Map<string, number>; silent?: Map<string, number>; now?: () => number;
};

export async function tick(d: TickDeps): Promise<TickReport> {
  const report: TickReport = { completed: [], assigned: [], recovered: [], problems: [], qa: [] };
  try {
    await run(d, report);
  } catch (e) {
    // HostError, ConnectorError de events/status/listTickets, ou toute autre
    // panne : le tour s'arrête là, la boucle (Task 5) relancera le suivant.
    report.problems.push(describe(e));
  }
  return report;
}

async function run(d: TickDeps, report: TickReport): Promise<void> {
  const { tickets, host, cursor } = d;
  const refusals = d.refusals ?? new Map<string, number>();
  const silent = d.silent ?? new Map<string, number>();
  const now = d.now ?? Date.now;

  // 1. Évènements.
  const after = cursor.read();
  let reply = await host.events(after);
  if (reply.last < after) {
    // Le journal de l'hôte est reparti de zéro : le curseur aussi, et on relit
    // tout dans le même tour (relire un évènement déjà traité est sans effet).
    cursor.write(0);
    reply = await host.events(0);
  }
  const events = reply.events;
  // Le curseur n'avance que jusqu'au premier évènement en échec : celui-ci
  // sera relu au tour suivant. Les suivants sont traités quand même (un
  // ticket illisible ne bloque pas les autres) et relus sans effet.
  let advance = true;
  // Les tickets dont un évènement a échoué ce tour : leur statut ne bouge pas
  // avant qu'il soit relu (une QA `ko` à moitié traitée garde le ticket en `qa`).
  const pending = new Set<string>();
  for (const ev of events) {
    try {
      if (ev.kind === "ask") await onAsk(tickets, host, ev, report);
      else if (ev.mission === "qa") await onQaDone(tickets, host, ev, report);
      else await onDone(tickets, host, ev, report);
    } catch (e) {
      if (!local(e)) throw e;
      report.problems.push(`${ev.ticket}: event ${ev.id} (${ev.subtask}): ${message(e)}`);
      pending.add(ev.ticket);
      advance = false;
    }
    if (advance) cursor.write(ev.id);
  }

  // 2. Photographie.
  const executors = await host.status();
  const listed = await tickets.listTickets({ status: ["dev", "qa"] });
  for (const p of listed.problems) report.problems.push(`${p.id}: ${p.message}`);
  const picture: Picture[] = [];
  // Un ticket illisible n'est touché par aucune règle (sa QA tenue n'est pas libérée).
  const unreadable = new Set<string>(listed.problems.map((p) => p.id));
  for (const ticket of listed.tickets) {
    try {
      const subtasks = await tickets.listSubtasks({ ticket: ticket.id });
      picture.push({ ticket, subtasks, requests: await tickets.listRequests({ ticket: ticket.id }) });
    } catch (e) {
      if (!(e instanceof ConnectorError)) throw e;
      report.problems.push(`${ticket.id}: ${e.message}`);
      unreadable.add(ticket.id);
    }
  }

  // Un ticket en `qa` dont une sous-tâche n'est pas finie revient en `dev` (un
  // crash entre les deux écritures du marquage d'un rebase, plus bas).
  for (const { ticket, subtasks } of picture) {
    if (ticket.status !== "qa" || subtasks.every((x) => x.status === "done") || pending.has(ticket.id)) continue;
    try {
      await tickets.setTicketStatus({ id: ticket.id, status: "dev" });
      ticket.status = "dev";
    } catch (e) {
      if (!local(e)) throw e;
      report.problems.push(`${ticket.id}: back to dev: ${message(e)}`);
    }
  }

  // Un ticket dont une demande attend l'humain ne reçoit aucune mission, et sa
  // mission perdue n'est pas relancée : la sous-tâche attend la réponse.
  const waiting = new Set(picture.filter((p) => p.requests.some((r) => r.answer === null)).map((p) => p.ticket.id));

  // 3. Reprise. Tout se recalcule depuis la photographie à chaque tour : un
  // évènement traité à moitié (crash, hôte muet) est rattrapé ici.
  // Les sous-tâches dont l'assign a échoué ce tour-ci ne sont pas retentées.
  const failed = new Set<string>();
  for (const ex of executors) {
    if (!ex.mission || !LOST.includes(ex.session)) continue;
    if (waiting.has(ex.mission.ticket)) {
      // Libérée seulement : la branche « in-dev tenue par personne » plus bas
      // remet sa sous-tâche `ready`, pour quand l'humain aura répondu.
      await host.release(ex.name);
      report.problems.push(`${ex.mission.ticket}: ${ex.mission.subtask} on ${ex.name}: session ${ex.session} while a question waits for the human; released`);
      ex.mission = null;
      continue;
    }
    await recover(tickets, host, ex, ex.mission, picture, unreadable, failed, report);
  }
  watchSessions(executors, silent, now(), report);
  for (const ex of executors) {
    const m = ex.mission;
    if (!m) continue;
    if (m.kind === "qa") {
      // Une QA tient la sous-tâche du haut, finie : elle n'est libérée que
      // quand son ticket n'est plus en `qa`.
      if (unreadable.has(m.ticket)) continue;
      if (picture.find((p) => p.ticket.id === m.ticket)?.ticket.status !== "qa") {
        await host.release(ex.name);
        ex.mission = null;
      }
      continue;
    }
    const s = picture.find((p) => p.ticket.id === m.ticket)?.subtasks.find((x) => x.id === m.subtask);
    if (!s) continue;
    if (s.status === "done") {
      // Sous-tâche finie, exécuteur jamais libéré (release perdu) : on le libère.
      await host.release(ex.name);
      ex.mission = null;
    } else if (s.status === "ready") {
      // Tenue mais `ready` : l'hôte a accepté un assign dont la réponse s'est perdue.
      try {
        await tickets.setSubtaskStatus({ id: s.id, status: "in-dev", ...keep(s) });
        s.status = "in-dev";
      } catch (e) {
        if (!local(e)) throw e;
        report.problems.push(`${m.ticket}: ${s.id} to in-dev: ${message(e)}`);
      }
    }
  }
  // Un ticket dont toutes les sous-tâches (au moins une) sont `done` passe `qa`.
  for (const { ticket, subtasks } of picture) {
    if (ticket.status !== "dev") continue;
    if (subtasks.length === 0 || !subtasks.every((x) => x.status === "done") || waiting.has(ticket.id)) continue;
    try {
      await tickets.setTicketStatus({ id: ticket.id, status: "qa" });
      ticket.status = "qa";
    } catch (e) {
      if (!local(e)) throw e;
      report.problems.push(`${ticket.id}: to qa: ${message(e)}`);
    }
  }
  const held = new Set(executors.flatMap((e) => (e.mission ? [e.mission.subtask] : [])));
  for (const { ticket, subtasks } of picture) {
    for (const s of subtasks) {
      if (s.status !== "in-dev" || held.has(s.id)) continue;
      try {
        await tickets.setSubtaskStatus({ id: s.id, status: "ready", ...keep(s) });
        s.status = "ready";
      } catch (e) {
        if (!local(e)) throw e;
        report.problems.push(`${ticket.id}: ${s.id} back to ready: ${message(e)}`);
      }
    }
  }

  // 4. Distribution : la QA d'abord (§2.5 : finir avant de commencer).
  // Un exécuteur `unknown` (container arrêté, hôte sans réponse) n'est pas libre.
  const free = executors.filter((e) => e.mission === null && e.session !== "unknown").map((e) => e.name).sort();
  const t = now();
  for (const [id, until] of refusals) if (until <= t) refusals.delete(id);
  const refusedBy = new Map<string, number>();
  // Un refus de l'hôte : la mission attend son délai, l'exécuteur reste libre
  // pour le tour, en fin de file, sauf s'il a déjà refusé ailleurs dans ce tour.
  const refused = (key: string, to: string): void => {
    refusals.set(key, t + RETRY_AFTER_REFUSAL_MS);
    const n = (refusedBy.get(to) ?? 0) + 1;
    refusedBy.set(to, n);
    if (n < REFUSALS_PER_EXECUTOR) free.push(to);
  };
  const touched = new Set<string>();
  const qa = qaCandidates(picture.filter((p) => p.ticket.status === "qa" && !waiting.has(p.ticket.id)));
  report.problems.push(...qa.problems);
  const qaHeld = new Set(executors.flatMap((e) => (e.mission?.kind === "qa" ? [e.mission.ticket] : [])));
  for (const q of qa.candidates) {
    const key = `${q.ticket.id} qa`;
    if (qaHeld.has(q.ticket.id) || refusals.has(key)) continue;
    // La cascade : la plus basse branche qui n'est plus posée sur la pointe de
    // ce qu'il y a en dessous est rebasée d'abord ; aucune QA sur une pile périmée.
    let states;
    try {
      states = await host.stack(q.stack);
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      report.problems.push(`${q.ticket.id}: stack: ${e.message}`);
      continue;
    }
    const stale = states.findIndex((x) => !x.current);
    if (stale >= 0) {
      touched.add(q.ticket.id);
      const s = q.subtasks[stale]!;
      try {
        // La sous-tâche d'abord : un crash avant le ticket le laisse en `qa`
        // avec une sous-tâche pas finie, que la photographie remet en `dev`.
        await tickets.setSubtaskStatus({ id: s.id, status: "ready", reason: "rebase" });
        s.status = "ready";
        s.reason = "rebase";
        await tickets.setTicketStatus({ id: q.ticket.id, status: "dev" });
        q.ticket.status = "dev";
      } catch (e) {
        if (!local(e)) throw e;
        report.problems.push(`${q.ticket.id}: ${s.id} to rebase: ${message(e)}`);
      }
      continue;
    }
    const to = free.shift();
    if (to === undefined) continue;
    const ex = executors.find((e) => e.name === to)!;
    if (await launchQa(tickets, host, to, q, report)) {
      ex.mission = heldOf(q);
      report.qa.push({ ticket: q.ticket.id, verdict: "started" });
    } else {
      refused(key, to);
    }
  }

  const found = candidates(picture.filter((p) => p.ticket.status === "dev" && !touched.has(p.ticket.id)), held, waiting);
  report.problems.push(...found.problems);
  for (const c of found.candidates) {
    const id = c.subtask.id;
    if (failed.has(id) || refusals.has(id)) continue;
    const to = free.shift();
    if (to === undefined) break;
    if (await launch(tickets, host, to, c, false, failed, report)) {
      report.assigned.push({ subtask: id, executor: to });
      continue;
    }
    // Refusée par l'hôte : la sous-tâche attend son délai (voir `refused`).
    if (failed.has(id)) {
      refused(id, to);
    } else {
      free.unshift(to); // la base n'a pas pu passer la sous-tâche in-dev : l'hôte n'y est pour rien
    }
  }
}

// Les missions tenues dont l'agent n'avance plus sans l'humain, et que rien ne
// reprend : une session `blocked` (l'agent attend à son écran), signalée à
// chaque tour ; une session `unknown` depuis SILENT_SESSION_MS. Signaler ne
// change rien à la mission.
function watchSessions(executors: ExecutorStatus[], silent: Map<string, number>, t: number, report: TickReport): void {
  const seen = new Set<string>();
  for (const ex of executors) {
    const m = ex.mission;
    // Libre mais `unknown` : il ne reçoit aucune mission, l'humain doit le savoir.
    if (!m && ex.session === "unknown") {
      report.problems.push(`${ex.name}: free but its state is unknown (container stopped, hc unreachable, ` +
        "or a clone with uncommitted changes): it gets no mission; see forge team status");
    }
    if (!m) continue;
    const where = `${m.ticket}: ${m.subtask} on ${ex.name}`;
    if (ex.session === "blocked") {
      report.problems.push(`${where}: the agent's session is blocked, waiting for an answer on its screen: read it with hc read <machine>/agent`);
    }
    if (ex.session !== "unknown") continue;
    const key = `${ex.name} ${m.subtask}`;
    seen.add(key);
    const since = silent.get(key) ?? t;
    silent.set(key, since);
    if (t - since >= SILENT_SESSION_MS) {
      report.problems.push(`${where}: no session state for ${SILENT_SESSION_MS / 60_000} minutes ` +
        "(container stopped, hc unreachable, or an agent that announces nothing): read its screen with hc read <machine>/agent");
    }
  }
  for (const key of silent.keys()) if (!seen.has(key)) silent.delete(key);
}

// Un `done` : la sous-tâche `in-dev` passe `done` avec sa branche, l'exécuteur
// qui la tient encore est libéré, le ticket passe `qa` si tout est fini.
async function onDone(tickets: Connector, host: HostApi, ev: DoneEvent, report: TickReport): Promise<void> {
  const subtasks = await tickets.listSubtasks({ ticket: ev.ticket });
  const s = subtasks.find((x) => x.id === ev.subtask);
  // Un évènement qui ne correspond à rien est signalé mais consommé : le relire
  // ne changerait rien, il ne doit pas bloquer le curseur.
  if (!s) return void report.problems.push(`${ev.ticket}: event ${ev.id}: sub-task not found: ${ev.subtask}`);
  if (s.status === "done") return;
  const holder = (await host.status()).find((e) => e.name === ev.executor);
  const holds = holder?.mission?.subtask === s.id;
  // `ready` mais tenue par l'émetteur : un assign accepté dont la réponse s'est perdue.
  if (s.status !== "in-dev" && !(s.status === "ready" && holds)) {
    return void report.problems.push(`${ev.ticket}: event ${ev.id}: ${s.id} is ${s.status}, not in-dev; ignored`);
  }
  // Le lien d'abord : une sous-tâche `done` n'est jamais sans sa branche.
  await tickets.setSubtaskLinks({ id: s.id, branch: ev.branch });
  // Le compte rendu final de l'agent, gardé dans le ticket (#191).
  if (ev.report !== null) await tickets.addComment({ ticket: ev.ticket, author: ev.executor, kind: "note", text: ev.report });
  await tickets.setSubtaskStatus({ id: s.id, status: "done" });
  s.status = "done";
  report.completed.push(s.id);
  if (holds) await host.release(ev.executor);
  // Pas de `qa` tant qu'une demande du ticket attend l'humain.
  if (subtasks.length > 0 && subtasks.every((x) => x.status === "done")) {
    const ticket = await tickets.getTicket({ id: ev.ticket });
    const waits = (await tickets.listRequests({ ticket: ev.ticket, open: true })).length > 0;
    if (ticket.status === "dev" && !waits) await tickets.setTicketStatus({ id: ev.ticket, status: "qa" });
  }
}

// Le `done` d'une QA, dans cet ordre, chaque étape sans effet si on la rejoue :
// le compte rendu libre gardé en commentaire `qa-report` ; `ko` : un correctif
// par défaut, dans l'ordre du compte rendu, puis le ticket en `dev` ; `ok` : le
// ticket en `human-review` ; puis l'émetteur libéré s'il tient encore cette QA.
// Le statut du ticket change en dernier : un crash avant lui rejoue l'étape
// entière, et addFix ne crée rien deux fois. Un ticket qui n'est plus en `qa`
// (évènement relu) : rien.
async function onQaDone(tickets: Connector, host: HostApi, ev: DoneEvent, report: TickReport): Promise<void> {
  const ticket = await tickets.getTicket({ id: ev.ticket });
  if (ticket.status !== "qa" || ev.qa === null) return;
  const qa = ev.qa;
  const text = ev.report ?? `QA verdict: ${qa.verdict} (no report).`;
  // Rejouée, l'étape ne regarde que le dernier compte rendu : c'est le sien.
  const { comments } = await tickets.listComments({ ticket: ev.ticket });
  const last = comments.filter((c) => c.kind === "qa-report").at(-1);
  if (!last || last.author !== ev.executor || last.text !== text) {
    await tickets.addComment({ ticket: ev.ticket, author: ev.executor, kind: "qa-report", text });
  }
  if (qa.verdict === "ko") {
    for (const d of qa.defects) await addFix(tickets, ticket, { fixes: d.subtask, text: d.text });
  }
  await tickets.setTicketStatus({ id: ev.ticket, status: qa.verdict === "ko" ? "dev" : "human-review" });
  report.qa.push({ ticket: ev.ticket, verdict: qa.verdict });
  const holder = (await host.status()).find((e) => e.name === ev.executor);
  if (holder?.mission?.kind === "qa" && holder.mission.ticket === ev.ticket) await host.release(ev.executor);
}

// Un `ask` (décision 35) : le développeur a rendu son travail en cours avec une
// question pour l'humain. Dans cet ordre : la demande, la libération de
// l'émetteur s'il tient encore la sous-tâche, la sous-tâche `ready`. Le ticket
// attend alors la réponse (`waiting`). Relu (curseur perdu, crash), il ne
// rouvre pas une demande déjà là, et ne touche pas à une sous-tâche qu'un autre
// exécuteur tient.
async function onAsk(tickets: Connector, host: HostApi, ev: AskEvent, report: TickReport): Promise<void> {
  const subtasks = await tickets.listSubtasks({ ticket: ev.ticket });
  const s = subtasks.find((x) => x.id === ev.subtask);
  if (!s) return void report.problems.push(`${ev.ticket}: event ${ev.id}: sub-task not found: ${ev.subtask}`);
  if (s.status === "done") return;
  const executors = await host.status();
  const holds = executors.find((e) => e.name === ev.executor)?.mission?.subtask === s.id;
  if (s.status !== "in-dev" && !(s.status === "ready" && holds)) return;
  if (!holds && executors.some((e) => e.mission?.subtask === s.id)) return;
  // La base Markdown garde une réponse recommandée d'une ligne dans l'en-tête
  // de la demande ; plus longue, elle va dans son texte. Un retour chariot
  // (un fichier en CRLF) compte comme un saut de ligne : l'en-tête refuse les deux.
  const rec = ev.recommended;
  const multi = rec !== null && /[\r\n]/.test(rec);
  const text = multi ? `${ev.text}\n\nRecommended answer:\n${rec}` : ev.text;
  const open = await tickets.listRequests({ ticket: ev.ticket, open: true });
  if (!open.some((r) => r.subtask === s.id && r.text === text)) {
    await tickets.openRequest({ ticket: ev.ticket, subtask: s.id, text, ...(rec !== null && !multi ? { recommended: rec } : {}) });
  }
  if (holds) await host.release(ev.executor);
  if (s.status !== "ready") await tickets.setSubtaskStatus({ id: s.id, status: "ready", ...keep(s) });
}

// Une mission dont la session est perdue : libérée, puis relancée sur le même
// exécuteur en reprise. Si sa sous-tâche n'est plus à faire, seulement libérée.
async function recover(
  tickets: Connector,
  host: HostApi,
  ex: ExecutorStatus,
  held: HeldMission,
  picture: Picture[],
  unreadable: Set<string>,
  failed: Set<string>,
  report: TickReport,
): Promise<void> {
  // Ticket illisible : déjà signalé, on ne touche à rien.
  if (unreadable.has(held.ticket)) return;
  const entry = picture.find((p) => p.ticket.id === held.ticket);
  if (held.kind === "qa") {
    // Une QA perdue est libérée ; tant que son ticket est en `qa`, l'étape de
    // la QA, plus bas dans le tour, la relance en QA, après le contrôle de la
    // pile (jamais une QA sur une pile périmée).
    await host.release(ex.name);
    ex.mission = null;
    if (entry?.ticket.status !== "qa") report.problems.push(`${held.ticket}: its QA is no longer to do, ${ex.name} released`);
    return;
  }
  const s = entry?.subtasks.find((x) => x.id === held.subtask);
  if (!entry || !s || s.status === "done") {
    await host.release(ex.name);
    ex.mission = null;
    report.problems.push(`${held.ticket}: ${held.subtask} is no longer to do, ${ex.name} released`);
    return;
  }
  let base: string;
  let branch: string;
  try {
    base = missionBase(entry.ticket, entry.subtasks, s);
    branch = branchOf(entry.subtasks, s);
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    report.problems.push(`${held.ticket}: ${e.message}`);
    return;
  }
  await host.release(ex.name);
  ex.mission = null;
  if (await launch(tickets, host, ex.name, { ticket: entry.ticket, subtask: s, base, kind: held.kind === "rebase" || s.reason === "rebase" ? "rebase" : "dev", branch }, true, failed, report)) {
    ex.mission = held;
    report.recovered.push(s.id);
  }
}

// Met la sous-tâche `in-dev` puis l'assigne ; si l'hôte refuse, elle revient
// à `ready` et le refus devient un problème. Renvoie vrai si assignée.
async function launch(
  tickets: Connector,
  host: HostApi,
  to: string,
  c: Candidate,
  resumed: boolean,
  failed: Set<string>,
  report: TickReport,
): Promise<boolean> {
  const s = c.subtask;
  let mission: MissionSpec;
  try {
    // Les fichiers de mission et les réponses déjà données, lus à chaque lancement.
    const files = missionFiles(await tickets.readMission({ ticket: c.ticket.id }));
    const requests = (await tickets.listRequests({ ticket: c.ticket.id })).filter((r) => r.subtask === s.id);
    const answered = requests.filter((r) => r.answer !== null);
    // Une sous-tâche qui a déjà une demande a été rendue en cours (ask) : sa
    // branche porte le travail d'avant, la mission reprend.
    if (requests.length > 0) resumed = true;
    let instruction: string;
    if (c.kind === "rebase") {
      // Le commit sur lequel la branche était posée, que l'hôte a retenu.
      let builtOn: string | null;
      try {
        const [state] = await host.stack([{ repository: s.repository, branch: c.branch, base: c.base }]);
        builtOn = state?.builtOn ?? null;
      } catch (e) {
        if (!(e instanceof HostError)) throw e;
        report.problems.push(`${c.ticket.id}: ${s.id}: stack: ${e.message}`);
        return false;
      }
      instruction = rebaseInstruction(c, builtOn, resumed);
    } else {
      instruction = devInstruction(c, resumed, { answered, files });
    }
    mission = {
      kind: c.kind,
      ticket: c.ticket.id,
      subtask: s.id,
      repository: s.repository,
      branch: c.branch,
      base: c.base,
      instruction,
      files,
    };
  } catch (e) {
    if (!local(e)) throw e;
    report.problems.push(`${c.ticket.id}: ${s.id}: mission files: ${message(e)}`);
    return false;
  }
  try {
    if (s.status !== "in-dev") {
      await tickets.setSubtaskStatus({ id: s.id, status: "in-dev", ...keep(s) });
      s.status = "in-dev";
    }
  } catch (e) {
    if (!local(e)) throw e;
    report.problems.push(`${c.ticket.id}: ${s.id} to in-dev: ${message(e)}`);
    return false;
  }
  try {
    await host.assign(to, mission);
    return true;
  } catch (e) {
    failed.add(s.id);
    report.problems.push(`${c.ticket.id}: assign ${s.id} to ${to}: ${describe(e)}`);
    try {
      await tickets.setSubtaskStatus({ id: s.id, status: "ready", ...keep(s) });
      s.status = "ready";
    } catch (e2) {
      if (!local(e2)) throw e2;
      report.problems.push(`${c.ticket.id}: ${s.id} back to ready: ${message(e2)}`);
    }
    return false;
  }
}

// Une sous-tâche garde sa raison `rebase` jusqu'à `done` : chaque statut que le
// tour écrit avant la repasse, sinon un rebase interrompu reviendrait en dev.
function keep(s: Subtask): { reason?: "rebase" } {
  return s.reason === "rebase" ? { reason: "rebase" } : {};
}

const heldOf = (q: QaCandidate): HeldMission => ({
  kind: "qa", ticket: q.ticket.id, subtask: q.top.id, repository: q.top.repository, branch: `agent/${q.top.id}`, base: q.base,
});

// Assigne la QA d'un ticket : aucun statut ne change dans la base. Un refus
// de l'hôte devient un problème. Renvoie vrai si assignée.
async function launchQa(tickets: Connector, host: HostApi, to: string, q: QaCandidate, report: TickReport): Promise<boolean> {
  let mission: MissionSpec;
  try {
    const files = missionFiles(await tickets.readMission({ ticket: q.ticket.id }));
    const answered = (await tickets.listRequests({ ticket: q.ticket.id })).filter((r) => r.answer !== null);
    mission = { ...heldOf(q), instruction: qaInstruction(q, { answered, files }), files };
  } catch (e) {
    if (!local(e)) throw e;
    report.problems.push(`${q.ticket.id}: qa: mission files: ${message(e)}`);
    return false;
  }
  try {
    await host.assign(to, mission);
    return true;
  } catch (e) {
    report.problems.push(`${q.ticket.id}: assign its QA to ${to}: ${describe(e)}`);
    return false;
  }
}
