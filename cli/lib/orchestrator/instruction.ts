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
  const render = (description: string, text: string): string =>
    [
      `[forge] mission dev ${subtask.id} (ticket ${ticket.id})`,
      ...(resumed ? ["This mission resumes: your branch already holds the earlier work."] : []),
      "",
      "## Ticket",
      ticket.title,
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

  let description = ticket.description;
  let text = subtask.text;
  let out = render(description, text);
  if (bytes(out) <= MAX_BYTES) return out;

  // D'abord la description, puis le texte de la sous-tâche.
  const excess = bytes(out) - MAX_BYTES + bytes(marker) + 1;
  const keepDesc = bytes(description) - excess;
  if (keepDesc >= 0) {
    description = `${cutBytes(description, keepDesc)}\n${marker}`;
  } else {
    description = marker;
    const rest = bytes(render(description, text)) - MAX_BYTES + bytes(marker) + 1;
    text = `${cutBytes(text, bytes(text) - rest)}\n${marker}`;
  }
  out = render(description, text);
  return out;
}
