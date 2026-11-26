import { connect } from "node:net";

// Contrat de l'API hôte, vu de l'orchestrateur (qui tourne dans un container).
// L'hôte l'implémente (plan 1c) sur un socket ; `socketHost` en est le client.
//
// Format sur le fil, une ligne JSON dans chaque sens :
//   {"op":"status"}                                  -> {"ok":true,"executors":[ExecutorStatus…]}
//   {"op":"assign","to":…,"mission":{MissionSpec}}   -> {"ok":true}
//   {"op":"release","to":…}                          -> {"ok":true}
//   {"op":"events","after":<n>}                      -> {"ok":true,"events":[HostEvent…],"last":<n>}
//   tout refus                                       -> {"ok":false,"error":"…"}
//
// `events` : les évènements d'id > `after`, par id croissant ; `last` est le
// plus grand id du journal de l'hôte (0 s'il est vide). L'id d'un `done` est
// pris au moment où l'hôte l'ajoute au journal. Un `last` inférieur au curseur
// de l'orchestrateur signale un journal reparti de zéro.
//
// `assign` refuse une sous-tâche déjà tenue par un autre exécuteur
// (`"<sous-tâche> is held by <exécuteur>"`). Il peut être long (préparer le
// clone, lancer la session) : son délai est séparé, 120 s par défaut. Chaque
// étape de l'hôte a son propre délai (git 20 à 60 s, incus et hc 30 s), dont la
// somme dépasse 120 s : un assign très lent peut être accepté par l'hôte après
// que ce client a abandonné. Le tour suivant le voit tenu et `ready`, et le
// remet `in-dev` (la branche « tenue mais ready » de tick.ts) : rien ne se perd.
//
// La reprise d'une session perdue est `release` puis `assign` de la même
// mission : l'hôte la reconnaît au clone, déjà sur `agent/<sous-tâche>`, dont
// il garde le travail tel quel, même non commité.
//
// `session` : `none` = container démarré, hc joignable, aucun terminal ;
// un container arrêté, un exec en échec ou hors délai vaut `unknown`, comme un
// exécuteur libre dont un clone a des changements suivis (il refuserait tout). Seuls `lost` et
// `exited` déclenchent une reprise ; un exécuteur `unknown` n'est pas libre
// (aucune mission ne lui est donnée) et la reprise ne le libère jamais.

export type MissionKind = "dev";

export type MissionSpec = {
  kind: MissionKind;
  ticket: string;
  subtask: string;
  repository: string;
  branch: string;
  base: string;
  instruction: string;
};

export type HeldMission = Omit<MissionSpec, "instruction">;

// `blocked` : l'agent attend une réponse à son écran ; l'orchestrateur le signale.
export type SessionState = "none" | "idle" | "working" | "done" | "blocked" | "exited" | "lost" | "unknown";

export type ExecutorStatus = { name: string; mission: HeldMission | null; session: SessionState };

export type HostEvent = { id: number; kind: "done"; executor: string; ticket: string; subtask: string; branch: string };

export interface HostApi {
  status(): Promise<ExecutorStatus[]>;
  assign(to: string, mission: MissionSpec): Promise<void>;
  release(to: string): Promise<void>;
  events(after: number): Promise<{ events: HostEvent[]; last: number }>;
}

export class HostError extends Error {}

const SESSIONS: readonly string[] = ["none", "idle", "working", "done", "blocked", "exited", "lost", "unknown"];
const MAX_REPLY = 4 * 1024 * 1024;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Les clés de l'objet sont exactement `keys` : toute dérive de l'hôte est bruyante.
function exact(v: unknown, keys: string[]): v is Obj {
  return isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
}

const isStr = (v: unknown): v is string => typeof v === "string";

function parseHeld(v: unknown): HeldMission | null {
  if (v === null) return null;
  const keys = ["kind", "ticket", "subtask", "repository", "branch", "base"];
  if (!exact(v, keys) || !keys.every((k) => isStr(v[k])) || v.kind !== "dev") throw new Error("mission invalide");
  return { kind: "dev", ticket: v.ticket as string, subtask: v.subtask as string, repository: v.repository as string, branch: v.branch as string, base: v.base as string };
}

function parseExecutors(v: unknown): ExecutorStatus[] {
  if (!Array.isArray(v)) throw new Error("executors n'est pas un tableau");
  return v.map((e) => {
    if (!exact(e, ["name", "mission", "session"]) || !isStr(e.name) || !isStr(e.session) || !SESSIONS.includes(e.session)) {
      throw new Error("exécuteur invalide");
    }
    return { name: e.name, mission: parseHeld(e.mission), session: e.session as SessionState };
  });
}

// La réponse entière : ses clés sont exactement `ok`, `events` et `last`.
function parseEvents(r: Obj): { events: HostEvent[]; last: number } {
  if (!exact(r, ["ok", "events", "last"])) throw new Error("réponse events invalide");
  const { events: v, last } = r;
  if (!Number.isSafeInteger(last) || (last as number) < 0) throw new Error("last invalide");
  if (!Array.isArray(v)) throw new Error("events n'est pas un tableau");
  const events = v.map((e): HostEvent => {
    if (
      !exact(e, ["id", "kind", "executor", "ticket", "subtask", "branch"]) ||
      !Number.isInteger(e.id) || (e.id as number) < 0 || e.kind !== "done" ||
      !isStr(e.executor) || !isStr(e.ticket) || !isStr(e.subtask) || !isStr(e.branch)
    ) {
      throw new Error("évènement invalide");
    }
    return { id: e.id as number, kind: "done", executor: e.executor, ticket: e.ticket, subtask: e.subtask, branch: e.branch };
  });
  // Par id croissant, aucun au-delà de `last` : le curseur ne fait qu'avancer.
  events.forEach((e, i) => {
    if ((i > 0 && e.id <= events[i - 1]!.id) || e.id > (last as number)) throw new Error("évènements hors d'ordre");
  });
  return { events, last: last as number };
}

// Une connexion par appel : écrire la requête, lire une ligne, fermer.
function call(path: string, timeoutMs: number, request: Obj): Promise<Obj> {
  const op = String(request.op);
  return new Promise((resolve, reject) => {
    let done = false;
    let buf = "";
    let size = 0;
    const socket = connect(path);
    const finish = (err: Error | null, value?: Obj): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value as Obj);
    };
    const fail = (why: string): void => finish(new HostError(`hôte, ${op} : ${why}`));
    const timer = setTimeout(() => fail(`délai de ${timeoutMs} ms dépassé`), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_REPLY) return fail("réponse trop grosse");
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.slice(0, nl));
      } catch {
        return fail("réponse illisible");
      }
      if (!isObj(parsed) || typeof parsed.ok !== "boolean") return fail("réponse invalide");
      if (!parsed.ok) return fail(isStr(parsed.error) ? parsed.error : "refus sans message");
      finish(null, parsed);
    });
    socket.on("error", (e) => fail(e.message));
    socket.on("close", () => fail("connexion fermée sans réponse"));
  });
}

export function socketHost(path: string, opts: { timeoutMs?: number; assignTimeoutMs?: number } = {}): HostApi {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const assignTimeoutMs = opts.assignTimeoutMs ?? 120_000;
  // Valide la réponse ; toute erreur de forme devient une HostError nommant l'op.
  const run = async <T>(request: Obj, pick: (r: Obj) => T): Promise<T> => {
    const reply = await call(path, request.op === "assign" ? assignTimeoutMs : timeoutMs, request);
    try {
      return pick(reply);
    } catch (e) {
      throw new HostError(`hôte, ${String(request.op)} : ${(e as Error).message}`);
    }
  };
  return {
    status: () => run({ op: "status" }, (r) => parseExecutors(r.executors)),
    assign: (to, mission) => run({ op: "assign", to, mission }, () => undefined),
    release: (to) => run({ op: "release", to }, () => undefined),
    events: (after) => run({ op: "events", after }, parseEvents),
  };
}
