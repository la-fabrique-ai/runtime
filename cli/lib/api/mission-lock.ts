// Le verrou des changements de mission, partagé entre processus : le service
// de l'API (assign, release, done de l'orchestrateur et des exécuteurs, déjà
// un à la fois dans sa file `exclusive()`) et `forge team assign|release`, la
// main de l'humain, qui tourne dans son propre processus. Sans lui, les deux
// verraient le même exécuteur libre avant que l'un ait écrit sa mission.
//
// Un dossier créé par `mkdirSync` (atomique : un seul processus le crée), qui
// garde le pid de son détenteur. Un verrou dont le pid ne vit plus est
// abandonné : il est repris. L'attente est bornée.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiDataDir } from "../paths.ts";

export const LOCK_WAIT_MS = 150_000;
const STEP_MS = 200;
// Un dossier sans pid lisible est celui d'un détenteur qui ne l'a pas encore
// écrit ; passé ce délai, il est tenu pour abandonné.
const NO_PID_GRACE_MS = 10_000;

export const missionLockPath = (): string => join(apiDataDir(), "mission.lock");

export type LockOptions = { path?: string; waitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : le processus existe, il appartient à un autre utilisateur.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Vrai quand le verrou en place est abandonné : son pid ne vit plus, ou il n'a
// jamais écrit de pid lisible depuis plus que le délai de grâce.
function stale(path: string, now: number): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(path, "pid"), "utf8").trim());
  } catch {
    try {
      return now - statSync(path).mtimeMs > NO_PID_GRACE_MS;
    } catch {
      return false; // déjà retiré : la prochaine tentative le prendra
    }
  }
  return !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid);
}

export async function withMissionLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const path = opts.path ?? missionLockPath();
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (stale(path, now())) {
      // Repris par un renommage : de deux processus qui le trouvent abandonné,
      // un seul réussit, l'autre retente la création.
      const aside = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Un autre l'a repris d'abord.
      }
      continue;
    }
    if (now() >= deadline) throw new ForgeError("the host is busy with another mission change: try again in a moment");
    await sleep(STEP_MS);
  }
  const pidFile = join(path, "pid");
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
  try {
    return await fn();
  } finally {
    // Seulement le sien : un verrou repris entre-temps (il ne devrait pas
    // l'être, ce processus vit) n'est pas retiré.
    try {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(path, { recursive: true, force: true });
    } catch {
      // Rien à retirer.
    }
  }
}
