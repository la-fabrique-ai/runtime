import { existsSync, mkdirSync, readdirSync, readFileSync, linkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Connector } from "./connector.ts";
import { formatDocument, parseDocument } from "./header.ts";
import {
  ConnectorError,
  isBranchBase,
  isCommentId,
  isRepoName,
  isSeq,
  isSubtaskId,
  isTicketId,
  parseComment,
  parseMission,
  parseRequest,
  parseSubtask,
  parseTicket,
} from "./model.ts";
import type { Comment, MissionFile, Problem, Repo, Request, Subtask, Ticket } from "./model.ts";

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
  } catch (e) {
    // Un dossier absent est vide ; toute autre erreur (droits, E/S) se signale.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new ConnectorError(`cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const idNumber = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1).split(".").pop());

const str = (v: number | null | string): string => (v === null ? "" : String(v));
const formatRepositories = (repos: Repo[]): string => repos.map((r) => `${r.name}:${r.base}`).join(", ");

// Réécrit un fichier par un fichier temporaire du même dossier (même
// système de fichiers, donc `renameSync` est atomique). Le nom commence par
// `.tmp-` : il ne passe aucune garde d'id, un reste de crash n'est jamais un
// enregistrement.
// Le suffixe est aléatoire : un pid se répète après un redémarrage (container).
// Le contenu est refusé au-delà de MAX_BYTES, la taille que `readText` accepte :
// un fichier plus gros serait écrit puis illisible.
function checkSize(path: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new ConnectorError(`${path}: content is over 1 MiB`);
}

function replaceFile(path: string, content: string): void {
  checkSize(path, content);
  const tmp = join(path, "..", `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content, { flag: "wx" });
  renameSync(tmp, path);
}

// Prend `path` avec un contenu déjà complet : on écrit un fichier temporaire du
// même dossier, puis `linkSync` le publie sous son nom, atomiquement (EEXIST
// si le nom est pris). Jamais de fichier vide visible, même après un crash.
// Le temporaire créé par cet appel est retiré ensuite : la règle « rien n'est
// supprimé » vaut pour les enregistrements.
function claimFile(path: string, content: string): void {
  checkSize(path, content);
  const tmp = join(path, "..", `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content, { flag: "wx" });
  try {
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
}

const isExists = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "EEXIST";

// Prend le premier numéro libre au-dessus du plus grand déjà présent ;
// `attempt(n)` crée l'objet et lève EEXIST si quelqu'un l'a pris entre-temps,
// auquel cas on recommence avec le numéro suivant.
function claimNext(highest: () => number, attempt: (n: number) => void): number {
  let n = highest() + 1;
  for (;;) {
    try {
      attempt(n);
      return n;
    } catch (e) {
      if (!isExists(e)) throw e;
      n = Math.max(n, highest()) + 1;
    }
  }
}

export function openMarkdownBase(dir: string, opts: { prefix?: string; now?: () => Date } = {}): Connector {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ConnectorError(`ticket base ${dir} is not a folder`);
  const prefix = opts.prefix ?? "T";
  if (!isTicketId(`${prefix}-1`)) throw new ConnectorError(`invalid ticket prefix: ${JSON.stringify(prefix)}`);
  const now = opts.now ?? (() => new Date());
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

  function loadRequestFile(ticket: string, n: string): Request {
    const folder = join(ticketDir(ticket), "requests");
    const path = join(folder, `${n}.md`);
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
  }

  function loadRequests(ticket: string): Request[] {
    return numbered(join(ticketDir(ticket), "requests"), ".md").map(({ n }) => loadRequestFile(ticket, n));
  }

  // Relit seulement le fichier qu'on vient d'écrire.
  function loadRequest(ticket: string, n: string): Request {
    if (!existsSync(join(ticketDir(ticket), "requests", `${n}.md`))) throw new ConnectorError(`request not found: ${n}`);
    return loadRequestFile(ticket, n);
  }

  function loadComment(ticket: string, id: string): Comment {
    const path = join(ticketDir(ticket), "comments", `${id}.md`);
    if (!existsSync(path)) throw new ConnectorError(`comment not found: ${id}`);
    const { fields, body } = readDocument(path);
    return same(
      parseComment({ id: fields.id, ticket, author: fields.author, kind: fields.kind, at: fields.at, text: body }),
      id,
      path,
    );
  }

  function loadComments(ticket: string): Comment[] {
    const folder = join(ticketDir(ticket), "comments");
    const out: Comment[] = [];
    for (const name of entries(folder)) {
      const id = name.slice(0, -".md".length);
      if (!name.endsWith(".md") || !isCommentId(id)) continue;
      out.push(loadComment(ticket, id));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  function readOrNull(ticket: string, file: string): string | null {
    const path = join(ticketDir(ticket), `${file}.md`);
    return existsSync(path) ? readText(path) : null;
  }

  function subtaskById(id: string): Subtask {
    if (!isSubtaskId(id)) throw new ConnectorError(`invalid sub-task id: ${JSON.stringify(id)}`);
    const found = loadSubtasks(id.slice(0, id.indexOf("."))).find((s) => s.id === id);
    if (!found) throw new ConnectorError(`sub-task not found: ${id}`);
    return found;
  }

  // Réécrit l'en-tête d'une sous-tâche avec les champs changés, corps intact.
  function rewriteSubtask(id: string, change: Partial<Subtask>): Subtask {
    const s = parseSubtask({ ...subtaskById(id), ...change });
    const path = join(ticketDir(s.ticket), "subtasks", `${id.slice(id.indexOf(".") + 1)}.md`);
    // On part des lignes existantes : une ligne ajoutée à la main survit, l'ordre est gardé.
    const current = readDocument(path);
    const fields: Record<string, string> = { ...current.fields };
    for (const key of Object.keys(change) as (keyof Subtask)[]) fields[key] = str(s[key] as number | string | null);
    replaceFile(path, formatDocument(fields, current.body));
    return subtaskById(id);
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
    async createTicket({ title, description, priority, repositories }) {
      if (title === "" || /[\r\n]/.test(title)) throw new ConnectorError("ticket title must be one non-empty line");
      for (const r of repositories) {
        if (!isRepoName(r.name)) throw new ConnectorError(`invalid repository name: ${JSON.stringify(r.name)}`);
        if (!isBranchBase(r.base)) throw new ConnectorError(`invalid base: ${JSON.stringify(r.base)}`);
      }
      // Le ticket complet passe par le parseur avant tout fichier.
      parseTicket({ id: `${prefix}-1`, title, description, status: "todo", priority: priority ?? 0, repositories });
      // Le document se construit (et sa taille se vérifie) avant tout dossier.
      const doc = (id: string): string =>
        formatDocument(
          { id, title, status: "todo", priority: str(priority ?? 0), repositories: formatRepositories(repositories) },
          description,
        );
      checkSize(dir, doc(`${prefix}-1`));
      const highest = (): number =>
        Math.max(0, ...entries(dir).filter((n) => n.startsWith(`${prefix}-`) && isTicketId(n)).map(idNumber));
      const n = claimNext(highest, (k) => mkdirSync(join(dir, `${prefix}-${k}`)));
      const id = `${prefix}-${n}`;
      // Le dossier appartient à son créateur : un remplacement suffit.
      replaceFile(join(dir, id, "ticket.md"), doc(id));
      return loadTicket(id);
    },
    async setTicketStatus({ id, status }) {
      const t = parseTicket({ ...loadTicket(id), status });
      const path = join(ticketDir(id), "ticket.md");
      // Les lignes d'en-tête existantes sont gardées ; seul le statut change.
      const current = readDocument(path);
      replaceFile(path, formatDocument({ ...current.fields, status: t.status }, current.body));
      return loadTicket(id);
    },
    async createSubtask({ ticket: ticketId, repository, position, rank, kind, fixes, text }) {
      const t = loadTicket(ticketId);
      if (!isRepoName(repository) || !t.repositories.some((r) => r.name === repository)) {
        throw new ConnectorError(`repository not listed by ${ticketId}: ${JSON.stringify(repository)}`);
      }
      if (fixes !== undefined && !loadSubtasks(ticketId).some((s) => s.id === fixes)) {
        throw new ConnectorError(`fixes is not a sub-task of ${ticketId}: ${JSON.stringify(fixes)}`);
      }
      if ((kind === "fix") !== (fixes !== undefined)) {
        throw new ConnectorError("a fix sub-task needs `fixes`, and only a fix sub-task may have it");
      }
      parseSubtask({
        id: `${ticketId}.1`, ticket: ticketId, repository, position, rank, status: "ready", kind,
        fixes: fixes ?? null, reason: null, branch: null, pr: null, text,
      });
      const folder = join(ticketDir(ticketId), "subtasks");
      mkdirSync(folder, { recursive: true });
      const n = claimNext(
        () => Math.max(0, ...numbered(folder, ".md").map((e) => Number(e.n))),
        (k) =>
          claimFile(
            join(folder, `${k}.md`),
            formatDocument(
              {
                id: `${ticketId}.${k}`,
                repository,
                position: str(position),
                rank: str(rank),
                status: "ready",
                kind,
                fixes: fixes ?? "",
                reason: "",
                branch: "",
                pr: "",
              },
              text,
            ),
          ),
      );
      return subtaskById(`${ticketId}.${n}`);
    },
    async setSubtaskStatus({ id, status, reason }) {
      return rewriteSubtask(id, { status, reason: reason ?? null });
    },
    async setSubtaskLinks({ id, branch, pr }) {
      // Un lien omis est conservé tel quel (il ne s'efface pas).
      const change: Partial<Subtask> = {};
      if (branch !== undefined) change.branch = branch;
      if (pr !== undefined) change.pr = pr;
      return rewriteSubtask(id, change);
    },
    async openRequest({ ticket: ticketId, subtask, text, recommended }) {
      loadTicket(ticketId);
      if (!isSubtaskId(subtask) || !loadSubtasks(ticketId).some((s) => s.id === subtask)) {
        throw new ConnectorError(`not a sub-task of ${ticketId}: ${JSON.stringify(subtask)}`);
      }
      parseRequest({ id: "1", ticket: ticketId, subtask, text, recommended: recommended ?? null, answer: null });
      const folder = join(ticketDir(ticketId), "requests");
      mkdirSync(folder, { recursive: true });
      const n = claimNext(
        () => Math.max(0, ...numbered(folder, ".md").map((e) => Number(e.n))),
        (k) =>
          claimFile(
            join(folder, `${k}.md`),
            formatDocument({ id: String(k), subtask, recommended: recommended ?? "" }, text),
          ),
      );
      return loadRequest(ticketId, String(n));
    },
    async answerRequest({ ticket: ticketId, id, text }) {
      const folder = join(ticketDir(ticketId), "requests");
      if (!isSeq(id) || !existsSync(join(folder, `${id}.md`))) throw new ConnectorError(`request not found: ${id}`);
      try {
        claimFile(join(folder, `${id}.answer.md`), text);
      } catch (e) {
        if (isExists(e)) throw new ConnectorError(`request ${id} is already answered`);
        throw e;
      }
      return loadRequest(ticketId, id);
    },
    async addComment({ ticket: ticketId, author, kind, text }) {
      loadTicket(ticketId);
      const folder = join(ticketDir(ticketId), "comments");
      mkdirSync(folder, { recursive: true });
      const at = now().toISOString();
      parseComment({ id: "000001", ticket: ticketId, author, kind, at, text });
      const pad = (k: number): string => String(k).padStart(6, "0");
      const n = claimNext(
        () => Math.max(0, ...entries(folder).map((f) => f.slice(0, -3)).filter(isCommentId).map(Number)),
        (k) =>
          claimFile(join(folder, `${pad(k)}.md`), formatDocument({ id: pad(k), author, kind, at }, text)),
      );
      return loadComment(ticketId, pad(n));
    },
    async writeMission({ ticket: ticketId, file, text }) {
      const files: MissionFile[] = ["spec", "answers", "split"];
      if (!files.includes(file)) throw new ConnectorError(`invalid mission file: ${JSON.stringify(file)}`);
      loadTicket(ticketId);
      replaceFile(join(ticketDir(ticketId), `${file}.md`), text);
      return parseMission({
        spec: readOrNull(ticketId, "spec"),
        answers: readOrNull(ticketId, "answers"),
        split: readOrNull(ticketId, "split"),
      });
    },
  };
}
