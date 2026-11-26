// La règle de l'orchestrateur : quelle sous-tâche lancer, sur quelle base.
// Fonctions pures, sans entrée-sortie.
import type { Subtask, Ticket } from "../tickets/model.ts";

export class RuleError extends Error {}

export type Candidate = { ticket: Ticket; subtask: Subtask; base: string };

// La sous-tâche active : le plus petit rang parmi celles qui ne sont pas `done`.
export function activeSubtask(subtasks: Subtask[]): Subtask | null {
  let best: Subtask | null = null;
  for (const s of subtasks) {
    if (s.status === "done") continue;
    if (best === null || s.rank < best.rank) best = s;
  }
  return best;
}

// La base de la branche d'une mission : celle du ticket pour la première
// sous-tâche d'un dépôt, sinon la branche de la précédente du même dépôt.
export function missionBase(ticket: Ticket, subtasks: Subtask[], s: Subtask): string {
  if (s.position === 1) {
    const repo = ticket.repositories.find((r) => r.name === s.repository);
    if (!repo) throw new RuleError(`repository ${s.repository} is not declared on the ticket`);
    if (repo.base.startsWith("stack:")) throw new RuleError(`base ${repo.base} of ${s.repository} is a stack, not supported yet`);
    return `origin/${repo.base}`;
  }
  const prev = subtasks.find((x) => x.repository === s.repository && x.position === s.position - 1);
  if (!prev) throw new RuleError(`no sub-task at position ${s.position - 1} in ${s.repository}`);
  return `agent/${prev.id}`;
}

// Un candidat par ticket dont la sous-tâche active est `ready` et non tenue ;
// l'ordre d'entrée (priorité) est conservé, une erreur de règle devient un problème.
export function candidates(
  tickets: { ticket: Ticket; subtasks: Subtask[] }[],
  held: Set<string>,
): { candidates: Candidate[]; problems: string[] } {
  const out: Candidate[] = [];
  const problems: string[] = [];
  for (const { ticket, subtasks } of tickets) {
    const subtask = activeSubtask(subtasks);
    if (!subtask || subtask.status !== "ready" || held.has(subtask.id)) continue;
    try {
      out.push({ ticket, subtask, base: missionBase(ticket, subtasks, subtask) });
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      problems.push(`${ticket.id}: ${e.message}`);
    }
  }
  return { candidates: out, problems };
}
