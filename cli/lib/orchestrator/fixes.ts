// Les sous-tâches de correctif : un défaut (d'une QA ou d'une revue) devient
// une sous-tâche du ticket, une seule fois. Le texte du défaut est copié tel
// quel, jamais interprété.
import type { Connector } from "../tickets/connector.ts";
import type { Subtask, Ticket } from "../tickets/model.ts";
import { RuleError, stackOf } from "./rule.ts";

// La sous-tâche d'implémentation à laquelle un défaut appartient : `id`
// lui-même, ou celle qu'il corrige quand `id` est un correctif (un correctif
// n'en corrige jamais un autre). null : transverse, ou un id que la liste n'a pas.
export function resolveFixed(subtasks: Subtask[], id: string | null): Subtask | null {
  if (id === null) return null;
  const s = subtasks.find((x) => x.id === id);
  if (!s) return null;
  if (s.kind === "implementation") return s;
  return subtasks.find((x) => x.id === s.fixes && x.kind === "implementation") ?? null;
}

// Un correctif à la position de la sous-tâche corrigée, ou, transverse, une
// sous-tâche d'implémentation en haut de la pile du seul dépôt du ticket ; son
// rang passe après toutes les autres. Une sous-tâche pas finie, du même genre,
// de même `fixes` et de même texte, est rendue au lieu d'une seconde : un
// compte rendu relu ou une liste reprise ne crée rien deux fois.
export async function addFix(tickets: Connector, ticket: Ticket, a: { fixes: string | null; text: string }): Promise<Subtask> {
  const subtasks = await tickets.listSubtasks({ ticket: ticket.id });
  const fixed = resolveFixed(subtasks, a.fixes);
  const kind = fixed ? "fix" : "implementation";
  const fixes = fixed?.id ?? null;
  const same = subtasks.find((s) => s.status !== "done" && s.kind === kind && s.fixes === fixes && s.text === a.text);
  if (same) return same;
  const rank = subtasks.reduce((max, s) => Math.max(max, s.rank), 0) + 1;
  if (fixed) {
    return tickets.createSubtask({
      ticket: ticket.id, repository: fixed.repository, position: fixed.position, rank, kind: "fix", fixes: fixed.id, text: a.text,
    });
  }
  const repository = ticket.repositories[0]?.name;
  if (repository === undefined) throw new RuleError(`${ticket.id} lists no repository`);
  const position = stackOf(subtasks, repository).reduce((max, s) => Math.max(max, s.position), 0) + 1;
  return tickets.createSubtask({ ticket: ticket.id, repository, position, rank, kind: "implementation", text: a.text });
}
