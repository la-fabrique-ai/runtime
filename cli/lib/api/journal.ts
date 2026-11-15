// Le journal de l'API (DX 5, §5.4) : des lignes JSON ajoutées, jamais
// réécrites. C'est la piste d'audit et la source de l'état d'attente.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiDataDir } from "../paths.ts";
import type { Op } from "./protocol.ts";

// `answer` est la réponse de l'humain à une question (`forge team answer`) : il
// n'est jamais écrit par l'API, aucun agent ne peut l'appeler.
export type JournalOp = Op | "answer";

// `op` est null pour une ligne que le protocole n'a pas pu lire : elle n'a pas de verbe.
// `notify` n'est pas un verbe : c'est un avis que forge a écrit de lui-même
// (`forge notify`), de l'hôte, sans passer par une socket. Il a l'identifiant 0,
// hors de la suite que le service numérote en mémoire : deux écrivains ne
// peuvent donc jamais prendre le même numéro. Une réponse a le même
// identifiant 0 : elle se retrouve par `question`, pas par le sien.
export type Entry = {
  id: number; time: string; caller: string; op: JournalOp | "notify" | null; to: string | null; task: string | null;
  outcome: "ok" | "refused"; error: string | null;
  summary: string | null; // message, ask-human
  text: string | null; // le corps d'un message ou d'une question, la consigne d'un assign
  question: number | null; // pour une réponse : l'identifiant de la question qu'elle ferme
};

// Ce que `Journal.append` demande : `question` est facultatif, il vaut null.
export type NewEntry = Omit<Entry, "id" | "time" | "question"> & { question?: number | null };

function parseLines(path: string, text: string, first: number, into: Entry[]): void {
  text.split("\n").forEach((line, i) => {
    if (line === "") return;
    try {
      // Une ligne d'avant les réponses n'a pas `question` : elle se lit null.
      const e = JSON.parse(line) as Entry;
      into.push({ ...e, question: e.question ?? null });
    } catch {
      throw new ForgeError(`${path} line ${first + i + 1} is not valid JSON: the journal is never rewritten, fix or move it`);
    }
  });
}

// Lecture seule, pour les commandes qui montrent le journal sans l'écrire : un
// fichier absent est un journal vide, et rien n'est créé.
export function readEntries(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const list: Entry[] = [];
  parseLines(path, readFileSync(path, "utf8"), 0, list);
  return list;
}

export function journalPath(): string {
  return join(apiDataDir(), "journal.jsonl");
}

export class Journal {
  private next: number;
  private readonly path: string;
  private readonly list: Entry[];
  // Les octets du fichier déjà lus : le journal a plusieurs écrivains (le
  // service, `forge notify`, `forge team answer`), `refresh` lit ce qu'ils ont ajouté.
  private offset: number;

  private constructor(path: string, list: Entry[], offset: number) {
    this.path = path;
    this.list = list;
    this.offset = offset;
    this.next = list.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  // Une ligne illisible arrête l'ouverture, avec son numéro : le journal est une
  // piste d'audit, on ne le répare pas en silence.
  static open(path: string): Journal {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
    const raw = readFileSync(path);
    const list: Entry[] = [];
    parseLines(path, raw.toString("utf8"), 0, list);
    return new Journal(path, list, raw.length);
  }

  // Relit les lignes ajoutées au fichier depuis la dernière lecture, par n'importe
  // quel écrivain, ce journal compris.
  refresh(): void {
    const raw = readFileSync(this.path);
    if (raw.length <= this.offset) return;
    const text = raw.subarray(this.offset).toString("utf8");
    // Une ligne sans retour à la ligne est une écriture en cours : on l'attend.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    if (complete === "") return;
    const added: Entry[] = [];
    parseLines(this.path, complete, 0, added);
    for (const e of added) this.list.push(e);
    this.offset += Buffer.byteLength(complete);
    this.next = Math.max(this.next, added.reduce((max, e) => Math.max(max, e.id), 0) + 1);
  }

  // L'identifiant se prend tout de suite : deux messages simultanés n'en
  // partagent jamais un.
  reserve(): number {
    return this.next++;
  }

  // La liste n'est nourrie que par `refresh` : la ligne écrite ici y entre en
  // même temps que celles qu'un autre écrivain a ajoutées avant ou après elle, et
  // le décalage ne tombe jamais au milieu d'une ligne.
  append(e: NewEntry, now: Date, id?: number): Entry {
    const entry: Entry = { id: id ?? this.reserve(), time: now.toISOString(), ...e, question: e.question ?? null };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.refresh();
    return entry;
  }

  entries(): readonly Entry[] {
    return this.list;
  }
}

// Une question ouverte de l'humain : ce que la boîte montre.
export type Question = { id: number; from: string; time: string; summary: string; hasBody: boolean };

const answeredIds = (entries: readonly Entry[]): Set<number> =>
  new Set(entries.filter((e) => e.op === "answer" && e.outcome === "ok" && e.question !== null).map((e) => e.question as number));

const asQuestion = (e: Entry): Question => ({ id: e.id, from: e.caller, time: e.time, summary: e.summary ?? "", hasBody: e.text !== null });

// Les `ask-human` acceptés sans réponse acceptée, du plus ancien au plus récent.
export function inbox(entries: readonly Entry[]): Question[] {
  const answered = answeredIds(entries);
  return entries.filter((e) => e.op === "ask-human" && e.outcome === "ok" && !answered.has(e.id)).map(asQuestion);
}

export function findQuestion(entries: readonly Entry[], id: number): Question | "answered" | null {
  const ask = entries.find((e) => e.id === id && e.op === "ask-human" && e.outcome === "ok");
  if (ask === undefined) return null;
  return answeredIds(entries).has(id) ? "answered" : asQuestion(ask);
}

// Ce que `container` attend : `human` après une question, le nom d'un container
// après un message, tant que celui-ci n'a pas répondu par un message. La moitié
// « sa session ne travaille pas » de la règle est celle de l'appelant.
export function waitingOn(entries: readonly Entry[], container: string): string | null {
  const ok = entries.filter((e) => e.outcome === "ok");
  const answered = answeredIds(ok);
  const lastIndex = ok.findLastIndex((e) => e.caller === container && (e.op === "message" || e.op === "ask-human"));
  if (lastIndex < 0) return null;
  const last = ok[lastIndex];
  if (last.op === "ask-human") return answered.has(last.id) ? null : "human";
  const replied = ok.slice(lastIndex + 1).some((e) => e.op === "message" && e.caller === last.to && e.to === container);
  return replied ? null : last.to;
}
