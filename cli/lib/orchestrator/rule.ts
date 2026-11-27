// La règle de l'orchestrateur : quelle sous-tâche lancer, sur quelle base.
// Fonctions pures, sans entrée-sortie.
import type { Subtask, Ticket } from "../tickets/model.ts";
import type { StackBranch } from "./host.ts";

export class RuleError extends Error {}

// `branch` : la branche de la mission (celle de la sous-tâche corrigée pour un
// correctif) ; `rebase` quand la sous-tâche est `ready` avec la raison `rebase`.
export type Candidate = { ticket: Ticket; subtask: Subtask; base: string; kind: "dev" | "rebase"; branch: string };

// Une QA à faire : `top` est la sous-tâche du haut de la pile, `base` sa base,
// `stack` les branches de la pile de bas en haut.
export type QaCandidate = { ticket: Ticket; top: Subtask; base: string; stack: StackBranch[] };

// La pile d'un dépôt : ses sous-tâches d'implémentation, par position. Un
// correctif partage la position de celle qu'il corrige : il n'y est pas.
export function stackOf(subtasks: Subtask[], repository: string): Subtask[] {
  return subtasks
    .filter((s) => s.kind === "implementation" && s.repository === repository)
    .sort((a, b) => a.position - b.position);
}

// La sous-tâche d'implémentation qu'un correctif corrige, ou une RuleError.
function fixedBy(subtasks: Subtask[], fix: Subtask): Subtask {
  const fixed = subtasks.find((x) => x.id === fix.fixes && x.kind === "implementation");
  if (!fixed) throw new RuleError(`${fix.id} fixes ${fix.fixes ?? "nothing"}, which is not an implementation sub-task of the ticket`);
  return fixed;
}

// La branche d'une sous-tâche : celle de la sous-tâche corrigée pour un correctif.
export function branchOf(subtasks: Subtask[], s: Subtask): string {
  return s.kind === "fix" ? `agent/${fixedBy(subtasks, s).id}` : `agent/${s.id}`;
}

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
// sous-tâche d'un dépôt, sinon la branche de la précédente de sa pile ; pour un
// correctif, la base de la sous-tâche qu'il corrige.
export function missionBase(ticket: Ticket, subtasks: Subtask[], s: Subtask): string {
  if (s.kind === "fix") return missionBase(ticket, subtasks, fixedBy(subtasks, s));
  if (s.position === 1) {
    const repo = ticket.repositories.find((r) => r.name === s.repository);
    if (!repo) throw new RuleError(`repository ${s.repository} is not declared on the ticket`);
    if (repo.base.startsWith("stack:")) throw new RuleError(`base ${repo.base} of ${s.repository} is a stack, not supported yet`);
    return `origin/${repo.base}`;
  }
  const prev = stackOf(subtasks, s.repository).find((x) => x.position === s.position - 1);
  if (!prev) throw new RuleError(`no sub-task at position ${s.position - 1} in ${s.repository}`);
  return `agent/${prev.id}`;
}

// Un candidat par ticket dont la sous-tâche active est `ready` et non tenue ;
// l'ordre d'entrée (priorité) est conservé, une erreur de règle devient un problème.
// Un ticket de `waiting` (une question attend l'humain) n'en donne aucun.
export function candidates(
  tickets: { ticket: Ticket; subtasks: Subtask[] }[],
  held: Set<string>,
  waiting: Set<string> = new Set(),
): { candidates: Candidate[]; problems: string[] } {
  const out: Candidate[] = [];
  const problems: string[] = [];
  for (const { ticket, subtasks } of tickets) {
    if (waiting.has(ticket.id)) continue;
    const subtask = activeSubtask(subtasks);
    if (!subtask || subtask.status !== "ready" || held.has(subtask.id)) continue;
    try {
      out.push({
        ticket, subtask, base: missionBase(ticket, subtasks, subtask),
        kind: subtask.reason === "rebase" ? "rebase" : "dev", branch: branchOf(subtasks, subtask),
      });
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      problems.push(`${ticket.id}: ${e.message}`);
    }
  }
  return { candidates: out, problems };
}

// Une QA par ticket dont toutes les sous-tâches sont `done` et qui a au moins
// une sous-tâche d'implémentation ; l'ordre d'entrée (priorité) est conservé.
// Un ticket de plusieurs dépôts n'en a pas encore (partie 4).
export function qaCandidates(
  tickets: { ticket: Ticket; subtasks: Subtask[] }[],
): { candidates: QaCandidate[]; problems: string[] } {
  const out: QaCandidate[] = [];
  const problems: string[] = [];
  for (const { ticket, subtasks } of tickets) {
    if (subtasks.length === 0 || subtasks.some((s) => s.status !== "done")) continue;
    if (ticket.repositories.length > 1) {
      problems.push(`${ticket.id}: several repositories: QA comes with part 4`);
      continue;
    }
    const repository = ticket.repositories[0]?.name;
    const stack = repository === undefined ? [] : stackOf(subtasks, repository);
    if (stack.length === 0) continue;
    try {
      const branches = stack.map((s) => ({ repository: s.repository, branch: `agent/${s.id}`, base: missionBase(ticket, subtasks, s) }));
      const top = stack[stack.length - 1]!;
      out.push({ ticket, top, base: branches[branches.length - 1]!.base, stack: branches });
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      problems.push(`${ticket.id}: ${e.message}`);
    }
  }
  return { candidates: out, problems };
}
