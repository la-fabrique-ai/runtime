// L'instruction d'une mission dev, envoyée à l'agent. Le texte libre (ticket,
// sous-tâche) est copié tel quel : c'est de la donnée, jamais interprétée ici.
import type { Candidate } from "./rule.ts";

const MAX_BYTES = 65_536;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// Coupe `s` à au plus `max` octets UTF-8, sur une frontière de caractère.
function cutBytes(s: string, max: number): string {
  if (max <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let end = max;
  // 0x80-0xBF : octet de continuation, on recule jusqu'au début du caractère.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function devInstruction(c: Candidate, resumed: boolean): string {
  const { ticket, subtask } = c;
  const marker = `[cut: read the ticket ${ticket.id} in full]`;
  type Parts = { title: string; description: string; text: string };
  const render = ({ title, description, text }: Parts): string =>
    [
      `[forge] mission dev ${subtask.id} (ticket ${ticket.id})`,
      ...(resumed ? ["This mission resumes: your branch already holds the earlier work."] : []),
      "",
      "## Ticket",
      title,
      "",
      description,
      "",
      "## Sub-task",
      text,
      "",
      "## Branch",
      `agent/${subtask.id}, based on ${c.base}, in /workspace/${subtask.repository}`,
      "",
      "## When you are done",
      "commit, then run: forge-team done",
      "",
    ].join("\n");

  const parts: Parts = { title: ticket.title, description: ticket.description, text: subtask.text };
  // D'abord la description, puis le texte de la sous-tâche, enfin le titre :
  // chacun est coupé de l'excédent (plus la place du marqueur), ou remplacé
  // par le seul marqueur s'il est trop court pour l'absorber.
  for (const key of ["description", "text", "title"] as const) {
    const excess = bytes(render(parts)) - MAX_BYTES;
    if (excess <= 0) break;
    const keep = bytes(parts[key]) - excess - bytes(marker) - 1;
    parts[key] = keep >= 0 ? `${cutBytes(parts[key], keep)}\n${marker}` : marker;
  }
  return render(parts);
}
