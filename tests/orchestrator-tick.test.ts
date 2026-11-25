import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import { HostError } from "../cli/lib/orchestrator/host.ts";
import type { ExecutorStatus, HostApi, HostEvent, MissionSpec, SessionState } from "../cli/lib/orchestrator/host.ts";
import { fileCursor, tick } from "../cli/lib/orchestrator/tick.ts";
import type { Cursor } from "../cli/lib/orchestrator/tick.ts";

// Un hôte en mémoire : des exécuteurs, une liste d'évènements, les appels reçus.
class FakeHost implements HostApi {
  executors: ExecutorStatus[];
  events_: HostEvent[] = [];
  calls: string[] = [];
  assigned: { to: string; mission: MissionSpec }[] = [];
  failAssign: ((m: MissionSpec) => HostError | null) | null = null;
  failEvents = false;
  constructor(names: string[]) {
    this.executors = names.map((name) => ({ name, mission: null, session: "none" as SessionState }));
  }
  async status(): Promise<ExecutorStatus[]> {
    this.calls.push("status");
    return this.executors.map((e) => ({ ...e, mission: e.mission ? { ...e.mission } : null }));
  }
  async assign(to: string, mission: MissionSpec): Promise<void> {
    this.calls.push(`assign ${to} ${mission.subtask}`);
    const err = this.failAssign?.(mission);
    if (err) throw err;
    const e = this.executors.find((x) => x.name === to)!;
    const { instruction: _i, ...held } = mission;
    e.mission = held;
    e.session = "working";
    this.assigned.push({ to, mission });
  }
  async release(to: string): Promise<void> {
    this.calls.push(`release ${to}`);
    const e = this.executors.find((x) => x.name === to)!;
    e.mission = null;
    e.session = "idle";
  }
  async events(after: number): Promise<HostEvent[]> {
    this.calls.push(`events ${after}`);
    if (this.failEvents) throw new HostError("hôte, events : connexion refusée");
    return this.events_.filter((e) => e.id > after);
  }
  // Ce que fait l'agent : il finit sa mission, l'hôte émet `done`.
  finish(name: string): void {
    const e = this.executors.find((x) => x.name === name)!;
    const m = e.mission!;
    e.session = "done";
    this.events_.push({ id: this.events_.length + 1, kind: "done", executor: name, ticket: m.ticket, subtask: m.subtask, branch: m.branch });
  }
}

const memCursor = (): Cursor & { value: number } => {
  const c = { value: 0, read: () => c.value, write: (id: number) => void (c.value = id) };
  return c;
};

// T-1 (priorité 1) : deux sous-tâches dans web ; T-2 (priorité 2) : une seule.
async function setup(): Promise<{ dir: string; tickets: Connector }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-tick-"));
  const tickets = openMarkdownBase(dir);
  for (const [priority, count] of [[2, 1], [1, 2]] as const) {
    const t = await tickets.createTicket({ title: `t${priority}`, description: "d", priority, repositories: [{ name: "web", base: "main" }] });
    await tickets.setTicketStatus({ id: t.id, status: "dev" });
    for (let n = 1; n <= count; n++) {
      await tickets.createSubtask({ ticket: t.id, repository: "web", position: n, rank: n, kind: "implementation", text: `s${n}` });
    }
  }
  return { dir, tickets };
}
// Avec setup(), T-1 est le ticket de priorité 2, T-2 celui de priorité 1.

const status = async (c: Connector, id: string): Promise<string> =>
  (await c.listSubtasks({ ticket: id.split(".")[0] })).find((s) => s.id === id)!.status;

test("deux tickets, deux exécuteurs libres : deux missions dans l'ordre de priorité", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["b", "a"]);
  const r = await tick({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.assigned, [{ subtask: "T-2.1", executor: "a" }, { subtask: "T-1.1", executor: "b" }]);
  assert.deepEqual(host.assigned.map((x) => [x.mission.base, x.mission.branch, x.mission.repository]), [
    ["origin/main", "agent/T-2.1", "web"],
    ["origin/main", "agent/T-1.1", "web"],
  ]);
  assert.equal(await status(tickets, "T-2.1"), "in-dev");
  assert.equal(await status(tickets, "T-1.1"), "in-dev");
});

test("done : sous-tâche finie et liée, exécuteur libéré, suivante distribuée ; la dernière met le ticket en qa ; relire ne change rien", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await tick({ tickets, host, cursor });
  host.finish("a"); // T-2.1
  const r = await tick({ tickets, host, cursor });
  assert.deepEqual(r.completed, ["T-2.1"]);
  const s1 = (await tickets.listSubtasks({ ticket: "T-2" }))[0];
  assert.equal(s1.status, "done");
  assert.equal(s1.branch, "agent/T-2.1");
  assert.ok(host.calls.includes("release a"));
  // La suivante va au premier exécuteur libre (a, libéré), sur la branche précédente.
  assert.deepEqual(r.assigned, [{ subtask: "T-2.2", executor: "a" }]);
  assert.equal(host.assigned.at(-1)!.mission.base, "agent/T-2.1");
  assert.equal(cursor.value, 1);

  host.finish("a"); // T-2.2
  host.finish("b"); // T-1.1
  const r2 = await tick({ tickets, host, cursor });
  assert.deepEqual(r2.completed, ["T-2.2", "T-1.1"]);
  assert.equal((await tickets.getTicket({ id: "T-2" })).status, "qa");
  assert.equal((await tickets.getTicket({ id: "T-1" })).status, "qa");

  // Les mêmes évènements relus : rien ne change, rien n'est libéré.
  host.executors[0].mission = { kind: "dev", ticket: "T-2", subtask: "T-2.2", repository: "web", branch: "agent/T-2.2", base: "agent/T-2.1" };
  host.executors[0].session = "working";
  cursor.value = 0;
  host.calls = [];
  const r3 = await tick({ tickets, host, cursor });
  assert.deepEqual(r3.completed, []);
  assert.ok(!host.calls.some((c) => c.startsWith("release")));
  assert.ok(!host.calls.some((c) => c.startsWith("assign")));
});

test("une sous-tâche in-dev tenue par personne revient à ready et est redistribuée", async () => {
  const { tickets } = await setup();
  await tickets.setSubtaskStatus({ id: "T-1.1", status: "in-dev" });
  const host = new FakeHost(["a", "b"]);
  const r = await tick({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-2.1", "T-1.1"]);
  assert.equal(await status(tickets, "T-1.1"), "in-dev");
});

test("une mission tenue dont la session est perdue est libérée puis relancée en reprise", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  const cursor = memCursor();
  await tick({ tickets, host, cursor });
  host.executors[1].session = "lost"; // b tient T-1.1
  host.calls = [];
  const r = await tick({ tickets, host, cursor });
  assert.deepEqual(r.recovered, ["T-1.1"]);
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(host.calls.filter((c) => c !== "status" && !c.startsWith("events")), ["release b", "assign b T-1.1"]);
  assert.match(host.assigned.at(-1)!.mission.instruction, /This mission resumes/);
});

test("assign qui lève : la sous-tâche revient à ready, un problème, l'autre ticket est distribué", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  host.failAssign = (m) => (m.ticket === "T-2" ? new HostError("unknown repository") : null);
  const r = await tick({ tickets, host, cursor: memCursor() });
  assert.equal(await status(tickets, "T-2.1"), "ready");
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /T-2\.1.*unknown repository/);
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-1.1"]);
});

test("events qui lève : le tour s'arrête sur un problème, sans écrire dans la base", async () => {
  const { dir, tickets } = await setup();
  const before = readFileSync(join(dir, "T-1", "subtasks", "1.md"), "utf8");
  const host = new FakeHost(["a"]);
  host.failEvents = true;
  const r = await tick({ tickets, host, cursor: memCursor() });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /connexion refusée/);
  assert.deepEqual(host.calls, ["events 0"]);
  assert.equal(readFileSync(join(dir, "T-1", "subtasks", "1.md"), "utf8"), before);
});

test("un fichier de sous-tâche illisible dans T-1 : T-2 est distribué, une ligne de problème pour T-1", async () => {
  const { dir, tickets } = await setup();
  writeFileSync(join(dir, "T-1", "subtasks", "2.md"), "pas un en-tête\n\nx");
  const host = new FakeHost(["a", "b"]);
  const r = await tick({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-2.1"]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^T-1: /);
});

test("un ticket illisible est signalé, pas ignoré en silence", async () => {
  const { dir, tickets } = await setup();
  mkdirSync(join(dir, "T-9"));
  writeFileSync(join(dir, "T-9", "ticket.md"), "status: dev\n\nx");
  const r = await tick({ tickets, host: new FakeHost(["a", "b"]), cursor: memCursor() });
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-2.1", "T-1.1"]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^T-9: /);
});

test("fileCursor : absent ou illisible vaut 0, écrit puis relu", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cursor-"));
  const path = join(dir, "cursor");
  const c = fileCursor(path);
  assert.equal(c.read(), 0);
  c.write(42);
  assert.equal(c.read(), 42);
  assert.equal(fileCursor(path).read(), 42);
  writeFileSync(path, "abc");
  assert.equal(c.read(), 0);
});
