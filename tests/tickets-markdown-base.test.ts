import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
