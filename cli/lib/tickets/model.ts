// Le vocabulaire des tickets : types, gardes d'identifiants et parseurs.
// Les parseurs valident à la main (aucune dépendance) ce qu'un connecteur
// renvoie ; toute anomalie lève ConnectorError, message montré à l'humain.

export class ConnectorError extends Error {}

export const TICKET_STATUSES = ["todo", "spec", "dev", "qa", "human-review", "pr-review", "done", "cancelled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const SUBTASK_STATUSES = ["ready", "in-dev", "done"] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export type SubtaskKind = "implementation" | "fix";
export type CommentKind = "answer" | "qa-report" | "link" | "note";
export type MissionFile = "spec" | "answers" | "split";

// `base` : une branche, ou `stack:<id de ticket>`.
export type Repo = { name: string; base: string };

// Priorité : 1 la plus urgente, 4 la moins, 0 aucune.
export type Ticket = {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: 0 | 1 | 2 | 3 | 4;
  repositories: Repo[];
};

export type Subtask = {
  id: string;
  ticket: string;
  repository: string;
  position: number;
  rank: number;
  status: SubtaskStatus;
  kind: SubtaskKind;
  fixes: string | null;
  reason: "rebase" | null;
  branch: string | null;
  pr: string | null;
  text: string;
};

export type Request = {
  id: string;
  ticket: string;
  subtask: string;
  text: string;
  recommended: string | null;
  answer: string | null;
};

export type Comment = { id: string; ticket: string; author: string; kind: CommentKind; at: string; text: string };
export type Mission = { spec: string | null; answers: string | null; split: string | null };
export type Problem = { id: string; message: string };

const TICKET_ID = /^[A-Z][A-Z0-9]*-[1-9][0-9]{0,8}$/;
const SEQ = /^[1-9][0-9]{0,8}$/;
const COMMENT_ID = /^[0-9]{6}$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;
// Même charset que validateGitRef (cli/lib/validate.ts), sans sa forme qui lève.
const REF = /^[A-Za-z0-9._/-]+$/;

export const isTicketId = (s: unknown): s is string => typeof s === "string" && TICKET_ID.test(s);
export const isSeq = (s: unknown): s is string => typeof s === "string" && SEQ.test(s);
export const isSubtaskId = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  const dot = s.indexOf(".");
  return dot > 0 && isTicketId(s.slice(0, dot)) && isSeq(s.slice(dot + 1));
};
export const isCommentId = (s: unknown): s is string => typeof s === "string" && COMMENT_ID.test(s);
export const isRepoName = (s: unknown): s is string =>
  typeof s === "string" && REPO_NAME.test(s) && !s.startsWith("-");
// Une base contient au plus un « : », et seulement dans la forme `stack:`.
export const isBranchBase = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  if (s.startsWith("stack:")) return isTicketId(s.slice("stack:".length));
  return isGitRef(s);
};
// Un nom de branche que git accepte, sans la forme `stack:` ; ce qui ferait
// passer la valeur pour un intervalle ou une réf invalide est refusé.
export const isGitRef = (s: unknown): s is string =>
  typeof s === "string" &&
  REF.test(s) &&
  !s.startsWith("-") &&
  !s.includes("..") &&
  !s.includes("//") &&
  !s.startsWith("/") &&
  !s.endsWith("/") &&
  !s.endsWith(".") &&
  !s.endsWith(".lock");

// Lit `raw[name]` et vérifie qu'il passe `check` ; sinon « <type>: <champ> … ».
function field<T>(raw: unknown, type: string, name: string, check: (v: unknown) => v is T): T {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConnectorError(`${type}: expected an object`);
  }
  const v = (raw as Record<string, unknown>)[name];
  if (!check(v)) throw new ConnectorError(`${type}: ${name} is missing or invalid`);
  return v;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (list as readonly string[]).includes(v);
const isPriority = (v: unknown): v is 0 | 1 | 2 | 3 | 4 =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4;

function parseRepo(raw: unknown): Repo {
  return {
    name: field(raw, "repository", "name", isRepoName),
    base: field(raw, "repository", "base", isBranchBase),
  };
}

export function parseTicket(raw: unknown): Ticket {
  const repos = field(raw, "ticket", "repositories", Array.isArray) as unknown[];
  return {
    id: field(raw, "ticket", "id", isTicketId),
    title: field(raw, "ticket", "title", isString),
    description: field(raw, "ticket", "description", isString),
    status: field(raw, "ticket", "status", oneOf(TICKET_STATUSES)),
    priority: field(raw, "ticket", "priority", isPriority),
    repositories: repos.map(parseRepo),
  };
}

export function parseSubtask(raw: unknown): Subtask {
  return {
    id: field(raw, "subtask", "id", isSubtaskId),
    ticket: field(raw, "subtask", "ticket", isTicketId),
    repository: field(raw, "subtask", "repository", isRepoName),
    position: field(raw, "subtask", "position", isPosInt),
    rank: field(raw, "subtask", "rank", isPosInt),
    status: field(raw, "subtask", "status", oneOf(SUBTASK_STATUSES)),
    kind: field(raw, "subtask", "kind", oneOf(["implementation", "fix"] as const)),
    fixes: field(raw, "subtask", "fixes", (v): v is string | null => v === null || isSubtaskId(v)),
    reason: field(raw, "subtask", "reason", (v): v is "rebase" | null => v === null || v === "rebase"),
    branch: field(raw, "subtask", "branch", (v): v is string | null => v === null || isGitRef(v)),
    pr: field(raw, "subtask", "pr", isNullableString),
    text: field(raw, "subtask", "text", isString),
  };
}

export function parseRequest(raw: unknown): Request {
  return {
    id: field(raw, "request", "id", isSeq),
    ticket: field(raw, "request", "ticket", isTicketId),
    subtask: field(raw, "request", "subtask", isSubtaskId),
    text: field(raw, "request", "text", isString),
    recommended: field(raw, "request", "recommended", isNullableString),
    answer: field(raw, "request", "answer", isNullableString),
  };
}

export function parseComment(raw: unknown): Comment {
  return {
    id: field(raw, "comment", "id", isCommentId),
    ticket: field(raw, "comment", "ticket", isTicketId),
    author: field(raw, "comment", "author", isString),
    kind: field(raw, "comment", "kind", oneOf(["answer", "qa-report", "link", "note"] as const)),
    at: field(raw, "comment", "at", isString),
    text: field(raw, "comment", "text", isString),
  };
}

export function parseMission(raw: unknown): Mission {
  return {
    spec: field(raw, "mission", "spec", isNullableString),
    answers: field(raw, "mission", "answers", isNullableString),
    split: field(raw, "mission", "split", isNullableString),
  };
}

export function parseProblem(raw: unknown): Problem {
  return {
    id: field(raw, "problem", "id", isString),
    message: field(raw, "problem", "message", isString),
  };
}
