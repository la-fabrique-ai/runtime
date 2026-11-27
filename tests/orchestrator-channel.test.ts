import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import { handleChannel, serveChannel, type ChannelDeps } from "../cli/lib/orchestrator/channel.ts";

async function setup(): Promise<{ d: ChannelDeps; tickets: Connector; logs: string[]; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-channel-"));
  const tickets = openMarkdownBase(mkdtempSync(join(tmpdir(), "forge-channel-base-")));
  const t = await tickets.createTicket({
    title: "Paginate", description: "d", repositories: [{ name: "web", base: "main" }, { name: "api", base: "main" }],
  });
  await tickets.setTicketStatus({ id: t.id, status: "dev" });
  const s = await tickets.createSubtask({ ticket: t.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s1" });
  await tickets.openRequest({ ticket: t.id, subtask: s.id, text: "Which limit?" });
  const logs: string[] = [];
  const d: ChannelDeps = {
    tickets, problems: () => ["T-9: something"], log: (l) => void logs.push(l),
  };
  return { d, tickets, logs, dir };
}

const ask = (d: ChannelDeps, req: unknown) => handleChannel(d, JSON.stringify(req));

test("ticket returns the ticket, its sub-tasks and its requests; an unknown ticket gives the connector's message", async () => {
  const { d } = await setup();
  const r = await ask(d, { op: "ticket", id: "T-1" }) as unknown as { ok: true; ticket: { id: string }; subtasks: { id: string }[]; requests: { text: string }[] };
  assert.equal(r.ok, true);
  assert.equal(r.ticket.id, "T-1");
  assert.deepEqual(r.subtasks.map((s) => s.id), ["T-1.1"]);
  assert.deepEqual(r.requests.map((q) => q.text), ["Which limit?"]);
  const missing = await ask(d, { op: "ticket", id: "T-7" });
  assert.equal(missing.ok, false);
  assert.ok(!("error" in missing) || !missing.error.includes(tmpdir()), "no path in a refusal");
});

test("not JSON, an unknown verb, an extra field: refused", async () => {
  const { d } = await setup();
  assert.deepEqual(await handleChannel(d, "nope"), { ok: false, error: "the request is not valid JSON" });
  assert.deepEqual(await ask(d, { op: "drop-table" }), { ok: false, error: "drop-table is not a verb of the channel" });
  assert.deepEqual(await ask(d, { op: "ticket", id: "T-1", extra: 1 }), { ok: false, error: "ticket: unknown field extra" });
});

test("a connector that throws a plain Error gives internal error, never its message", async () => {
  const { d } = await setup();
  const broken = { ...d, tickets: { ...d.tickets, getTicket: async () => { throw new Error("/var/lib/secret"); } } as Connector };
  assert.deepEqual(await ask(broken, { op: "ticket", id: "T-1" }), { ok: false, error: "internal error" });
});

test("serveChannel answers a problems request, leaves the socket in mode 660, removes it on abort", async () => {
  const { d, dir } = await setup();
  const path = join(dir, "channel.sock");
  const ac = new AbortController();
  const served = serveChannel(d, { path, group: null }, ac.signal);
  while (!existsSync(path)) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(statSync(path).mode & 0o777, 0o660);
  const reply = await new Promise<string>((resolve) => {
    const s = connect(path);
    let out = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write('{"op":"problems"}\n'));
    s.on("data", (c: string) => (out += c));
    s.on("close", () => resolve(out));
  });
  assert.deepEqual(JSON.parse(reply), { ok: true, problems: ["T-9: something"] });
  ac.abort();
  await served;
  assert.ok(!existsSync(path));
});

// Un ticket neuf (todo) sur web et api.
async function fresh(tickets: Connector): Promise<string> {
  const t = await tickets.createTicket({ title: "New", description: "d", repositories: [{ name: "web", base: "main" }, { name: "api", base: "main" }] });
  return t.id;
}

test("open moves a todo ticket to spec and refuses a dev one; each write logs a line without its text", async () => {
  const { d, tickets, logs } = await setup();
  const id = await fresh(tickets);
  assert.deepEqual(await ask(d, { op: "open", id }), { ok: true });
  assert.equal((await tickets.getTicket({ id })).status, "spec");
  assert.deepEqual(await ask(d, { op: "open", id }), { ok: true });
  assert.deepEqual(await ask(d, { op: "open", id: "T-1" }), { ok: false, error: "T-1 is dev: only a todo ticket is opened" });
  await ask(d, { op: "write-mission", id, file: "spec", text: "SECRET-LOOKING TEXT" });
  assert.ok(logs.length >= 2 && logs.every((l) => !l.includes("SECRET-LOOKING")), logs.join("\n"));
});

test("Review Focus 3: write-mission on a spec ticket is read back by mission; on a dev ticket it is refused", async () => {
  const { d, tickets } = await setup();
  const id = await fresh(tickets);
  await ask(d, { op: "open", id });
  assert.deepEqual(await ask(d, { op: "write-mission", id, file: "spec", text: "# Spec\n" }), { ok: true });
  assert.deepEqual(await ask(d, { op: "mission", id }), { ok: true, mission: { spec: "# Spec\n", answers: null, split: null } });
  const r = await ask(d, { op: "write-mission", id: "T-1", file: "spec", text: "x" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /^T-1 is dev: /);
});

const STACK = [{ repository: "web", text: "one" }, { repository: "api", text: "two" }, { repository: "web", text: "three" }];

test("create-stack: ranks 1, 2, 3, positions 1, 1, 2, all ready, ticket dev", async () => {
  const { d, tickets } = await setup();
  const id = await fresh(tickets);
  await ask(d, { op: "open", id });
  const r = await ask(d, { op: "create-stack", id, subtasks: STACK });
  assert.deepEqual(r, { ok: true, subtasks: [`${id}.1`, `${id}.2`, `${id}.3`] });
  const subs = await tickets.listSubtasks({ ticket: id });
  assert.deepEqual(subs.map((s) => [s.repository, s.rank, s.position, s.status, s.kind]), [
    ["web", 1, 1, "ready", "implementation"], ["api", 2, 1, "ready", "implementation"], ["web", 3, 2, "ready", "implementation"],
  ]);
  assert.equal((await tickets.getTicket({ id })).status, "dev");
});

test("Review Focus 1: an interrupted stack resumes with the same list; another list is refused, nothing created", async () => {
  const { d, tickets } = await setup();
  const id = await fresh(tickets);
  await ask(d, { op: "open", id });
  await tickets.createSubtask({ ticket: id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "one" });
  const other = await ask(d, { op: "create-stack", id, subtasks: [{ repository: "web", text: "uno" }, ...STACK.slice(1)] });
  assert.equal(other.ok, false);
  assert.equal((await tickets.listSubtasks({ ticket: id })).length, 1);
  assert.deepEqual(await ask(d, { op: "create-stack", id, subtasks: STACK }), { ok: true, subtasks: [`${id}.1`, `${id}.2`, `${id}.3`] });
  assert.equal((await tickets.getTicket({ id })).status, "dev");
});

test("Review Focus 4: a repository the ticket does not declare is refused before anything is created", async () => {
  const { d, tickets } = await setup();
  const id = await fresh(tickets);
  await ask(d, { op: "open", id });
  const r = await ask(d, { op: "create-stack", id, subtasks: [{ repository: "web", text: "a" }, { repository: "docs", text: "b" }] });
  assert.deepEqual(r, { ok: false, error: `create-stack: ${id} does not declare the repository docs` });
  assert.deepEqual(await tickets.listSubtasks({ ticket: id }), []);
});

test("answer-request writes the answer", async () => {
  const { d, tickets } = await setup();
  assert.deepEqual(await ask(d, { op: "answer-request", id: "T-1", request: "1", text: "50" }), { ok: true });
  assert.equal((await tickets.listRequests({ ticket: "T-1" }))[0].answer, "50");
  assert.equal((await ask(d, { op: "answer-request", id: "T-1", request: "1", text: "60" })).ok, false);
});

// T-1 en revue : A (T-1.1) et B (T-1.2) finies, dans web.
async function inReview(): Promise<{ d: ChannelDeps; tickets: Connector; logs: string[] }> {
  const tickets = openMarkdownBase(mkdtempSync(join(tmpdir(), "forge-channel-review-")));
  const t = await tickets.createTicket({ title: "Paginate", description: "d", priority: 2, repositories: [{ name: "web", base: "main" }] });
  await tickets.setTicketStatus({ id: t.id, status: "dev" });
  for (const n of [1, 2]) {
    const s = await tickets.createSubtask({ ticket: t.id, repository: "web", position: n, rank: n, kind: "implementation", text: `s${n}` });
    await tickets.setSubtaskStatus({ id: s.id, status: "done" });
  }
  await tickets.setTicketStatus({ id: t.id, status: "qa" });
  await tickets.setTicketStatus({ id: t.id, status: "human-review" });
  const logs: string[] = [];
  return { d: { tickets, problems: () => [], log: (l) => void logs.push(l) }, tickets, logs };
}

test("create-fixes: a fix of A and a new sub-task, the ticket to dev; sent again after a reset, the same ids and nothing new", async () => {
  const { d, tickets, logs } = await inReview();
  const fixes = [{ fixes: "T-1.1", text: "the list is empty" }, { fixes: null, text: "add a counter" }];
  const r = await ask(d, { op: "create-fixes", id: "T-1", fixes });
  assert.deepEqual(r, { ok: true, subtasks: ["T-1.3", "T-1.4"] });
  const subs = await tickets.listSubtasks({ ticket: "T-1" });
  assert.deepEqual(subs.slice(2).map((s) => [s.kind, s.fixes, s.position]), [["fix", "T-1.1", 1], ["implementation", null, 3]]);
  assert.equal((await tickets.getTicket({ id: "T-1" })).status, "dev");
  assert.deepEqual(logs, ["create-fixes T-1: 2 sub-tasks, ticket to dev"]);
  // Remis en revue à la main : la même liste ne crée rien de plus.
  await tickets.setTicketStatus({ id: "T-1", status: "qa" });
  await tickets.setTicketStatus({ id: "T-1", status: "human-review" });
  assert.deepEqual(await ask(d, { op: "create-fixes", id: "T-1", fixes }), { ok: true, subtasks: ["T-1.3", "T-1.4"] });
  assert.equal((await tickets.listSubtasks({ ticket: "T-1" })).length, 4);
});

test("create-fixes: refused on a ticket not in review, and as a whole when one item names another ticket's sub-task", async () => {
  const { d, tickets } = await inReview();
  assert.deepEqual(await ask(d, { op: "create-fixes", id: "T-1", fixes: [{ fixes: "T-1.1", text: "x" }, { fixes: "T-9.1", text: "y" }] }),
    { ok: false, error: "create-fixes: fix 2 names T-9.1, which is not a sub-task of T-1" });
  assert.equal((await tickets.listSubtasks({ ticket: "T-1" })).length, 2);
  await tickets.setTicketStatus({ id: "T-1", status: "dev" });
  assert.deepEqual(await ask(d, { op: "create-fixes", id: "T-1", fixes: [{ fixes: null, text: "x" }] }),
    { ok: false, error: "T-1 is dev: fixes are created only for a ticket in review" });
});

test("create-ticket: a todo ticket with the repositories of its origin, its text kept verbatim", async () => {
  const { d, tickets, logs } = await inReview();
  const text = "status: dev\n\nShow a spinner while loading.";
  const r = await ask(d, { op: "create-ticket", from: "T-1", title: "Spinner", text });
  assert.deepEqual(r, { ok: true, id: "T-2" });
  const t = await tickets.getTicket({ id: "T-2" });
  assert.deepEqual([t.status, t.priority, t.title, t.description, t.repositories], ["todo", 0, "Spinner", text, [{ name: "web", base: "main" }]]);
  assert.deepEqual(logs, ["create-ticket T-2 from T-1"]);
  assert.deepEqual(await ask(d, { op: "create-ticket", from: "T-1", title: "two\nlines", text: "x" }),
    { ok: false, error: "create-ticket: title must be one line of at most 200 bytes" });
});
