import { connect } from "node:net";

// Contrat de l'API hôte, vu de l'orchestrateur (qui tourne dans un container).
// L'hôte l'implémente (plan 1c) sur un socket ; `socketHost` en est le client.
//
// Format sur le fil, une ligne JSON dans chaque sens :
//   {"op":"status"}                                  -> {"ok":true,"executors":[ExecutorStatus…]}
//   {"op":"assign","to":…,"mission":{MissionSpec}}   -> {"ok":true}
//   {"op":"release","to":…}                          -> {"ok":true}
//   {"op":"events","after":<n>}                      -> {"ok":true,"events":[HostEvent…],"last":<n>}
//   {"op":"stack","branches":[{"repository":…,"branch":…,"base":…}…]}
//                                                    -> {"ok":true,"branches":[{"branch":…,"current":<bool>,"builtOn":<sha or null>}…]}
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
// `session` (de l'état d'un exécuteur) : `none` = container démarré, hc joignable, aucun terminal ;
// un container arrêté, un exec en échec ou hors délai vaut `unknown`, comme un
// exécuteur libre dont un clone a des changements suivis (il refuserait tout). Seuls `lost` et
// `exited` déclenchent une reprise ; un exécuteur `unknown` n'est pas libre
// (aucune mission ne lui est donnée) et la reprise ne le libère jamais.

// `dev` : développer une sous-tâche (pour un correctif, `subtask` est l'id du
// correctif et `branch` la branche de la sous-tâche qu'il corrige) ;
// `rebase` : rejouer la sous-tâche `subtask` sur `base` ; `qa` : tester le haut
// de la pile (`subtask` en est la sous-tâche du haut), sans rien commiter.
export type MissionKind = "dev" | "rebase" | "qa";
const KINDS: readonly string[] = ["dev", "rebase", "qa"];

export type MissionSpec = {
  kind: MissionKind;
  ticket: string;
  subtask: string;
  repository: string;
  branch: string;
  base: string;
  instruction: string;
  files: MissionFiles;
};

// Les fichiers de mission du ticket, copiés tels quels (null : absent).
export type MissionFiles = { spec: string | null; answers: string | null; split: string | null };

export type HeldMission = Omit<MissionSpec, "instruction" | "files">;

// `blocked` : l'agent attend une réponse à son écran ; l'orchestrateur le signale.
export type SessionState = "none" | "idle" | "working" | "done" | "blocked" | "exited" | "lost" | "unknown";

export type ExecutorStatus = { name: string; mission: HeldMission | null; session: SessionState };

// Le compte rendu structuré d'une QA ; `subtask` null : un défaut transverse.
export type QaDefect = { subtask: string | null; text: string };
export type QaReport = { verdict: "ok" | "ko"; defects: QaDefect[] };

// `report` : le compte rendu final de l'agent, tel quel ; `mission` : le genre
// de la mission rendue ; `qa` : null sauf pour une mission `qa`.
export type DoneEvent = {
  id: number; kind: "done"; executor: string; ticket: string; subtask: string; branch: string; report: string | null;
  mission: MissionKind; qa: QaReport | null;
};
// Une question pour l'humain (décision 35) : le développeur a rendu son travail
// en cours ; `recommended` est la réponse qu'il recommanderait, ou null ;
// `mission` : le genre de la mission qui demande (une QA demande aussi, sans
// rien rendre).
export type AskEvent = {
  id: number; kind: "ask"; executor: string; ticket: string; subtask: string; text: string; recommended: string | null;
  mission: MissionKind;
};
export type HostEvent = DoneEvent | AskEvent;

// Une branche d'une pile, et ce que l'hôte sait d'elle : `builtOn` est le
// commit de `base` sur lequel elle était posée à son dernier rendu (null :
// jamais enregistré) ; `current` dit si ce commit est encore la pointe de `base`.
export type StackBranch = { repository: string; branch: string; base: string };
export type StackState = { branch: string; current: boolean; builtOn: string | null };

export interface HostApi {
  status(): Promise<ExecutorStatus[]>;
  assign(to: string, mission: MissionSpec): Promise<void>;
  release(to: string): Promise<void>;
  events(after: number): Promise<{ events: HostEvent[]; last: number }>;
  // Un état par branche, dans l'ordre demandé.
  stack(branches: StackBranch[]): Promise<StackState[]>;
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
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function parseHeld(v: unknown): HeldMission | null {
  if (v === null) return null;
  const keys = ["kind", "ticket", "subtask", "repository", "branch", "base"];
  if (!exact(v, keys) || !keys.every((k) => isStr(v[k])) || !KINDS.includes(v.kind as string)) throw new Error("mission invalide");
  return { kind: v.kind as MissionKind, ticket: v.ticket as string, subtask: v.subtask as string, repository: v.repository as string, branch: v.branch as string, base: v.base as string };
}

function parseExecutors(v: unknown): ExecutorStatus[] {
  if (!Array.isArray(v)) throw new Error("executors n'est pas un tableau");
  return v.map((e) => {
    if (
      !exact(e, ["name", "mission", "session"]) || !isStr(e.name) || !isStr(e.session) || !SESSIONS.includes(e.session)
    ) {
      throw new Error("exécuteur invalide");
    }
    return { name: e.name, mission: parseHeld(e.mission), session: e.session as SessionState };
  });
}

function parseEvent(e: unknown): HostEvent {
  if (!isObj(e) || !isId(e.id) || !isStr(e.executor) || !isStr(e.ticket) || !isStr(e.subtask)) {
    throw new Error("évènement invalide");
  }
  const base = { id: e.id, executor: e.executor, ticket: e.ticket, subtask: e.subtask };
  if (
    e.kind === "ask" && exact(e, ["id", "kind", "executor", "ticket", "subtask", "text", "recommended", "mission"]) &&
    isStr(e.text) && (e.recommended === null || isStr(e.recommended)) && KINDS.includes(e.mission as string)
  ) {
    return { ...base, kind: "ask", text: e.text, recommended: e.recommended as string | null, mission: e.mission as MissionKind };
  }
  if (
    e.kind === "done" && exact(e, ["id", "kind", "executor", "ticket", "subtask", "branch", "report", "mission", "qa"]) &&
    isStr(e.branch) && (e.report === null || isStr(e.report)) && KINDS.includes(e.mission as string)
  ) {
    const mission = e.mission as MissionKind;
    // Le compte rendu structuré n'existe que pour une QA, et la QA l'a toujours.
    const qa = mission === "qa" ? parseQa(e.qa) : e.qa === null ? null : bad();
    return { ...base, kind: "done", branch: e.branch, report: e.report as string | null, mission, qa };
  }
  throw new Error("évènement invalide");
}

const bad = (): never => {
  throw new Error("évènement invalide");
};

function parseQa(v: unknown): QaReport {
  if (!exact(v, ["verdict", "defects"]) || (v.verdict !== "ok" && v.verdict !== "ko") || !Array.isArray(v.defects)) bad();
  const r = v as Obj;
  const defects = (r.defects as unknown[]).map((d) => {
    if (!exact(d, ["subtask", "text"]) || !(d.subtask === null || isStr(d.subtask)) || !isStr(d.text)) bad();
    const o = d as Obj;
    return { subtask: o.subtask as string | null, text: o.text as string };
  });
  return { verdict: r.verdict as "ok" | "ko", defects };
}

function parseStack(r: Obj, asked: number): StackState[] {
  if (!exact(r, ["ok", "branches"]) || !Array.isArray(r.branches) || r.branches.length !== asked) {
    throw new Error("réponse stack invalide");
  }
  return (r.branches as unknown[]).map((b) => {
    if (!exact(b, ["branch", "current", "builtOn"]) || !isStr(b.branch) || typeof b.current !== "boolean" ||
      !(b.builtOn === null || isStr(b.builtOn))) {
      throw new Error("état de branche invalide");
    }
    return { branch: b.branch, current: b.current, builtOn: b.builtOn as string | null };
  });
}

// La réponse entière : ses clés sont exactement `ok`, `events` et `last`.
function parseEvents(r: Obj): { events: HostEvent[]; last: number } {
  if (!exact(r, ["ok", "events", "last"])) throw new Error("réponse events invalide");
  const { events: v, last } = r;
  if (!Number.isSafeInteger(last) || (last as number) < 0) throw new Error("last invalide");
  if (!Array.isArray(v)) throw new Error("events n'est pas un tableau");
  const events = v.map(parseEvent);
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
    stack: (branches) => run({ op: "stack", branches }, (r) => parseStack(r, branches.length)),
  };
}
