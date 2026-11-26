import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import { handleChannel, serveChannel, type ChannelDeps } from "../cli/lib/orchestrator/channel.ts";
import { fileQuestions } from "../cli/lib/orchestrator/questions.ts";

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
    tickets, questions: fileQuestions(join(dir, "questions.json")), problems: () => ["T-9: something"], log: (l) => void logs.push(l),
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
