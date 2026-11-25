// Un tour de l'orchestrateur : lire les évènements de l'hôte, reprendre les
// missions perdues, distribuer les sous-tâches prêtes aux exécuteurs libres.
// Le tour ne journalise rien : il renvoie un compte rendu.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError } from "../tickets/model.ts";
import type { Subtask, Ticket } from "../tickets/model.ts";
import { HostError } from "./host.ts";
import type { ExecutorStatus, HeldMission, HostApi, HostEvent, MissionSpec } from "./host.ts";
import { candidates, missionBase, RuleError } from "./rule.ts";
import type { Candidate } from "./rule.ts";
import { devInstruction } from "./instruction.ts";

export type Cursor = { read(): number; write(id: number): void };

export type TickReport = {
  completed: string[];
  assigned: { subtask: string; executor: string }[];
  recovered: string[];
  problems: string[];
};

type Picture = { ticket: Ticket; subtasks: Subtask[] };

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

export async function tick(d: { tickets: Connector; host: HostApi; cursor: Cursor }): Promise<TickReport> {
  const report: TickReport = { completed: [], assigned: [], recovered: [], problems: [] };
  try {
    await run(d, report);
  } catch (e) {
    // HostError, ConnectorError de events/status/listTickets, ou toute autre
    // panne : le tour s'arrête là, la boucle (Task 5) relancera le suivant.
    report.problems.push(describe(e));
  }
  return report;
}

async function run(d: { tickets: Connector; host: HostApi; cursor: Cursor }, report: TickReport): Promise<void> {
  const { tickets, host, cursor } = d;

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
  for (const ev of events) {
    try {
      await onDone(tickets, host, ev, report);
    } catch (e) {
      if (!local(e)) throw e;
      report.problems.push(`${ev.ticket}: event ${ev.id} (${ev.subtask}): ${message(e)}`);
      advance = false;
    }
    if (advance) cursor.write(ev.id);
  }

  // 2. Photographie.
  const executors = await host.status();
  const listed = await tickets.listTickets({ status: ["dev"] });
  for (const p of listed.problems) report.problems.push(`${p.id}: ${p.message}`);
  const picture: Picture[] = [];
  const unreadable = new Set<string>();
  for (const ticket of listed.tickets) {
    try {
      picture.push({ ticket, subtasks: await tickets.listSubtasks({ ticket: ticket.id }) });
    } catch (e) {
      if (!(e instanceof ConnectorError)) throw e;
      report.problems.push(`${ticket.id}: ${e.message}`);
      unreadable.add(ticket.id);
    }
  }

  // 3. Reprise. Tout se recalcule depuis la photographie à chaque tour : un
  // évènement traité à moitié (crash, hôte muet) est rattrapé ici.
  // Les sous-tâches dont l'assign a échoué ce tour-ci ne sont pas retentées.
  const failed = new Set<string>();
  for (const ex of executors) {
    if (!ex.mission || !LOST.includes(ex.session)) continue;
    await recover(tickets, host, ex, ex.mission, picture, unreadable, failed, report);
  }
  for (const ex of executors) {
    const m = ex.mission;
    if (!m) continue;
    const s = picture.find((p) => p.ticket.id === m.ticket)?.subtasks.find((x) => x.id === m.subtask);
    if (!s) continue;
    if (s.status === "done") {
      // Sous-tâche finie, exécuteur jamais libéré (release perdu) : on le libère.
      await host.release(ex.name);
      ex.mission = null;
    } else if (s.status === "ready") {
      // Tenue mais `ready` : l'hôte a accepté un assign dont la réponse s'est perdue.
      try {
        await tickets.setSubtaskStatus({ id: s.id, status: "in-dev" });
        s.status = "in-dev";
      } catch (e) {
        if (!local(e)) throw e;
        report.problems.push(`${m.ticket}: ${s.id} to in-dev: ${message(e)}`);
      }
    }
  }
  // Un ticket dont toutes les sous-tâches (au moins une) sont `done` passe `qa`.
  for (const { ticket, subtasks } of picture) {
    if (subtasks.length === 0 || !subtasks.every((x) => x.status === "done")) continue;
    try {
      await tickets.setTicketStatus({ id: ticket.id, status: "qa" });
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
        await tickets.setSubtaskStatus({ id: s.id, status: "ready" });
        s.status = "ready";
      } catch (e) {
        if (!local(e)) throw e;
        report.problems.push(`${ticket.id}: ${s.id} back to ready: ${message(e)}`);
      }
    }
  }

  // 4. Distribution.
  const found = candidates(picture, held);
  report.problems.push(...found.problems);
  // Un exécuteur `unknown` (container arrêté, hôte sans réponse) n'est pas libre.
  const free = executors.filter((e) => e.mission === null && e.session !== "unknown").map((e) => e.name).sort();
  for (const c of found.candidates) {
    if (failed.has(c.subtask.id)) continue;
    const to = free[0];
    if (to === undefined) break;
    // Assigné ou non, l'exécuteur sort de `free` pour le tour : un exécuteur qui
    // refuse tout ne bloque pas la distribution aux suivants.
    free.shift();
    if (await launch(tickets, host, to, c, false, failed, report)) {
      report.assigned.push({ subtask: c.subtask.id, executor: to });
    }
  }
}

// Un `done` : la sous-tâche `in-dev` passe `done` avec sa branche, l'exécuteur
// qui la tient encore est libéré, le ticket passe `qa` si tout est fini.
async function onDone(tickets: Connector, host: HostApi, ev: HostEvent, report: TickReport): Promise<void> {
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
  await tickets.setSubtaskStatus({ id: s.id, status: "done" });
  s.status = "done";
  report.completed.push(s.id);
  if (holds) await host.release(ev.executor);
  if (subtasks.length > 0 && subtasks.every((x) => x.status === "done")) {
    const ticket = await tickets.getTicket({ id: ev.ticket });
    if (ticket.status === "dev") await tickets.setTicketStatus({ id: ev.ticket, status: "qa" });
  }
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
  const s = entry?.subtasks.find((x) => x.id === held.subtask);
  if (!entry || !s || s.status === "done") {
    await host.release(ex.name);
    ex.mission = null;
    report.problems.push(`${held.ticket}: ${held.subtask} is no longer to do, ${ex.name} released`);
    return;
  }
  let base: string;
  try {
    base = missionBase(entry.ticket, entry.subtasks, s);
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    report.problems.push(`${held.ticket}: ${e.message}`);
    return;
  }
  await host.release(ex.name);
  ex.mission = null;
  if (await launch(tickets, host, ex.name, { ticket: entry.ticket, subtask: s, base }, true, failed, report)) {
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
  const mission: MissionSpec = {
    kind: "dev",
    ticket: c.ticket.id,
    subtask: s.id,
    repository: s.repository,
    branch: `agent/${s.id}`,
    base: c.base,
    instruction: devInstruction(c, resumed),
  };
  try {
    if (s.status !== "in-dev") {
      await tickets.setSubtaskStatus({ id: s.id, status: "in-dev" });
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
      await tickets.setSubtaskStatus({ id: s.id, status: "ready" });
      s.status = "ready";
    } catch (e2) {
      if (!local(e2)) throw e2;
      report.problems.push(`${c.ticket.id}: ${s.id} back to ready: ${message(e2)}`);
    }
    return false;
  }
}
