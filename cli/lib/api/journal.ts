// Le journal de l'API : des lignes JSON ajoutées, jamais réécrites. C'est la
// piste d'audit, et la source des évènements (`done`) que l'orchestrateur lit.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiDataDir } from "../paths.ts";
import type { HeldMission } from "../orchestrator/host.ts";
import type { MissionVerb } from "./missions.ts";

// Les verbes de mission (api/missions.ts). Un journal tenu avant le modèle à
// tickets garde ses lignes et leurs ids : elles se lisent, leur `op` (les
// verbes des équipes) n'est plus écrit.
export type JournalOp = MissionVerb;

// `op` est null pour une ligne que le protocole n'a pas pu lire : elle n'a pas de verbe.
// `notify` n'est pas un verbe : c'est un avis que forge a écrit de lui-même
// (`forge notify`), de l'hôte, sans passer par une socket. Il a l'identifiant 0,
// hors de la suite que le service numérote en mémoire : deux écrivains ne
// peuvent donc jamais prendre le même numéro. `forge team assign` et `release`
// (l'appelant `human`) ont le même identifiant 0.
export type Entry = {
  id: number; time: string; caller: string; op: JournalOp | "notify" | null; to: string | null; task: string | null;
  outcome: "ok" | "refused"; error: string | null;
  summary: string | null; // l'avis de `forge notify`
  text: string | null; // la consigne d'un assign, le compte rendu d'un done, la question d'un ask
  // La mission d'un `assign` ou d'un `done`, sans sa consigne : un `done`
  // accepté devient un évènement (`events`). Absente des autres lignes.
  mission?: HeldMission;
  // La réponse recommandée d'un ask, quand le développeur en donne une.
  recommended?: string;
};

export type NewEntry = Omit<Entry, "id" | "time">;

function parseLines(path: string, text: string, first: number, into: Entry[]): void {
  text.split("\n").forEach((line, i) => {
    if (line === "") return;
    try {
      into.push(JSON.parse(line) as Entry);
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
  // service, `forge notify`, `forge team assign|release`), `refresh` lit ce qu'ils ont ajouté.
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

  // L'identifiant se prend tout de suite : deux appels simultanés n'en
  // partagent jamais un.
  reserve(): number {
    return this.next++;
  }

  // La liste n'est nourrie que par `refresh` : la ligne écrite ici y entre en
  // même temps que celles qu'un autre écrivain a ajoutées avant ou après elle, et
  // le décalage ne tombe jamais au milieu d'une ligne.
  append(e: NewEntry, now: Date, id?: number): Entry {
    // Ce qu'un autre écrivain a ajouté d'abord : l'id réservé ici le suit.
    if (id === undefined) this.refresh();
    const entry: Entry = { id: id ?? this.reserve(), time: now.toISOString(), ...e };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.refresh();
    return entry;
  }

  entries(): readonly Entry[] {
    return this.list;
  }
}
