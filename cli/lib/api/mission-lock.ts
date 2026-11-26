// Le verrou des changements de mission, partagé entre processus : le service
// de l'API (assign, release, done de l'orchestrateur et des exécuteurs, déjà
// un à la fois dans sa file `exclusive()`) et `forge team assign|release`, la
// main de l'humain, qui tourne dans son propre processus. Sans lui, les deux
// verraient le même exécuteur libre avant que l'un ait écrit sa mission.
//
// Un dossier qui porte un fichier `owner`, « <pid> <jeton> », le jeton tiré au
// hasard pour chaque prise. Le dossier est préparé à côté, son `owner` écrit,
// puis renommé à sa place : le renommage est atomique, et il échoue tant
// qu'un verrou (un dossier non vide) est en place. Il n'existe donc aucun
// instant où le verrou est en place sans détenteur lisible.
//
// Un verrou dont le pid ne vit plus (ou sans `owner` lisible) est abandonné.
// Le reprendre se réclame d'abord par un marqueur `<verrou>.takeover-<jeton>`,
// créé par `mkdirSync` (atomique) : de deux processus qui trouvent le même
// verrou abandonné, un seul le reprend ; l'autre attend et retente. Le marqueur
// reste en place, pour qu'un retardataire qui aurait lu le même détenteur ne
// le réclame pas une seconde fois ; les marqueurs de plus d'une heure sont
// retirés à la prise suivante. L'attente est bornée.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiDataDir } from "../paths.ts";

export const LOCK_WAIT_MS = 150_000;
const STEP_MS = 200;
const MARKER_TTL_MS = 3_600_000;

export const missionLockPath = (): string => join(apiDataDir(), "mission.lock");

export type LockOptions = {
  path?: string; waitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
  // Pour les tests seulement : appelé quand un détenteur abandonné vient d'être
  // lu, juste avant de réclamer sa reprise (deux appels qui voient le même), et
  // juste avant d'écrire `owner` dans le dossier préparé (une écriture qui échoue).
  beforeTakeover?: () => void | Promise<void>;
  beforeOwnerWrite?: (dir: string) => void;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : le processus existe, il appartient à un autre utilisateur.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const OWNER = /^([1-9][0-9]*) ([0-9a-f-]{36})\n?$/;

// Le jeton du verrou en place s'il est abandonné, `null` s'il est tenu, `gone`
// s'il n'est plus là. Un `owner` absent, illisible ou malformé n'a pas de jeton
// à lui : le jeton de reprise est alors tiré de l'inode et du mtime du dossier
// du verrou, qui ne changent pas tant que ce dossier est en place (personne
// n'écrit plus dedans) : la reprise reste unique pour ce dossier-là.
function abandoned(path: string): string | null | "gone" {
  let content: string | undefined;
  try {
    content = readFileSync(join(path, "owner"), "utf8");
  } catch {
    content = undefined;
  }
  const m = content === undefined ? null : OWNER.exec(content);
  if (m) return alive(Number(m[1])) ? null : m[2];
  try {
    const st = statSync(path);
    return `x-${st.ino}-${Math.trunc(st.mtimeMs)}`;
  } catch {
    return "gone";
  }
}

// Au mieux : retirer les marqueurs de reprise de plus d'une heure.
function cleanMarkers(path: string): void {
  try {
    const prefix = `${basename(path)}.takeover-`;
    const limit = Date.now() - MARKER_TTL_MS;
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue;
      const marker = join(dirname(path), name);
      try {
        if (statSync(marker).mtimeMs < limit) rmSync(marker, { recursive: true, force: true });
      } catch {
        // Déjà retiré par un autre.
      }
    }
  } catch {
    // Rien à nettoyer.
  }
}

// Une tentative de prise : vrai si le verrou est à ce processus.
function tryAcquire(path: string, token: string, opts: LockOptions): boolean {
  const tmp = `${path}.new-${randomUUID()}`;
  try {
    mkdirSync(tmp, { mode: 0o700 });
    opts.beforeOwnerWrite?.(tmp);
    writeFileSync(join(tmp, "owner"), token, { mode: 0o600 });
    // Un ancien dossier `mission.lock` vide est remplacé par le renommage même.
    renameSync(tmp, path);
    return true;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw e;
  }
}

export async function withMissionLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const path = opts.path ?? missionLockPath();
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  const uuid = randomUUID();
  const token = `${process.pid} ${uuid}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    if (tryAcquire(path, token, opts)) break;
    const dead = abandoned(path);
    if (dead === "gone") continue; // libéré entre-temps : on retente la prise
    if (dead !== null) {
      await opts.beforeTakeover?.();
      let claimed = false;
      try {
        mkdirSync(`${path}.takeover-${dead}`, { mode: 0o700 });
        claimed = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Un autre a réclamé ce détenteur-là : il le reprend, on attend.
      }
      if (claimed) {
        try {
          renameSync(path, `${path}.dead-${dead}`);
          rmSync(`${path}.dead-${dead}`, { recursive: true, force: true });
        } catch {
          // Déjà parti : la prochaine tentative le dira.
        }
        continue;
      }
    }
    if (now() >= deadline) throw new ForgeError("the host is busy with another mission change: try again in a moment");
    await sleep(STEP_MS);
  }
  try {
    cleanMarkers(path);
    return await fn();
  } finally {
    // Seulement le sien : un verrou repris entre-temps (il ne devrait pas
    // l'être, ce processus vit) n'est pas retiré. Écarté par un renommage
    // d'abord, pour que la place ne reste jamais occupée par un dossier à demi
    // supprimé.
    try {
      if (readFileSync(join(path, "owner"), "utf8") === token) {
        const done = `${path}.done-${uuid}`;
        renameSync(path, done);
        rmSync(done, { recursive: true, force: true });
      }
    } catch {
      // Rien à retirer.
    }
  }
}
