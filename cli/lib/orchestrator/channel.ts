// Le canal local de l'orchestrateur : la session du Pilote, dans le container
// de contrôle, qui tourne en aiuser, atteignent la
// base des tickets par quelques verbes étroits, sur une socket Unix que
// l'utilisateur de l'orchestrateur possède et que le groupe d'aiuser peut
// écrire (spec §6.2, §6.5). Une requête est une ligne JSON validée à la main,
// la réponse une ligne JSON, comme l'API de l'hôte.
//
// Le canal ne rend jamais un chemin, une trace ni une credential : seulement le
// message d'une ConnectorError, d'une RuleError ou de sa propre validation ;
// toute autre erreur est `internal error`. Rien ici n'écrit dans une session.
import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError, isRepoName, isSeq, isTicketId, TICKET_STATUSES } from "../tickets/model.ts";
import type { MissionFile, Ticket, TicketStatus } from "../tickets/model.ts";
import { addFix, resolveFixed } from "./fixes.ts";
import { RuleError } from "./rule.ts";

export type ChannelDeps = { tickets: Connector; problems: () => string[]; log: (line: string) => void };
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
  open: { need: ["id"] },
  "write-mission": { need: ["id", "file", "text"] },
  "create-stack": { need: ["id", "subtasks"] },
  "answer-request": { need: ["id", "request", "text"] },
  comment: { need: ["id", "text"] },
  "create-fixes": { need: ["id", "fixes"] },
  "create-ticket": { need: ["from", "title", "text"] },
};
const STACK_MAX = 50;
const FIXES_MAX = 20;
const TITLE_MAX = 200;

// Un texte non vide, sous son plafond.
function text(v: unknown, what: string, max = CHANNEL_TEXT_MAX): string {
  if (typeof v !== "string" || v.trim() === "") throw new ChannelError(`${what} must be a non-empty text`);
  if (Buffer.byteLength(v, "utf8") > max) throw new ChannelError(`${what} is longer than ${max} bytes`);
  return v;
}

async function inSpec(tickets: Connector, id: string, what: string): Promise<Ticket> {
  const t = await tickets.getTicket({ id });
  if (t.status !== "spec") throw new ChannelError(`${id} is ${t.status}: ${what} only while the ticket is in spec`);
  return t;
}

type StackItem = { repository: string; text: string };

function stackItems(v: unknown): StackItem[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > STACK_MAX) {
    throw new ChannelError(`create-stack: subtasks must be a list of 1 to ${STACK_MAX} sub-tasks`);
  }
  return v.map((x, i) => {
    if (!isObj(x) || Object.keys(x).length !== 2 || !isRepoName(x.repository)) {
      throw new ChannelError(`create-stack: sub-task ${i + 1} must be {"repository", "text"}`);
    }
    return { repository: x.repository, text: text(x.text, `create-stack: the text of sub-task ${i + 1}`) };
  });
}

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
      // `waiting` : les demandes du ticket sans réponse ; illisibles, un problème.
      const problems = r.problems.map((p) => `${p.id}: ${p.message}`);
      const waiting = await Promise.all(r.tickets.map(async (t) => {
        try {
          return (await tickets.listRequests({ ticket: t.id, open: true })).length;
        } catch (e) {
          if (!(e instanceof ConnectorError)) throw e;
          problems.push(e.message.startsWith(`${t.id}:`) ? e.message : `${t.id}: ${e.message}`);
          return 0;
        }
      }));
      return {
        ok: true,
        tickets: r.tickets.map((t, i) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, waiting: waiting[i] })),
        problems,
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
    case "open": {
      const id = ticketId(req.id);
      const t = await tickets.getTicket({ id });
      if (t.status === "todo") {
        await tickets.setTicketStatus({ id, status: "spec" });
        d.log(`open ${id}: todo to spec`);
      } else if (t.status !== "spec") {
        throw new ChannelError(`${id} is ${t.status}: only a todo ticket is opened`);
      }
      return { ok: true };
    }
    case "write-mission": {
      const id = ticketId(req.id);
      const file = req.file;
      if (file !== "spec" && file !== "answers" && file !== "split") throw new ChannelError("write-mission: file must be spec, answers or split");
      const body = text(req.text, "write-mission: text", CHANNEL_FILE_MAX);
      await inSpec(tickets, id, "the mission files are written");
      await tickets.writeMission({ ticket: id, file: file as MissionFile, text: body });
      d.log(`write-mission ${id}: ${file}, ${Buffer.byteLength(body, "utf8")} bytes`);
      return { ok: true };
    }
    case "create-stack":
      return createStack(d, ticketId(req.id), stackItems(req.subtasks));
    case "answer-request": {
      const id = ticketId(req.id);
      if (!isSeq(req.request)) throw new ChannelError("answer-request: request must be a request number");
      await tickets.answerRequest({ ticket: id, id: req.request, text: text(req.text, "answer-request: text") });
      d.log(`answer-request ${id}: request ${req.request}`);
      return { ok: true };
    }
    case "create-fixes":
      return createFixes(d, ticketId(req.id), req.fixes);
    case "create-ticket": {
      const from = await tickets.getTicket({ id: ticketId(req.from) });
      const title = req.title;
      if (typeof title !== "string" || title.trim() === "" || /[\r\n]/.test(title) || Buffer.byteLength(title, "utf8") > TITLE_MAX) {
        throw new ChannelError(`create-ticket: title must be one line of at most ${TITLE_MAX} bytes`);
      }
      // Un point non bloquant d'une revue : un ticket neuf, `todo`, que rien ne
      // fait démarrer seul ; son texte est copié tel quel.
      const t = await tickets.createTicket({
        title, description: text(req.text, "create-ticket: text"), priority: 0, repositories: from.repositories,
      });
      d.log(`create-ticket ${t.id} from ${from.id}`);
      return { ok: true, id: t.id };
    }
    case "comment": {
      const id = ticketId(req.id);
      await tickets.addComment({ ticket: id, author: "pilot", kind: "note", text: text(req.text, "comment: text") });
      d.log(`comment ${id}`);
      return { ok: true };
    }
    default:
      return { ok: true, problems: d.problems() };
  }
}

// La pile d'un ticket en `spec`, dans l'ordre de la liste (le rang) ; la
// position compte les sous-tâches du même dépôt. Une pile interrompue reprend :
// les sous-tâches déjà là doivent être le début de la liste (même dépôt, même
// texte, dans l'ordre), les autres sont créées, puis le ticket passe `dev`.
async function createStack(d: ChannelDeps, id: string, items: StackItem[]): Promise<ChannelReply> {
  const { tickets } = d;
  const ticket = await inSpec(tickets, id, "a stack is created");
  const declared = new Set(ticket.repositories.map((r) => r.name));
  const unknown = items.find((x) => !declared.has(x.repository));
  if (unknown) throw new ChannelError(`create-stack: ${id} does not declare the repository ${unknown.repository}`);
  const existing = await tickets.listSubtasks({ ticket: id });
  const prefix = existing.length <= items.length &&
    existing.every((s, i) => s.repository === items[i]!.repository && s.text === items[i]!.text && s.rank === i + 1);
  if (!prefix) throw new ChannelError(`create-stack: ${id} already has sub-tasks that are not the start of this list`);
  const ids = existing.map((s) => s.id);
  for (let i = existing.length; i < items.length; i++) {
    const { repository, text: body } = items[i]!;
    const position = items.slice(0, i + 1).filter((x) => x.repository === repository).length;
    const s = await tickets.createSubtask({ ticket: id, repository, position, rank: i + 1, kind: "implementation", text: body });
    ids.push(s.id);
  }
  await tickets.setTicketStatus({ id, status: "dev" });
  d.log(`create-stack ${id}: ${items.length} sub-tasks (${items.length - existing.length} created), ticket to dev`);
  return { ok: true, subtasks: ids };
}

// Les correctifs d'une revue, sur un ticket en `human-review` ou `pr-review` :
// toute la liste est vérifiée avant la première création ; puis un addFix par
// élément, dans l'ordre (un correctif d'une QA et d'une revue sont la même
// sous-tâche, jamais créée deux fois), puis le ticket en `dev`. Reprise avec la
// même liste, elle ne crée que ce qui manque.
async function createFixes(d: ChannelDeps, id: string, raw: unknown): Promise<ChannelReply> {
  const { tickets } = d;
  const ticket = await tickets.getTicket({ id });
  if (ticket.status !== "human-review" && ticket.status !== "pr-review") {
    throw new ChannelError(`${id} is ${ticket.status}: fixes are created only for a ticket in review`);
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > FIXES_MAX) {
    throw new ChannelError(`create-fixes: fixes must be a list of 1 to ${FIXES_MAX} fixes`);
  }
  const subtasks = await tickets.listSubtasks({ ticket: id });
  const items = raw.map((x, i) => {
    if (!isObj(x) || Object.keys(x).length !== 2 || !("fixes" in x) || !("text" in x)) {
      throw new ChannelError(`create-fixes: fix ${i + 1} must be {"fixes", "text"}`);
    }
    const fixes = x.fixes;
    if (fixes !== null && (typeof fixes !== "string" || resolveFixed(subtasks, fixes) === null)) {
      const named = typeof fixes === "string" && /^[A-Za-z0-9.-]{1,40}$/.test(fixes) ? fixes : "something";
      throw new ChannelError(`create-fixes: fix ${i + 1} names ${named}, which is not a sub-task of ${id}`);
    }
    return { fixes: fixes as string | null, text: text(x.text, `create-fixes: the text of fix ${i + 1}`) };
  });
  const ids: string[] = [];
  for (const item of items) ids.push((await addFix(tickets, ticket, item)).id);
  await tickets.setTicketStatus({ id, status: "dev" });
  d.log(`create-fixes ${id}: ${items.length} sub-tasks, ticket to dev`);
  return { ok: true, subtasks: ids };
}

// Une requête, une réponse ; ne lève jamais.
export async function handleChannel(d: ChannelDeps, line: string): Promise<ChannelReply> {
  try {
    if (Buffer.byteLength(line, "utf8") > CHANNEL_LINE_MAX) throw new ChannelError(`the request is longer than ${CHANNEL_LINE_MAX} bytes`);
    const { op, req } = parse(line);
    return await run(d, op, req);
  } catch (e) {
    if (e instanceof ChannelError || e instanceof ConnectorError || e instanceof RuleError) return { ok: false, error: e.message };
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
