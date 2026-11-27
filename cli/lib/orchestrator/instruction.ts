// Les instructions des missions (dev, rebase, QA), envoyées à l'agent. Le texte
// libre (ticket, sous-tâche, question, réponse, fichier de mission) est copié
// tel quel : c'est de la donnée, jamais interprétée ici.
import type { Mission, Request } from "../tickets/model.ts";
import type { MissionFiles } from "./host.ts";
import type { Candidate, QaCandidate } from "./rule.ts";

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

// La section des fichiers de mission présents (aucune ligne sans fichier).
function filesSection(files: MissionFiles): string[] {
  const present = FILE_NAMES.filter((k) => files[k] !== null);
  if (present.length === 0) return [];
  return ["## Mission files", "Read-only copies of the ticket's mission files. Read them before the code.",
    ...present.map((k) => `${MISSION_DIR}/${k}.md`), ""];
}

// Les questions déjà répondues, de la plus ancienne à la plus récente ; à
// couper, les plus anciennes partent d'abord, entières (`dropped` d'entre elles).
const answerBlocks = (answered: Request[]): string[] =>
  answered.map((r) => ["Question:", r.text, "Answer:", r.answer ?? "", ""].join("\n"));
function answersSection(blocks: string[], dropped: number, marker: string): string[] {
  if (blocks.length === 0) return [];
  return ["## Questions already answered", ...(dropped > 0 ? [marker, ""] : []), ...blocks.slice(dropped)];
}

const branchLine = (c: Candidate): string => `${c.branch}, based on ${c.base}, in /workspace/${c.subtask.repository}`;

const BLOCKED = "Ask the spec-reader sub-agent one precise question first: it reads the mission files and the code. " +
  "If it settles the question, follow its answer. If it says the spec does not settle it, commit your work, " +
  "then run: forge-team ask (the question on stdin; --recommended-file <file> for the answer you would give). " +
  "Your work goes back, this container is released, and the sub-task resumes later with the human's answer.";

export function devInstruction(
  c: Candidate,
  resumed: boolean,
  extra: { answered: Request[]; files: MissionFiles },
): string {
  const { ticket, subtask } = c;
  const marker = `[cut: read the ticket ${ticket.id} in full]`;
  const blocks = answerBlocks(extra.answered);
  let dropped = 0;
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
      ...(subtask.kind === "fix"
        ? ["", `You fix sub-task ${subtask.fixes} on its branch: add commits on top, never rewrite the ones that are there.`]
        : []),
      "",
      ...filesSection(extra.files),
      ...answersSection(blocks, dropped, marker),
      "## Branch",
      branchLine(c),
      "",
      "## If you are blocked",
      BLOCKED,
      "",
      "## When you are done",
      "commit, write in a file what you did, what you checked, what stays doubtful, and each question settled " +
        "without the human (the question, the answer, its source), then run: forge-team done --report-file <that file>",
      "",
    ].join("\n");

  const parts: Parts = { title: ticket.title, description: ticket.description, text: subtask.text };
  fit(parts, ["description"], render, marker);
  while (bytes(render(parts)) > MAX_BYTES && dropped < blocks.length) dropped++;
  fit(parts, ["text", "title"], render, marker);
  return render(parts);
}

// Une mission de rebase : rejouer les commits de la sous-tâche sur la branche
// d'en dessous, qui a changé. `builtOn` : le commit de la base sur lequel la
// branche était posée (null : inconnu, un rebase simple).
export function rebaseInstruction(c: Candidate, builtOn: string | null, resumed: boolean): string {
  const { ticket, subtask } = c;
  const marker = `[cut: read the ticket ${ticket.id} in full]`;
  const fromOrigin = c.base.startsWith("origin/");
  const ref = fromOrigin ? c.base : `team/${c.base}`;
  const rebase = builtOn === null ? `git rebase ${ref}` : `git rebase --onto ${ref} ${builtOn}`;
  type Parts = { text: string };
  const render = ({ text }: Parts): string =>
    [
      `[forge] mission rebase ${subtask.id} (ticket ${ticket.id})`,
      ...(resumed ? ["This mission resumes: your branch already holds the earlier work."] : []),
      "The branch below yours changed. Replay your sub-task's own commits onto it, and change nothing else.",
      "",
      "## Sub-task",
      text,
      "",
      `The ticket's mission files, when it has them, are under ${MISSION_DIR}.`,
      "",
      "## Branch",
      branchLine(c),
      "",
      "## How",
      fromOrigin ? "git fetch origin" : "git fetch team",
      rebase,
      "Solve a conflict as the sub-task's text and the mission files say. If they do not settle it, run git rebase --abort, " +
        "then ask as in any mission. Run the project's checks, then: forge-team done --report-file <file> " +
        "(what conflicted, how you solved it, what you ran).",
      "",
    ].join("\n");
  const parts: Parts = { text: subtask.text };
  fit(parts, ["text"], render, marker);
  return render(parts);
}

// Une mission de QA : le clone est sur le haut de la pile, l'agent teste le
// ticket entier contre sa spec et rend un compte rendu, sans rien commiter.
export function qaInstruction(q: QaCandidate, extra: { answered: Request[]; files: MissionFiles }): string {
  const { ticket } = q;
  const marker = `[cut: read the ticket ${ticket.id} in full]`;
  const blocks = answerBlocks(extra.answered);
  let dropped = 0;
  const firstLine = (t: string): string => t.split("\n", 1)[0] ?? "";
  type Parts = { title: string; description: string; stack: string };
  const render = ({ title, description, stack }: Parts): string =>
    [
      `[forge] mission qa ${ticket.id}`,
      "",
      "## Ticket",
      title,
      "",
      description,
      "",
      "## Stack",
      `In /workspace/${q.top.repository}, from the bottom up:`,
      stack,
      "",
      ...filesSection(extra.files),
      ...answersSection(blocks, dropped, marker),
      "## What to do",
      "Your clone is on the top of the stack: it holds the whole ticket. Test it against the spec, as a user would: " +
        "run the project's checks, then exercise what the ticket changes. Change no file and commit nothing. " +
        "Write your report as the qa skill says, then run: forge-team done --qa-report-file <file>",
      "",
    ].join("\n");
  const stack = q.subtasks.map((s) => `${s.id}: ${firstLine(s.text)}`).join("\n");
  const parts: Parts = { title: ticket.title, description: ticket.description, stack };
  fit(parts, ["description"], render, marker);
  while (bytes(render(parts)) > MAX_BYTES && dropped < blocks.length) dropped++;
  fit(parts, ["stack", "title"], render, marker);
  return render(parts);
}
