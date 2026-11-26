// Les questions en cours : celles qu'un développeur a posées (`ask`) et que
// l'orchestrateur n'a pas encore réglées. Une question vit dans le journal de
// l'hôte (l'évènement `ask`) et dans le `status` de l'exécuteur (`question`) ;
// le fichier des questions n'est qu'une commodité, comme un curseur : le
// perdre coûte au plus un second examen de la question, jamais une question
// perdue. Une question qui attend l'humain est une demande ouverte dans la
// base des tickets (spec §2.2) ; le texte d'une question, d'un verdict ou
// d'une réponse est copié tel quel, jamais interprété.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Connector } from "../tickets/connector.ts";
import { ConnectorError } from "../tickets/model.ts";
import type { Subtask, Ticket } from "../tickets/model.ts";
import { HostError } from "./host.ts";
import type { ExecutorStatus, HostApi } from "./host.ts";
import { questionInstruction } from "./instruction.ts";

export type Verdict = { kind: "answer" | "needs-human"; text: string; recommended: string | null };

export type QuestionRecord = {
  question: number;
  executor: string;
  ticket: string;
  subtask: string;
  text: string;
  token: string;
  startedAt: number;
  verdict: Verdict | null;
  request: string | null;
  deliveredAt: number | null;
};

export type Questions = {
  all(): QuestionRecord[];
  byToken(token: string): QuestionRecord | null;
  put(r: QuestionRecord): void;
  remove(question: number): void;
};

export class QuestionError extends Error {}

// Une session de question qui n'a rien rendu en 15 minutes : la question va à
// l'humain. Un développeur dont la question est partie à l'humain a 10 minutes
// pour rendre son travail en cours (`done --wip`), après quoi il est libéré.
// Deux sessions de question au plus en même temps dans le container de contrôle.
export const QUESTION_TIMEOUT_MS = 15 * 60_000;
export const WIP_GRACE_MS = 10 * 60_000;
export const MAX_QUESTION_SESSIONS = 2;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isVerdict(v: unknown): v is Verdict {
  return isObj(v) && (v.kind === "answer" || v.kind === "needs-human") && isStr(v.text) && (v.recommended === null || isStr(v.recommended));
}

function isRecord(v: unknown): v is QuestionRecord {
  return isObj(v) && Number.isSafeInteger(v.question) && isStr(v.executor) && isStr(v.ticket) && isStr(v.subtask) &&
    isStr(v.text) && isStr(v.token) && isNum(v.startedAt) && (v.verdict === null || isVerdict(v.verdict)) &&
    (v.request === null || isStr(v.request)) && (v.deliveredAt === null || isNum(v.deliveredAt));
}

// Un fichier JSON, mode 600, réécrit par un temporaire et un rename à chaque
// changement. Absent ou illisible : une liste vide (la question sera
// réexaminée, spec §6.4).
export function fileQuestions(path: string): Questions {
  let list: QuestionRecord[] = [];
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(v) && v.every(isRecord)) list = v;
  } catch {}
  const save = (): void => {
    const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(list) + "\n", { flag: "wx", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }
  };
  return {
    all: () => list.map((r) => ({ ...r })),
    byToken: (token) => {
      const r = list.find((x) => x.token === token);
      return r ? { ...r } : null;
    },
    put(r) {
      list = [...list.filter((x) => x.question !== r.question), { ...r }];
      save();
    },
    remove(question) {
      list = list.filter((x) => x.question !== question);
      save();
    },
  };
}

// Le verdict d'une session de question, donné par le canal local (plan 2c) :
// seulement par le jeton de sa question, et une seule fois.
export function giveVerdict(qs: Questions, token: string, v: Verdict): void {
  const r = qs.byToken(token);
  if (r === null) throw new QuestionError("unknown question token");
  if (r.verdict !== null) throw new QuestionError("this question is already settled");
  qs.put({ ...r, verdict: v });
}

type StepDeps = { tickets: Connector; host: HostApi; questions: Questions; now: () => number; token?: () => string };
type Picture = { ticket: Ticket; subtasks: Subtask[] };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const domain = (e: unknown): boolean => e instanceof ConnectorError || e instanceof HostError;

// Une étape du tour : ouvrir les sessions des nouvelles questions, régler
// celles qui ont un verdict, attendre le travail en cours de celles parties à
// l'humain, oublier celles dont l'exécuteur est parti. Une panne de la base ou
// de l'hôte sur une question devient une ligne de problème ; la question reste
// pour le tour suivant.
export async function stepQuestions(
  d: StepDeps,
  executors: ExecutorStatus[],
  picture: Picture[],
  problems: string[],
): Promise<void> {
  const { questions: qs, host } = d;
  const token = d.token ?? (() => randomBytes(16).toString("hex"));
  const exOf = (name: string) => executors.find((e) => e.name === name);
  const shows = (r: QuestionRecord) => exOf(r.executor)?.question === r.question;
  const holds = (r: QuestionRecord) => exOf(r.executor)?.mission?.subtask === r.subtask;
  const guard = async (r: { ticket: string; question: number }, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      if (!domain(e)) throw e;
      problems.push(`${r.ticket}: question ${r.question}: ${message(e)}`);
    }
  };

  // 1. Les nouvelles questions : une session neuve chacune, dans la limite.
  for (const ex of executors) {
    const q = ex.question;
    if (q === null || !ex.mission || qs.all().some((r) => r.question === q)) continue;
    if (qs.all().filter((r) => r.verdict === null).length >= MAX_QUESTION_SESSIONS) break;
    const where = { ticket: ex.mission.ticket, question: q };
    await guard(where, async () => {
      const ev = (await host.events(q - 1)).events.find((e) => e.id === q);
      if (!ev || ev.kind !== "ask") throw new HostError(`the ask event is not in the host's journal`);
      const entry = picture.find((p) => p.ticket.id === ev.ticket);
      const subtask = entry?.subtasks.find((s) => s.id === ev.subtask);
      if (!entry || !subtask) throw new ConnectorError(`${ev.subtask} is not a sub-task of a ticket in development`);
      const r: QuestionRecord = {
        question: q, executor: ex.name, ticket: ev.ticket, subtask: ev.subtask, text: ev.text, token: token(),
        startedAt: d.now(), verdict: null, request: null, deliveredAt: null,
      };
      qs.put(r);
      try {
        await host.session({ question: q, instruction: questionInstruction(r, { ticket: entry.ticket, subtask }) });
      } catch (e) {
        // Le tour suivant recommence : la question est toujours dans `status`.
        qs.remove(q);
        throw e;
      }
    });
  }

  // 2. Une session muette depuis trop longtemps : la question va à l'humain.
  for (const r of qs.all()) {
    if (r.verdict !== null || d.now() - r.startedAt <= QUESTION_TIMEOUT_MS) continue;
    qs.put({ ...r, verdict: { kind: "needs-human", text: "The question session gave no answer in 15 minutes.", recommended: null } });
  }

  for (const r of qs.all()) {
    const v = r.verdict;
    // 3. Régler : la demande dans la base d'abord, puis la livraison. Un
    // crash entre les deux reprend de l'enregistrement : jamais de seconde demande.
    if (v !== null && r.deliveredAt === null && shows(r)) {
      await guard(r, async () => {
        let request = r.request;
        if (request === null) {
          const text = v.kind === "answer" ? r.text : `${r.text}\n\nFrom the question session:\n${v.text}`;
          request = (await d.tickets.openRequest({
            ticket: r.ticket, subtask: r.subtask, text, ...(v.recommended !== null ? { recommended: v.recommended } : {}),
          })).id;
          qs.put({ ...r, request });
        }
        if (v.kind === "answer") await answerOnce(d.tickets, r.ticket, request, v.text);
        await host.answer(r.executor, { question: r.question, kind: v.kind, text: v.text });
        if (v.kind === "answer") qs.remove(r.question);
        else qs.put({ ...r, request, deliveredAt: d.now() });
      });
      continue;
    }
    // 4. Le travail en cours d'une question partie à l'humain.
    if (v?.kind === "needs-human" && r.request !== null && (r.deliveredAt !== null || holds(r))) {
      // Livrée, puis un crash avant l'enregistrement : l'exécuteur ne montre
      // plus la question mais tient encore la sous-tâche.
      const deliveredAt = r.deliveredAt ?? d.now();
      if (r.deliveredAt === null) qs.put({ ...r, deliveredAt });
      if (!holds(r)) {
        qs.remove(r.question);
      } else if (d.now() - deliveredAt > WIP_GRACE_MS) {
        await guard(r, async () => {
          await host.release(r.executor);
          problems.push(`${r.ticket}: ${r.subtask} on ${r.executor}: released without its work in progress, ` +
            `${WIP_GRACE_MS / 60_000} minutes after its question went to the human`);
          qs.remove(r.question);
        });
      }
      continue;
    }
    // 5. Partie : l'exécuteur ne montre plus la question (mission finie ou
    // libérée entre-temps). Sa session est terminée ; rien de neuf dans la base.
    if (!shows(r)) {
      await guard(r, async () => {
        // Une réponse dont la demande est déjà écrite est complétée : une
        // demande ouverte ferait attendre le ticket pour rien.
        if (v?.kind === "answer" && r.request !== null) await answerOnce(d.tickets, r.ticket, r.request, v.text);
        try {
          await host.answer(r.executor, { question: r.question, kind: "needs-human", text: "abandoned" });
        } catch (e) {
          if (!(e instanceof HostError)) throw e;
        }
        qs.remove(r.question);
      });
    }
  }
}

// Une demande déjà répondue (un crash après l'écriture) compte comme faite.
async function answerOnce(tickets: Connector, ticket: string, id: string, text: string): Promise<void> {
  try {
    await tickets.answerRequest({ ticket, id, text });
  } catch (e) {
    if (!(e instanceof ConnectorError) || !/already answered/.test(e.message)) throw e;
  }
}
