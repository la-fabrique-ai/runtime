// Les enregistrements de branches de l'hôte (§6.7) : pour chaque branche d'un
// projet, son ticket, sa sous-tâche, sa base et son exécuteur. Ils remplacent
// les clés `user.forge.base.<tâche>` du modèle à un seul dépôt.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ForgeError } from "./context.ts";
import { apiDataDir } from "./paths.ts";

export type BranchRecord = {
  branch: string; repository: string; ticket: string; subtask: string; base: string; executor: string | null;
};

const KEYS = ["base", "branch", "executor", "repository", "subtask", "ticket"];

export function branchRecordsPath(): string {
  return join(apiDataDir(), "branches.json");
}

// Validation à la main : un fichier édité ou abîmé doit être refusé en nommant son chemin.
function parse(path: string, text: string): BranchRecord[] {
  const bad = (why: string): ForgeError => new ForgeError(`${path} is not a valid branch records file (${why}): fix or move it`);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw bad("not valid JSON"); }
  const o = data as { version?: unknown; records?: unknown } | null;
  if (typeof o !== "object" || o === null || o.version !== 1 || !Array.isArray(o.records)) throw bad("expected version 1 and a records list");
  return o.records.map((r: unknown, i: number) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw bad(`record ${i} is not an object`);
    const rec = r as Record<string, unknown>;
    if (Object.keys(rec).sort().join() !== KEYS.join()) throw bad(`record ${i} has the wrong keys`);
    for (const k of KEYS) {
      if (k === "executor" ? rec[k] !== null && typeof rec[k] !== "string" : typeof rec[k] !== "string") throw bad(`record ${i}: bad ${k}`);
    }
    return rec as BranchRecord;
  });
}

// Un fichier absent est une liste vide.
export function readBranchRecords(path: string = branchRecordsPath()): BranchRecord[] {
  if (!existsSync(path)) return [];
  return parse(path, readFileSync(path, "utf8"));
}

export function branchRecord(repository: string, branch: string, path: string = branchRecordsPath()): BranchRecord | null {
  return readBranchRecords(path).find((r) => r.repository === repository && r.branch === branch) ?? null;
}

// Une seule fiche par `repository` + `branch`. Pas de verrou de fichier :
// l'API sérialise assign et done avec `exclusive()`, il n'y a qu'un écrivain à la fois.
// L'écriture passe par un fichier temporaire du même dossier puis un rename,
// pour qu'un lecteur ne voie jamais un fichier à moitié écrit.
export function recordBranch(r: BranchRecord, path: string = branchRecordsPath()): void {
  const records = readBranchRecords(path).filter((x) => !(x.repository === r.repository && x.branch === r.branch));
  records.push(r);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.branches-${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify({ version: 1, records }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
