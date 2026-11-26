// L'instruction d'une mission dev, envoyée à l'agent. Le texte libre (ticket,
// sous-tâche, question, réponse, fichier de mission) est copié tel quel : c'est
// de la donnée, jamais interprétée ici.
import type { Mission, Request } from "../tickets/model.ts";
import type { MissionFiles } from "./host.ts";
import type { Candidate } from "./rule.ts";

const MAX_BYTES = 65_536;

// Où l'hôte pose la copie en lecture seule des fichiers de mission, dans
// l'exécuteur (plan 2b, MISSION_FILES_DIR), et la taille d'une copie.
export const MISSION_DIR = "/etc/forge/mission";
export const MISSION_FILE_MAX = 262_144;
const FILE_CUT = "[cut: this copy is partial]";
const FILE_NAMES = ["spec", "answers", "split"] as const;

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

// Les fichiers de mission tels quels, chacun coupé à MISSION_FILE_MAX octets
// (marqueur compris) s'il le dépasse.
export function missionFiles(m: Mission): MissionFiles {
  const one = (text: string | null): string | null => {
    if (text === null || bytes(text) <= MISSION_FILE_MAX) return text;
    return `${cutBytes(text, MISSION_FILE_MAX - bytes(FILE_CUT) - 1)}\n${FILE_CUT}`;
  };
  return { spec: one(m.spec), answers: one(m.answers), split: one(m.split) };
}

// Réduit `parts` (dans l'ordre de `order`) jusqu'à ce que le rendu tienne en
// MAX_BYTES : chaque champ est coupé de l'excédent (plus la place du
// marqueur), ou remplacé par le seul marqueur s'il est trop court pour l'absorber.
function fit<P extends Record<string, string>>(parts: P, order: (keyof P)[], render: (p: P) => string, marker: string): void {
  for (const key of order) {
    const excess = bytes(render(parts)) - MAX_BYTES;
    if (excess <= 0) return;
    const value = parts[key] as string;
    const keep = bytes(value) - excess - bytes(marker) - 1;
    (parts as Record<string, string>)[key as string] = keep >= 0 ? `${cutBytes(value, keep)}\n${marker}` : marker;
  }
}

export function devInstruction(
  c: Candidate,
  resumed: boolean,
  extra: { answered: Request[]; files: MissionFiles },
): string {
  const { ticket, subtask } = c;
  const marker = `[cut: read the ticket ${ticket.id} in full]`;
  const present = FILE_NAMES.filter((k) => extra.files[k] !== null);
  // Les questions déjà répondues, de la plus ancienne à la plus récente ; à
  // couper, les plus anciennes partent d'abord, entières.
  const blocks = extra.answered.map((r) => ["Question:", r.text, "Answer:", r.answer ?? "", ""].join("\n"));
  let dropped = 0;
  type Parts = { title: string; description: string; text: string };
  const render = ({ title, description, text }: Parts): string => {
    const kept = blocks.slice(dropped);
    return [
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
      ...(present.length > 0
        ? ["## Mission files", "Read-only copies of the ticket's mission files. Read them before the code.",
          ...present.map((k) => `${MISSION_DIR}/${k}.md`), ""]
        : []),
      ...(blocks.length > 0
        ? ["## Questions already answered", ...(dropped > 0 ? [marker, ""] : []), ...kept]
        : []),
      "## Branch",
      `agent/${subtask.id}, based on ${c.base}, in /workspace/${subtask.repository}`,
      "",
      "## If you are blocked",
      "Ask one precise question: forge-team ask (the question on stdin). The answer arrives in this terminal. " +
        "If forge tells you the question waits for the human: commit your work, then run forge-team done --wip.",
      "",
      "## When you are done",
      "commit, write what you did, what you checked and what stays doubtful in a file, " +
        "then run: forge-team done --report-file <that file>",
      "",
    ].join("\n");
  };

  const parts: Parts = { title: ticket.title, description: ticket.description, text: subtask.text };
  fit(parts, ["description"], render, marker);
  while (bytes(render(parts)) > MAX_BYTES && dropped < blocks.length) dropped++;
  fit(parts, ["text", "title"], render, marker);
  return render(parts);
}
