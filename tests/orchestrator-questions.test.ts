import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import type { Subtask, Ticket } from "../cli/lib/tickets/model.ts";
import { HostError } from "../cli/lib/orchestrator/host.ts";
import type { ExecutorStatus, HostApi, HostEvent, MissionSpec } from "../cli/lib/orchestrator/host.ts";
import {
  fileQuestions, giveVerdict, QuestionError, stepQuestions, type Questions,
} from "../cli/lib/orchestrator/questions.ts";

// Un hôte minimal : des exécuteurs, un journal, et les appels reçus.
class FakeHost implements HostApi {
  executors: ExecutorStatus[] = [];
  journal: HostEvent[] = [];
  calls: string[] = [];
  sessions: { question: number; instruction: string }[] = [];
  answers: { to: string; question: number; kind: string; text: string }[] = [];
  failAnswer = 0;
  async status() { return this.executors; }
  async assign(_to: string, _m: MissionSpec) {}
  async release(to: string) {
    this.calls.push(`release ${to}`);
    const e = this.executors.find((x) => x.name === to)!;
    e.mission = null;
    e.question = null;
  }
  async events(after: number) {
    return { events: this.journal.filter((e) => e.id > after), last: this.journal.at(-1)?.id ?? 0 };
  }
  async answer(to: string, a: { question: number; kind: "answer" | "needs-human"; text: string }) {
    if (this.failAnswer > 0) {
      this.failAnswer--;
      throw new HostError("hôte, answer : délai dépassé");
    }
    this.answers.push({ to, ...a });
    const e = this.executors.find((x) => x.name === to);
    const delivered = e?.question === a.question;
    if (delivered) e!.question = null;
    return { delivered };
  }
  async session(a: { question: number; instruction: string }) {
    this.sessions.push(a);
  }
  // L'exécuteur `name` tient `subtask` et pose la question `id`.
  ask(name: string, ticket: string, subtask: string, id: number, text: string): void {
    this.executors.push({
      name, session: "working", question: id,
      mission: { kind: "dev", ticket, subtask, repository: "web", branch: `agent/${subtask}`, base: "origin/main" },
    });
    this.journal.push({ id, kind: "ask", executor: name, ticket, subtask, text });
  }
}

async function setup(): Promise<{ tickets: Connector; picture: { ticket: Ticket; subtasks: Subtask[] }[]; qs: Questions; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-questions-"));
  const tickets = openMarkdownBase(mkdtempSync(join(tmpdir(), "forge-questions-base-")));
  const picture: { ticket: Ticket; subtasks: Subtask[] }[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await tickets.createTicket({ title: `t${i}`, description: "d", repositories: [{ name: "web", base: "main" }] });
    await tickets.setTicketStatus({ id: t.id, status: "dev" });
    const s = await tickets.createSubtask({ ticket: t.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s1" });
    await tickets.setSubtaskStatus({ id: s.id, status: "in-dev" });
    picture.push({ ticket: await tickets.getTicket({ id: t.id }), subtasks: await tickets.listSubtasks({ ticket: t.id }) });
  }
  return { tickets, picture, qs: fileQuestions(join(dir, "questions.json")), dir };
}

const TOKEN = "0123456789abcdef0123456789abcdef";

async function step(tickets: Connector, host: FakeHost, qs: Questions, picture: { ticket: Ticket; subtasks: Subtask[] }[], now = 0) {
  const problems: string[] = [];
  await stepQuestions({ tickets, host, questions: qs, now: () => now, token: () => TOKEN }, host.executors, picture, problems);
  return problems;
}

test("une question en attente ouvre une session, sans demande ; le fichier est en mode 600", async () => {
  const { tickets, picture, qs, dir } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  assert.deepEqual(await step(tickets, host, qs, picture), []);
  assert.equal(host.sessions.length, 1);
  assert.ok(host.sessions[0].instruction.startsWith("[forge] question 7 on T-1.1 (ticket T-1)"));
  assert.ok(host.sessions[0].instruction.includes("Which limit?"));
  assert.deepEqual(await tickets.listRequests({ ticket: "T-1" }), []);
  assert.equal(statSync(join(dir, "questions.json")).mode & 0o777, 0o600);
  // Le tour suivant n'en ouvre pas une seconde.
  await step(tickets, host, qs, picture);
  assert.equal(host.sessions.length, 1);
});

test("giveVerdict : un jeton inconnu est refusé, une question réglée aussi", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  assert.throws(() => giveVerdict(qs, "f".repeat(32), { kind: "answer", text: "x", recommended: null }), QuestionError);
  giveVerdict(qs, TOKEN, { kind: "answer", text: "100", recommended: null });
  assert.throws(() => giveVerdict(qs, TOKEN, { kind: "answer", text: "200", recommended: null }), /already settled/);
});

test("une réponse : une demande répondue, une livraison, plus d'enregistrement", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  giveVerdict(qs, TOKEN, { kind: "answer", text: "100 per page", recommended: null });
  assert.deepEqual(await step(tickets, host, qs, picture), []);
  const reqs = await tickets.listRequests({ ticket: "T-1" });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].text, "Which limit?");
  assert.equal(reqs[0].answer, "100 per page");
  assert.deepEqual(host.answers, [{ to: "agent-executor-1", question: 7, kind: "answer", text: "100 per page" }]);
  assert.deepEqual(qs.all(), []);
});

test("besoin de l'humain : la demande reste ouverte avec la réponse recommandée, l'enregistrement est gardé", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  giveVerdict(qs, TOKEN, { kind: "needs-human", text: "The spec says nothing.", recommended: "100" });
  await step(tickets, host, qs, picture, 1000);
  const [req] = await tickets.listRequests({ ticket: "T-1", open: true });
  assert.equal(req.recommended, "100");
  assert.equal(req.text, "Which limit?\n\nFrom the question session:\nThe spec says nothing.");
  assert.equal(host.answers[0].kind, "needs-human");
  assert.equal(qs.all()[0].deliveredAt, 1000);
});

test("Review Focus 1 : un answer de l'hôte qui échoue une fois ; le tour suivant livre, une seule demande", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  giveVerdict(qs, TOKEN, { kind: "answer", text: "100", recommended: null });
  host.failAnswer = 1;
  const problems = await step(tickets, host, qs, picture);
  assert.match(problems[0], /^T-1: question 7: /);
  await step(tickets, host, qs, picture);
  assert.equal(host.answers.length, 1);
  assert.equal((await tickets.listRequests({ ticket: "T-1" })).length, 1);
  assert.deepEqual(qs.all(), []);
});

test("Review Focus 2 : le fichier perdu, la question toujours dans status : une seconde session", async () => {
  const { tickets, picture, dir } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, fileQuestions(join(dir, "questions.json")), picture);
  await step(tickets, host, fileQuestions(join(dir, "other.json")), picture);
  assert.equal(host.sessions.length, 2);
});

test("une session muette depuis 16 minutes : la question devient une demande ouverte", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture, 0);
  await step(tickets, host, qs, picture, 16 * 60_000);
  const open = await tickets.listRequests({ ticket: "T-1", open: true });
  assert.equal(open.length, 1);
  assert.match(open[0].text, /no answer in 15 minutes/);
});

test("Review Focus 4 : 11 minutes après la livraison, l'exécuteur tient toujours : libéré une fois", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  giveVerdict(qs, TOKEN, { kind: "needs-human", text: "?", recommended: null });
  await step(tickets, host, qs, picture, 0);
  assert.deepEqual(await step(tickets, host, qs, picture, 5 * 60_000), []);
  const problems = await step(tickets, host, qs, picture, 11 * 60_000);
  assert.deepEqual(host.calls, ["release agent-executor-1"]);
  assert.match(problems[0], /released without its work in progress, 10 minutes after/);
  await step(tickets, host, qs, picture, 12 * 60_000);
  assert.deepEqual(host.calls, ["release agent-executor-1"]);
  assert.deepEqual(qs.all(), []);
});

test("partie : l'exécuteur ne montre plus la question, sans verdict : answer abandoned, rien dans la base", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 7, "Which limit?");
  await step(tickets, host, qs, picture);
  host.executors[0].question = null;
  await step(tickets, host, qs, picture);
  assert.deepEqual(host.answers, [{ to: "agent-executor-1", question: 7, kind: "needs-human", text: "abandoned" }]);
  assert.deepEqual(await tickets.listRequests({ ticket: "T-1" }), []);
  assert.deepEqual(qs.all(), []);
});

test("trois questions en attente : deux sessions seulement", async () => {
  const { tickets, picture, qs } = await setup();
  const host = new FakeHost();
  host.ask("agent-executor-1", "T-1", "T-1.1", 1, "q1");
  host.ask("agent-executor-2", "T-2", "T-2.1", 2, "q2");
  host.ask("agent-executor-3", "T-3", "T-3.1", 3, "q3");
  let n = 0;
  const problems: string[] = [];
  await stepQuestions({ tickets, host, questions: qs, now: () => 0, token: () => String(++n).padStart(32, "0") }, host.executors, picture, problems);
  assert.deepEqual(host.sessions.map((s) => s.question), [1, 2]);
  assert.equal(qs.all().length, 2);
});
