// Un tour de l'orchestrateur : lire les évènements de l'hôte, reprendre les
// missions perdues, distribuer les sous-tâches prêtes aux exécuteurs libres.
// Le tour ne journalise rien : il renvoie un compte rendu.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError } from "../tickets/model.ts";
import type { Subtask, Ticket } from "../tickets/model.ts";
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
      renameSync(tmp, path);
    },
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// Une erreur qui ne concerne qu'un ticket : le tour continue avec les autres.
const local = (e: unknown): boolean => e instanceof ConnectorError || e instanceof RuleError;
const LOST: readonly string[] = ["exited", "lost", "none"];

export async function tick(d: { tickets: Connector; host: HostApi; cursor: Cursor }): Promise<TickReport> {
  const report: TickReport = { completed: [], assigned: [], recovered: [], problems: [] };
  try {
    await run(d, report);
  } catch (e) {
    // HostError, ConnectorError de events/status/listTickets, ou toute autre
    // panne : le tour s'arrête là, la boucle (Task 5) relancera le suivant.
    report.problems.push(message(e));
  }
  return report;
}

async function run(d: { tickets: Connector; host: HostApi; cursor: Cursor }, report: TickReport): Promise<void> {
  const { tickets, host, cursor } = d;

  // 1. Évènements.
  const events = await host.events(cursor.read());
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

  // 3. Reprise.
  for (const ex of executors) {
    if (!ex.mission || !LOST.includes(ex.session)) continue;
    await recover(tickets, host, ex, ex.mission, picture, unreadable, report);
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
  const free = executors.filter((e) => e.mission === null).map((e) => e.name).sort();
  for (const c of found.candidates) {
    const to = free[0];
    if (to === undefined) break;
    if (await launch(tickets, host, to, c, false, report)) {
      free.shift();
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
  if (s.status !== "in-dev") {
    return void report.problems.push(`${ev.ticket}: event ${ev.id}: ${s.id} is ${s.status}, not in-dev; ignored`);
  }
  // Le lien d'abord : une sous-tâche `done` n'est jamais sans sa branche.
  await tickets.setSubtaskLinks({ id: s.id, branch: ev.branch });
  await tickets.setSubtaskStatus({ id: s.id, status: "done" });
  s.status = "done";
  report.completed.push(s.id);
  const holder = (await host.status()).find((e) => e.name === ev.executor);
  if (holder?.mission?.subtask === s.id) await host.release(ev.executor);
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
  if (await launch(tickets, host, ex.name, { ticket: entry.ticket, subtask: s, base }, true, report)) {
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
    report.problems.push(`${c.ticket.id}: assign ${s.id} to ${to}: ${message(e)}`);
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
