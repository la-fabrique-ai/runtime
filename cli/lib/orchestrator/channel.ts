// Le canal local de l'orchestrateur : les sessions du container de contrôle
// (le Pilote, les sessions de question), qui tournent en aiuser, atteignent la
// base des tickets par quelques verbes étroits, sur une socket Unix que
// l'utilisateur de l'orchestrateur possède et que le groupe d'aiuser peut
// écrire (spec §6.2, §6.5). Une requête est une ligne JSON validée à la main,
// la réponse une ligne JSON, comme l'API de l'hôte.
//
// Le canal ne rend jamais un chemin, une trace ni une credential : seulement le
// message d'une ConnectorError, d'une QuestionError ou de sa propre validation ;
// toute autre erreur est `internal error`. Rien ici n'écrit dans une session.
import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError, isTicketId, TICKET_STATUSES } from "../tickets/model.ts";
import type { TicketStatus } from "../tickets/model.ts";
import { QuestionError } from "./questions.ts";
import type { Questions } from "./questions.ts";

export type ChannelDeps = { tickets: Connector; questions: Questions; problems: () => string[]; log: (line: string) => void };
export type ChannelReply = { ok: true; [k: string]: unknown } | { ok: false; error: string };

// Des plafonds contre un client emballé : une ligne, un fichier de mission (la
// limite de la base Markdown), tout autre texte.
export const CHANNEL_LINE_MAX = 2_097_152;
export const CHANNEL_FILE_MAX = 1_048_576;
export const CHANNEL_TEXT_MAX = 65_536;
const LINE_TIMEOUT_MS = 10_000;

class ChannelError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Les champs de chaque verbe : obligatoires, puis facultatifs.
const VERBS: Record<string, { need: string[]; may?: string[] }> = {
  tickets: { need: [], may: ["status"] },
  ticket: { need: ["id"] },
  mission: { need: ["id"] },
  problems: { need: [] },
};

function ticketId(v: unknown): string {
  if (!isTicketId(v)) throw new ChannelError("id must be a ticket id");
  return v;
}

function parse(line: string): { op: string; req: Obj } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new ChannelError("the request is not valid JSON");
  }
  if (!isObj(json)) throw new ChannelError("the request must be a JSON object");
  const op = json.op;
  if (typeof op !== "string") throw new ChannelError("op must be a string");
  const verb = Object.hasOwn(VERBS, op) ? VERBS[op] : undefined;
  // Le nom n'est répété que s'il a la forme d'un verbe.
  const named = (s: string) => (/^[a-z][a-z-]{0,30}$/.test(s) ? s : "this");
  if (verb === undefined) throw new ChannelError(`${named(op)} is not a verb of the channel`);
  const allowed = ["op", ...verb.need, ...(verb.may ?? [])];
  const extra = Object.keys(json).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new ChannelError(`${op}: unknown field ${named(extra[0]!)}`);
  const missing = verb.need.find((k) => !(k in json));
  if (missing !== undefined) throw new ChannelError(`${op}: ${missing} is required`);
  return { op, req: json };
}

async function run(d: ChannelDeps, op: string, req: Obj): Promise<ChannelReply> {
  const { tickets } = d;
  switch (op) {
    case "tickets": {
      let status: TicketStatus[] | undefined;
      if (req.status !== undefined) {
        if (!Array.isArray(req.status) || !req.status.every((s) => (TICKET_STATUSES as readonly unknown[]).includes(s))) {
          throw new ChannelError(`tickets: status must be a list of ${TICKET_STATUSES.join(", ")}`);
        }
        status = req.status as TicketStatus[];
      }
      const r = await tickets.listTickets(status ? { status } : {});
      return {
        ok: true,
        tickets: r.tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })),
        problems: r.problems.map((p) => `${p.id}: ${p.message}`),
      };
    }
    case "ticket": {
      const id = ticketId(req.id);
      const ticket = await tickets.getTicket({ id });
      const [subtasks, requests, comments] = await Promise.all([
        tickets.listSubtasks({ ticket: id }), tickets.listRequests({ ticket: id }), tickets.listComments({ ticket: id }),
      ]);
      return { ok: true, ticket, subtasks, requests, comments: comments.comments };
    }
    case "mission":
      return { ok: true, mission: await tickets.readMission({ ticket: ticketId(req.id) }) };
    default:
      return { ok: true, problems: d.problems() };
  }
}

// Une requête, une réponse ; ne lève jamais.
export async function handleChannel(d: ChannelDeps, line: string): Promise<ChannelReply> {
  try {
    if (Buffer.byteLength(line, "utf8") > CHANNEL_LINE_MAX) throw new ChannelError(`the request is longer than ${CHANNEL_LINE_MAX} bytes`);
    const { op, req } = parse(line);
    return await run(d, op, req);
  } catch (e) {
    if (e instanceof ChannelError || e instanceof ConnectorError || e instanceof QuestionError) return { ok: false, error: e.message };
    return { ok: false, error: "internal error" };
  }
}

// Sert le canal jusqu'à l'abandon du signal. Une socket laissée par un crash
// est retirée ; la nouvelle est en 660, au groupe `group` s'il est donné. Une
// requête par connexion : la première ligne, la réponse, la fermeture ; une
// connexion muette 10 s est coupée.
export async function serveChannel(
  d: ChannelDeps, opts: { path: string; group: number | null }, signal: AbortSignal,
): Promise<void> {
  try {
    if (lstatSync(opts.path).isSocket()) unlinkSync(opts.path);
  } catch {}
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = "";
    let size = 0;
    let answered = false;
    const reply = (r: ChannelReply): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      socket.end(`${JSON.stringify(r)}\n`);
    };
    const timer = setTimeout(() => {
      answered = true;
      socket.destroy();
    }, LINE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (answered) return;
      size += Buffer.byteLength(chunk);
      if (size > CHANNEL_LINE_MAX + 1) return reply({ ok: false, error: `the request is longer than ${CHANNEL_LINE_MAX} bytes` });
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      answered = true;
      clearTimeout(timer);
      void handleChannel(d, buf.slice(0, nl)).then((r) => socket.end(`${JSON.stringify(r)}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  chmodSync(opts.path, 0o660);
  if (opts.group !== null) chownSync(opts.path, process.getuid?.() ?? -1, opts.group);
  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    unlinkSync(opts.path);
  } catch {}
}
