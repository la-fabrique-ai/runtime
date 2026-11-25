import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Connector } from "./connector.ts";
import { parseDocument } from "./header.ts";
import {
  ConnectorError,
  isCommentId,
  isSeq,
  isTicketId,
  parseComment,
  parseMission,
  parseRequest,
  parseSubtask,
  parseTicket,
} from "./model.ts";
import type { Comment, Problem, Request, Subtask, Ticket } from "./model.ts";

// Au-delà, un fichier n'est pas chargé : une base qui enfle ne doit pas
// épuiser la mémoire de la forge.
const MAX_BYTES = 1024 * 1024;

// Un entier décimal devient un nombre ; toute autre valeur reste une chaîne,
// que le parseur du modèle refuse.
const num = (v: string | undefined): number | string | undefined => (v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : v);
// Une valeur vide est `null` ; une clé absente reste `undefined` (refusée).
const orNull = (v: string | undefined): string | null | undefined => (v === "" ? null : v);

// Lit un fichier après avoir vérifié sa taille.
function readText(path: string): string {
  if (statSync(path).size > MAX_BYTES) throw new ConnectorError(`${path}: file is over 1 MiB`);
  return readFileSync(path, "utf8");
}

function readDocument(path: string): { fields: Record<string, string>; body: string } {
  return parseDocument(readText(path));
}

// `name:base, name:base` ; chaque paire se coupe au PREMIER « : » (une base
// peut valoir `stack:T-2`, un nom de dépôt ne contient jamais « : »).
function parseRepositories(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (value === "") return [];
  return value.split(", ").map((pair) => {
    const colon = pair.indexOf(":");
    return colon === -1 ? { name: pair, base: "" } : { name: pair.slice(0, colon), base: pair.slice(colon + 1) };
  });
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const idNumber = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1).split(".").pop());

const notImplemented = (): Promise<never> => Promise.reject(new ConnectorError("not implemented"));

export function openMarkdownBase(dir: string, opts: { prefix?: string; now?: () => Date } = {}): Connector {
  // Le préfixe et l'horloge servent à l'écriture (Task 4).
  void opts;
  const ticketDir = (id: string): string => {
    if (!isTicketId(id)) throw new ConnectorError(`invalid ticket id: ${JSON.stringify(id)}`);
    return join(dir, id);
  };

  // L'id lu dans l'en-tête doit être celui de l'emplacement du fichier.
  function same<T extends { id: string }>(record: T, expected: string, path: string): T {
    if (record.id !== expected) {
      throw new ConnectorError(`${path}: header id ${record.id} does not match its location (${expected})`);
    }
    return record;
  }

  function loadTicket(id: string): Ticket {
    const path = join(ticketDir(id), "ticket.md");
    if (!existsSync(path)) throw new ConnectorError(`ticket not found: ${id}`);
    const { fields, body } = readDocument(path);
    return same(parseTicket({
      id: fields.id,
      title: fields.title,
      description: body,
      status: fields.status,
      priority: num(fields.priority),
      repositories: parseRepositories(fields.repositories),
    }), id, path);
  }

  const sortKey = (t: Ticket): number => (t.priority === 0 ? 5 : t.priority);

  function numbered(folder: string, suffix: string): { n: string; path: string }[] {
    const out: { n: string; path: string }[] = [];
    for (const name of entries(folder)) {
      if (!name.endsWith(suffix)) continue;
      const n = name.slice(0, -suffix.length);
      if (isSeq(n)) out.push({ n, path: join(folder, name) });
    }
    return out.sort((a, b) => Number(a.n) - Number(b.n));
  }

  function loadSubtasks(ticket: string): Subtask[] {
    return numbered(join(ticketDir(ticket), "subtasks"), ".md")
      .map(({ n, path }) => {
        const { fields, body } = readDocument(path);
        return same(parseSubtask({
          id: fields.id,
          ticket,
          repository: fields.repository,
          position: num(fields.position),
          rank: num(fields.rank),
          status: fields.status,
          kind: fields.kind,
          fixes: orNull(fields.fixes),
          reason: orNull(fields.reason),
          branch: orNull(fields.branch),
          pr: orNull(fields.pr),
          text: body,
        }), `${ticket}.${n}`, path);
      })
      .sort((a, b) => a.rank - b.rank);
  }

  function loadRequests(ticket: string): Request[] {
    const folder = join(ticketDir(ticket), "requests");
    return numbered(folder, ".md").map(({ n, path }) => {
      const { fields, body } = readDocument(path);
      const answerPath = join(folder, `${n}.answer.md`);
      return same(parseRequest({
        id: fields.id,
        ticket,
        subtask: fields.subtask,
        text: body,
        recommended: orNull(fields.recommended),
        answer: existsSync(answerPath) ? readText(answerPath) : null,
      }), n, path);
    });
  }

  function loadComments(ticket: string): Comment[] {
    const folder = join(ticketDir(ticket), "comments");
    const out: Comment[] = [];
    for (const name of entries(folder)) {
      const id = name.slice(0, -".md".length);
      if (!name.endsWith(".md") || !isCommentId(id)) continue;
      const { fields, body } = readDocument(join(folder, name));
      out.push(
        same(
          parseComment({ id: fields.id, ticket, author: fields.author, kind: fields.kind, at: fields.at, text: body }),
          id,
          join(folder, name),
        ),
      );
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  return {
    async listTickets({ status }) {
      const tickets: Ticket[] = [];
      const problems: Problem[] = [];
      for (const name of entries(dir)) {
        if (!isTicketId(name) || !existsSync(join(dir, name, "ticket.md"))) continue;
        try {
          const t = loadTicket(name);
          if (!status || status.includes(t.status)) tickets.push(t);
        } catch (e) {
          problems.push({ id: name, message: e instanceof Error ? e.message : String(e) });
        }
      }
      tickets.sort((a, b) => sortKey(a) - sortKey(b) || idNumber(a.id) - idNumber(b.id));
      return { tickets, problems };
    },
    async getTicket({ id }) {
      return loadTicket(id);
    },
    async listSubtasks({ ticket }) {
      return loadSubtasks(ticket);
    },
    async listRequests({ ticket, open }) {
      const all = loadRequests(ticket);
      return open ? all.filter((r) => r.answer === null) : all;
    },
    async listComments({ ticket, after }) {
      const all = loadComments(ticket).filter((c) => after === undefined || c.id > after);
      return { comments: all, cursor: all.length ? all[all.length - 1].id : (after ?? null) };
    },
    async readMission({ ticket }) {
      const read = (file: string): string | null => {
        const path = join(ticketDir(ticket), `${file}.md`);
        return existsSync(path) ? readText(path) : null;
      };
      return parseMission({ spec: read("spec"), answers: read("answers"), split: read("split") });
    },
    createTicket: notImplemented,
    setTicketStatus: notImplemented,
    createSubtask: notImplemented,
    setSubtaskStatus: notImplemented,
    setSubtaskLinks: notImplemented,
    openRequest: notImplemented,
    answerRequest: notImplemented,
    addComment: notImplemented,
    writeMission: notImplemented,
  };
}
