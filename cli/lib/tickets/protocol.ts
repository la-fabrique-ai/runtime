// Le protocole JSON-lines des adaptateurs de tickets : une requête par ligne
// `{"op", "args"}` sur stdin, une réponse par ligne `{"ok", …}` sur stdout.
// Un seul tableau relie chaque opération à son validateur de résultat : OPS et
// le client en dérivent, une opération ne peut pas exister d'un côté seulement.
import type { Context } from "../context.ts";
import type { Connector } from "./connector.ts";
import {
  ConnectorError,
  parseComment,
  parseMission,
  parseProblem,
  parseRequest,
  parseSubtask,
  parseTicket,
} from "./model.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function list<T>(raw: unknown, parse: (r: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw new ConnectorError("result is not a list");
  return raw.map(parse);
}

function envelope(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) throw new ConnectorError("result is not an object");
  return raw;
}

type Parsers = { [K in keyof Connector]: (raw: unknown) => Awaited<ReturnType<Connector[K]>> };

const PARSERS: Parsers = {
  listTickets: (raw) => {
    const o = envelope(raw);
    return { tickets: list(o.tickets, parseTicket), problems: list(o.problems, parseProblem) };
  },
  getTicket: parseTicket,
  createTicket: parseTicket,
  setTicketStatus: parseTicket,
  listSubtasks: (raw) => list(raw, parseSubtask),
  createSubtask: parseSubtask,
  setSubtaskStatus: parseSubtask,
  setSubtaskLinks: parseSubtask,
  openRequest: parseRequest,
  listRequests: (raw) => list(raw, parseRequest),
  answerRequest: parseRequest,
  listComments: (raw) => {
    const o = envelope(raw);
    if (o.cursor !== null && typeof o.cursor !== "string") throw new ConnectorError("cursor is not a string or null");
    return { comments: list(o.comments, parseComment), cursor: o.cursor };
  },
  addComment: parseComment,
  readMission: parseMission,
  writeMission: parseMission,
};

export const OPS = Object.keys(PARSERS) as (keyof Connector)[];

// Côté adaptateur : une ligne en entrée, une ligne de réponse. Seul un
// ConnectorError livre son message ; le reste ne fuit rien (chemins, piles).
export async function serveLine(connector: Connector, line: string): Promise<string> {
  try {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      throw new ConnectorError("request is not valid JSON");
    }
    if (!isObject(req) || typeof req.op !== "string") throw new ConnectorError("request needs an op");
    // Object.hasOwn, jamais `in` : `constructor` ou `toString` ne sont pas des opérations.
    if (!Object.hasOwn(PARSERS, req.op)) throw new ConnectorError(`unknown op ${JSON.stringify(req.op)}`);
    if (!isObject(req.args)) throw new ConnectorError("args must be an object");
    const op = req.op as keyof Connector;
    const result = await (connector[op] as (a: unknown) => Promise<unknown>)(req.args);
    return JSON.stringify({ ok: true, result });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof ConnectorError ? e.message : "internal error" });
  }
}

// Le message d'un adaptateur est une donnée externe : borné, sans caractère de contrôle.
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 500);

// Côté client : chaque appel lance l'adaptateur une fois. Le fichier
// d'identifiants passe par l'environnement, jamais par la requête.
export function execAdapter(
  ctx: Context,
  opts: { argv: string[]; credentialFile?: string; timeoutMs?: number },
): Connector {
  const name = opts.argv[0];
  const fail = (why: string): never => {
    throw new ConnectorError(`adapter ${name}: ${why}`);
  };
  const call = async (op: keyof Connector, args: unknown): Promise<unknown> => {
    // `env` se superpose à l'environnement hérité (PATH…) : on n'ajoute que le fichier.
    const env = opts.credentialFile === undefined ? undefined : { FORGE_ADAPTER_CREDENTIAL_FILE: opts.credentialFile };
    const r = await ctx.exec(opts.argv, { input: JSON.stringify({ op, args }) + "\n", env, timeoutMs: opts.timeoutMs ?? 30_000 });
    if (r.timedOut) return fail("timed out");
    if (r.code !== 0) return fail(`exit code ${r.code}`);
    const out = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    if (out === "" || out.includes("\n")) return fail("expected exactly one line of output");
    let res: unknown;
    try {
      res = JSON.parse(out);
    } catch {
      return fail("output is not valid JSON");
    }
    if (!isObject(res)) return fail("response is not an object");
    if (res.ok === false) return fail(typeof res.error === "string" ? clean(res.error) : "unspecified error");
    if (res.ok !== true) return fail("response has no ok");
    try {
      return PARSERS[op](res.result);
    } catch (e) {
      return fail(`invalid result for ${op}: ${clean(e instanceof Error ? e.message : String(e))}`);
    }
  };
  return Object.fromEntries(OPS.map((op) => [op, (a: unknown) => call(op, a)])) as unknown as Connector;
}
