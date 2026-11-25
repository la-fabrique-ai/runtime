import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import { ConnectorError } from "../cli/lib/tickets/model.ts";

function put(base: string, rel: string, text: string): void {
  const path = join(base, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function ticket(base: string, id: string, priority: number, status = "todo", repos = "api:main"): void {
  put(base, `${id}/ticket.md`, `id: ${id}\ntitle: Titre ${id}\nstatus: ${status}\npriority: ${priority}\nrepositories: ${repos}\n\nDescription ${id}\n`);
}

function fixture(): string {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  ticket(base, "T-1", 3);
  ticket(base, "T-2", 1, "dev", "api:main, web:stack:T-1");
  ticket(base, "T-3", 0);
  mkdirSync(join(base, ".git"));
  return base;
}

test("listTickets ordonne par priorité, 0 en dernier", async () => {
  const c = openMarkdownBase(fixture());
  const { tickets, problems } = await c.listTickets({});
  assert.deepEqual(tickets.map((t) => t.id), ["T-2", "T-1", "T-3"]);
  assert.deepEqual(problems, []);
  assert.deepEqual(tickets[0].repositories, [{ name: "api", base: "main" }, { name: "web", base: "stack:T-1" }]);
});

test("listTickets filtre par statut", async () => {
  const { tickets } = await openMarkdownBase(fixture()).listTickets({ status: ["dev"] });
  assert.deepEqual(tickets.map((t) => t.id), ["T-2"]);
});

test("getTicket refuse un identifiant piégé et un ticket absent", async () => {
  const c = openMarkdownBase(fixture());
  await assert.rejects(c.getTicket({ id: "../x" }), ConnectorError);
  await assert.rejects(c.getTicket({ id: "T-1/../T-2" }), ConnectorError);
  await assert.rejects(c.getTicket({ id: "T-9" }), /T-9/);
});

test("un ticket invalide ou trop gros est un problème, les autres restent listés", async () => {
  const base = fixture();
  ticket(base, "T-4", 2, "bogus");
  put(base, "T-5/ticket.md", `id: T-5\ntitle: x\nstatus: todo\npriority: 1\nrepositories: \n\n${"a".repeat(1024 * 1024 + 1)}`);
  const { tickets, problems } = await openMarkdownBase(base).listTickets({});
  assert.deepEqual(tickets.map((t) => t.id), ["T-2", "T-1", "T-3"]);
  assert.deepEqual(problems.map((p) => p.id).sort(), ["T-4", "T-5"]);
});

test("listSubtasks trie par rank", async () => {
  const base = fixture();
  const sub = (n: number, rank: number) =>
    put(base, `T-1/subtasks/${n}.md`, `id: T-1.${n}\nrepository: api\nposition: ${n}\nrank: ${rank}\nstatus: ready\nkind: implementation\nfixes:\nreason:\nbranch:\npr:\n\nTexte ${n}\n`);
  sub(1, 20);
  sub(2, 10);
  const subs = await openMarkdownBase(base).listSubtasks({ ticket: "T-1" });
  assert.deepEqual(subs.map((s) => s.id), ["T-1.2", "T-1.1"]);
  assert.equal(subs[0].fixes, null);
  assert.equal(subs[0].ticket, "T-1");
});

test("listRequests open: true omet les demandes répondues", async () => {
  const base = fixture();
  put(base, "T-1/requests/1.md", "id: 1\nsubtask: T-1.1\nrecommended:\n\nQ1\n");
  put(base, "T-1/requests/2.md", "id: 2\nsubtask: T-1.1\nrecommended: oui\n\nQ2\n");
  put(base, "T-1/requests/1.answer.md", "R1\n");
  const c = openMarkdownBase(base);
  assert.deepEqual((await c.listRequests({ ticket: "T-1", open: true })).map((r) => r.id), ["2"]);
  const all = await c.listRequests({ ticket: "T-1" });
  assert.equal(all[0].answer, "R1\n");
  assert.equal(all[1].recommended, "oui");
});

test("listComments reprend après un curseur", async () => {
  const base = fixture();
  for (const n of ["000001", "000002", "000003"]) {
    put(base, `T-1/comments/${n}.md`, `id: ${n}\nauthor: bot\nkind: note\nat: 2026-01-01T00:00:00Z\n\nc${n}\n`);
  }
  const c = openMarkdownBase(base);
  const r = await c.listComments({ ticket: "T-1", after: "000002" });
  assert.deepEqual(r.comments.map((x) => x.id), ["000003"]);
  assert.equal(r.cursor, "000003");
  assert.equal((await c.listComments({ ticket: "T-1", after: "000003" })).cursor, "000003");
  assert.equal((await c.listComments({ ticket: "T-2" })).cursor, null);
});

test("readMission renvoie null pour un fichier absent", async () => {
  const base = fixture();
  put(base, "T-1/spec.md", "La spec\n");
  const m = await openMarkdownBase(base).readMission({ ticket: "T-1" });
  assert.deepEqual(m, { spec: "La spec\n", answers: null, split: null });
});

test("un id d'en-tête qui ne correspond pas à l'emplacement est refusé", async () => {
  const base = fixture();
  put(base, "T-6/ticket.md", "id: T-2\ntitle: x\nstatus: todo\npriority: 1\nrepositories: \n\nd\n");
  put(base, "T-1/subtasks/3.md", "id: T-2.3\nrepository: api\nposition: 1\nrank: 1\nstatus: ready\nkind: implementation\nfixes:\nreason:\nbranch:\npr:\n\nt\n");
  const c = openMarkdownBase(base);
  const { tickets, problems } = await c.listTickets({});
  assert.deepEqual(tickets.map((t) => t.id), ["T-2", "T-1", "T-3"]);
  assert.deepEqual(problems.map((p) => p.id), ["T-6"]);
  await assert.rejects(c.getTicket({ id: "T-6" }), ConnectorError);
  await assert.rejects(c.listSubtasks({ ticket: "T-1" }), ConnectorError);
});

test("un fichier de mission trop gros est refusé", async () => {
  const base = fixture();
  put(base, "T-1/spec.md", "a".repeat(1024 * 1024 + 1));
  await assert.rejects(openMarkdownBase(base).readMission({ ticket: "T-1" }), /1 MiB/);
});

// --- écriture ---

const NEW = { description: "Corps", repositories: [{ name: "api", base: "main" }] };

test("createTicket puis getTicket rend le ticket en todo", async () => {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  const c = openMarkdownBase(base, { prefix: "T" });
  const t = await c.createTicket({ title: "Un titre", priority: 2, ...NEW });
  assert.equal(t.id, "T-1");
  assert.equal(t.status, "todo");
  assert.deepEqual(await c.getTicket({ id: "T-1" }), t);
  assert.equal((await c.createTicket({ title: "Deux", ...NEW })).id, "T-2");
});

test("createTicket refuse un titre piégé ou un dépôt invalide, sans créer de dossier", async () => {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  const c = openMarkdownBase(base, { prefix: "T" });
  await assert.rejects(c.createTicket({ title: "x\nstatus: done", ...NEW }), ConnectorError);
  await assert.rejects(c.createTicket({ title: "", ...NEW }), ConnectorError);
  await assert.rejects(c.createTicket({ title: "ok", description: "", repositories: [{ name: "../a", base: "main" }] }), ConnectorError);
  await assert.rejects(c.createTicket({ title: "ok", description: "", repositories: [{ name: "a", base: "-x" }] }), ConnectorError);
  assert.deepEqual(readdirSync(base), []);
});

async function withTicket(): Promise<{ base: string; c: ReturnType<typeof openMarkdownBase> }> {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  const c = openMarkdownBase(base, { prefix: "T", now: () => new Date("2026-01-02T03:04:05.000Z") });
  await c.createTicket({ title: "t", ...NEW });
  return { base, c };
}
const SUB = { ticket: "T-1", repository: "api", position: 1, rank: 1, kind: "implementation" as const, text: "Faire" };

test("dix createSubtask lancés ensemble donnent dix ids distincts", async () => {
  const { c } = await withTicket();
  const subs = await Promise.all(Array.from({ length: 10 }, () => c.createSubtask(SUB)));
  assert.deepEqual(subs.map((s) => s.id).sort(), Array.from({ length: 10 }, (_, i) => `T-1.${i + 1}`).sort());
  assert.equal((await c.listSubtasks({ ticket: "T-1" })).length, 10);
  assert.equal(subs[0].status, "ready");
});

test("createSubtask refuse un dépôt inconnu et un fixes inexistant", async () => {
  const { c } = await withTicket();
  await assert.rejects(c.createSubtask({ ...SUB, repository: "web" }), ConnectorError);
  await assert.rejects(c.createSubtask({ ...SUB, kind: "fix", fixes: "T-1.99" }), ConnectorError);
  const s = await c.createSubtask(SUB);
  const f = await c.createSubtask({ ...SUB, kind: "fix", fixes: s.id });
  assert.equal(f.fixes, s.id);
});

test("setSubtaskStatus pose puis efface la raison ; setSubtaskLinks écrit les liens", async () => {
  const { c } = await withTicket();
  const s = await c.createSubtask(SUB);
  assert.equal((await c.setSubtaskStatus({ id: s.id, status: "ready", reason: "rebase" })).reason, "rebase");
  const back = await c.setSubtaskStatus({ id: s.id, status: "in-dev" });
  assert.equal(back.reason, null);
  const l = await c.setSubtaskLinks({ id: s.id, branch: "agent/x", pr: "https://example.test/pr/1" });
  assert.equal(l.branch, "agent/x");
  assert.deepEqual((await c.listSubtasks({ ticket: "T-1" }))[0], l);
});

test("answerRequest deux fois garde la première réponse", async () => {
  const { c } = await withTicket();
  const s = await c.createSubtask(SUB);
  const r = await c.openRequest({ ticket: "T-1", subtask: s.id, text: "Question ?", recommended: "oui" });
  assert.equal(r.id, "1");
  assert.equal((await c.answerRequest({ ticket: "T-1", id: "1", text: "première" })).answer, "première");
  await assert.rejects(c.answerRequest({ ticket: "T-1", id: "1", text: "seconde" }), /already answered/);
  assert.equal((await c.listRequests({ ticket: "T-1" }))[0].answer, "première");
  await assert.rejects(c.openRequest({ ticket: "T-1", subtask: "T-1.9", text: "?" }), ConnectorError);
});

test("addComment numérote sur six chiffres et le curseur ne rend que le suivant", async () => {
  const { c } = await withTicket();
  const a = await c.addComment({ ticket: "T-1", author: "bot", kind: "note", text: "un" });
  const b = await c.addComment({ ticket: "T-1", author: "bot", kind: "note", text: "deux" });
  assert.deepEqual([a.id, b.id], ["000001", "000002"]);
  assert.equal(a.at, "2026-01-02T03:04:05.000Z");
  const { comments } = await c.listComments({ ticket: "T-1", after: "000001" });
  assert.deepEqual(comments.map((x) => x.id), ["000002"]);
});

test("writeMission écrit le fichier, relu par readMission, sans reste temporaire", async () => {
  const { base, c } = await withTicket();
  const m = await c.writeMission({ ticket: "T-1", file: "spec", text: "La spec\n" });
  assert.equal(m.spec, "La spec\n");
  assert.equal((await c.readMission({ ticket: "T-1" })).spec, "La spec\n");
  await c.writeMission({ ticket: "T-1", file: "spec", text: "v2" });
  assert.deepEqual(readdirSync(join(base, "T-1")).filter((n) => n.startsWith(".tmp-")), []);
});

test("setTicketStatus refuse un id piégé sans toucher hors de la base", async () => {
  const { base, c } = await withTicket();
  const outside = join(base, "..", "x");
  await assert.rejects(c.setTicketStatus({ id: "../x", status: "dev" }), ConnectorError);
  assert.equal(existsSync(outside), false);
  assert.equal((await c.setTicketStatus({ id: "T-1", status: "dev" })).status, "dev");
});

test("createSubtask saute un numéro déjà pris à la main (reprise sur EEXIST)", async () => {
  const { base, c } = await withTicket();
  put(base, "T-1/subtasks/2.md", "id: T-1.2\nrepository: api\nposition: 1\nrank: 1\nstatus: ready\nkind: implementation\nfixes:\nreason:\nbranch:\npr:\n\nA la main\n");
  assert.equal((await c.createSubtask(SUB)).id, "T-1.3");
});

test("setSubtaskStatus avec une raison inconnue est refusé et les sous-tâches restent listables", async () => {
  const { c } = await withTicket();
  const s = await c.createSubtask(SUB);
  await assert.rejects(c.setSubtaskStatus({ id: s.id, status: "ready", reason: "x" as "rebase" }), ConnectorError);
  assert.equal((await c.listSubtasks({ ticket: "T-1" })).length, 1);
});

test("un préfixe invalide est refusé avant tout dossier", () => {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  assert.throws(() => openMarkdownBase(base, { prefix: "../x" }), ConnectorError);
  assert.deepEqual(readdirSync(base), []);
});

test("createSubtask kind fix sans fixes, ou fixes sur une implémentation, est refusé", async () => {
  const { c } = await withTicket();
  const s = await c.createSubtask(SUB);
  await assert.rejects(c.createSubtask({ ...SUB, kind: "fix" }), ConnectorError);
  await assert.rejects(c.createSubtask({ ...SUB, fixes: s.id }), ConnectorError);
});

test("une priorité hors bornes est refusée sans dossier créé", async () => {
  const base = mkdtempSync(join(tmpdir(), "tickets-"));
  const c = openMarkdownBase(base, { prefix: "T" });
  await assert.rejects(c.createTicket({ title: "t", priority: 9 as 1, ...NEW }), ConnectorError);
  assert.deepEqual(readdirSync(base), []);
});
