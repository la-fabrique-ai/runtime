import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import { HostError } from "../cli/lib/orchestrator/host.ts";
import type { ExecutorStatus, HostApi, HostEvent, MissionSpec, SessionState } from "../cli/lib/orchestrator/host.ts";
import { fileCursor, SILENT_SESSION_MS, tick } from "../cli/lib/orchestrator/tick.ts";
import type { Cursor } from "../cli/lib/orchestrator/tick.ts";
// Un tour : les tests passent leurs dépendances telles quelles.
const turn = tick;

class FakeHost implements HostApi {
  executors: ExecutorStatus[];
  events_: HostEvent[] = [];
  calls: string[] = [];
  assigned: { to: string; mission: MissionSpec }[] = [];
  failAssign: ((m: MissionSpec, to: string) => HostError | null) | null = null;
  // L'hôte enregistre la mission puis sa réponse se perd (délai dépassé).
  loseReply: ((m: MissionSpec) => boolean) | null = null;
  failStatus: Error | null = null;
  failEvents = false;
  // Le plus grand id du journal ; `null` : celui du dernier évènement.
  last: number | null = null;
  constructor(names: string[]) {
    this.executors = names.map((name) => ({ name, mission: null, session: "none" as SessionState }));
  }
  async status(): Promise<ExecutorStatus[]> {
    this.calls.push("status");
    if (this.failStatus) throw this.failStatus;
    return this.executors.map((e) => ({ ...e, mission: e.mission ? { ...e.mission } : null }));
  }
  async assign(to: string, mission: MissionSpec): Promise<void> {
    this.calls.push(`assign ${to} ${mission.subtask}`);
    const err = this.failAssign?.(mission, to);
    if (err) throw err;
    const e = this.executors.find((x) => x.name === to)!;
    if (e.mission) throw new HostError(`${to} is busy`);
    const { instruction: _i, files: _f, ...held } = mission;
    e.mission = held;
    e.session = "working";
    this.assigned.push({ to, mission });
    if (this.loseReply?.(mission)) throw new HostError("hôte, assign : délai de 30000 ms dépassé");
  }
  async release(to: string): Promise<void> {
    this.calls.push(`release ${to}`);
    const e = this.executors.find((x) => x.name === to)!;
    e.mission = null;
    e.session = "idle";
  }
  async events(after: number): Promise<{ events: HostEvent[]; last: number }> {
    this.calls.push(`events ${after}`);
    if (this.failEvents) throw new HostError("hôte, events : connexion refusée");
    return { events: this.events_.filter((e) => e.id > after), last: this.last ?? this.events_.at(-1)?.id ?? 0 };
  }
  // Ce que fait l'agent : il finit sa mission, l'hôte émet `done`.
  // L'agent rend son travail en cours avec une question pour l'humain.
  ask(name: string, text: string, recommended: string | null = null): void {
    const e = this.executors.find((x) => x.name === name)!;
    const m = e.mission!;
    e.session = "done";
    this.events_.push({ id: this.events_.length + 1, kind: "ask", executor: name, ticket: m.ticket, subtask: m.subtask, text, recommended });
  }
  finish(name: string, o: { report?: string } = {}): void {
    const e = this.executors.find((x) => x.name === name)!;
    const m = e.mission!;
    e.session = "done";
    this.events_.push({
      id: this.events_.length + 1, kind: "done", executor: name, ticket: m.ticket, subtask: m.subtask, branch: m.branch,
      report: o.report ?? null,
    });
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
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.assigned, [{ subtask: "T-2.1", executor: "a" }, { subtask: "T-1.1", executor: "b" }]);
  assert.deepEqual(host.assigned.map((x) => [x.mission.base, x.mission.branch, x.mission.repository]), [
    ["origin/main", "agent/T-2.1", "web"],
    ["origin/main", "agent/T-1.1", "web"],
  ]);
  assert.equal(await status(tickets, "T-2.1"), "in-dev");
  assert.equal(await status(tickets, "T-1.1"), "in-dev");
});

test("done : sous-tâche finie et liée, exécuteur libéré, suivante distribuée ; la dernière met le ticket en qa ; relire ne refait rien", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.finish("a"); // T-2.1
  const r = await turn({ tickets, host, cursor });
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
  const r2 = await turn({ tickets, host, cursor });
  assert.deepEqual(r2.completed, ["T-2.2", "T-1.1"]);
  assert.equal((await tickets.getTicket({ id: "T-2" })).status, "qa");
  assert.equal((await tickets.getTicket({ id: "T-1" })).status, "qa");

  // Les mêmes évènements relus : rien n'est refait, rien n'est assigné.
  cursor.value = 0;
  host.calls = [];
  const r3 = await turn({ tickets, host, cursor });
  assert.deepEqual(r3.completed, []);
  assert.deepEqual(r3.problems, []);
  assert.ok(!host.calls.some((c) => c.startsWith("release") || c.startsWith("assign")));
});

test("rattrapage : un exécuteur qui tient une sous-tâche done est libéré, un ticket tout done passe qa", async () => {
  const { tickets } = await setup();
  // Un évènement traité à moitié : la sous-tâche est done, ni release ni qa.
  await tickets.setSubtaskStatus({ id: "T-1.1", status: "done" });
  const host = new FakeHost(["a", "b"]);
  host.executors[0].mission = { kind: "dev", ticket: "T-1", subtask: "T-1.1", repository: "web", branch: "agent/T-1.1", base: "origin/main" };
  host.executors[0].session = "done";
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.ok(host.calls.includes("release a"));
  assert.equal((await tickets.getTicket({ id: "T-1" })).status, "qa");
  assert.deepEqual(r.assigned, [{ subtask: "T-2.1", executor: "a" }]);
});

test("assign accepté mais réponse perdue : la sous-tâche repasse in-dev au tour suivant, son done est compté", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  host.loseReply = (m) => m.subtask === "T-2.1";
  const cursor = memCursor();
  const r1 = await turn({ tickets, host, cursor });
  assert.match(r1.problems[0], /T-2\.1.*délai/);
  assert.equal(await status(tickets, "T-2.1"), "ready");
  host.loseReply = null;
  const r2 = await turn({ tickets, host, cursor });
  assert.deepEqual(r2.assigned, []);
  assert.equal(await status(tickets, "T-2.1"), "in-dev");
  // Même sans le tour de rattrapage, un done d'une sous-tâche ready tenue par l'émetteur compte.
  await tickets.setSubtaskStatus({ id: "T-2.1", status: "ready" });
  host.finish("a");
  const r3 = await turn({ tickets, host, cursor });
  assert.deepEqual(r3.completed, ["T-2.1"]);
  assert.equal(await status(tickets, "T-2.1"), "done");
});

test("une reprise dont l'assign échoue n'est pas retentée dans le même tour", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.executors[1].session = "lost"; // b tient T-1.1
  host.failAssign = (m) => (m.subtask === "T-1.1" ? new HostError("refus") : null);
  host.calls = [];
  const r = await turn({ tickets, host, cursor });
  assert.deepEqual(r.recovered, []);
  assert.deepEqual(r.assigned, []);
  assert.equal(host.calls.filter((c) => c.startsWith("assign")).length, 1);
  assert.equal(await status(tickets, "T-1.1"), "ready");
});

test("un exécuteur qui refuse tout assign ne bloque pas la distribution aux suivants", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  host.failAssign = (m, to) => (to === "a" ? new HostError(`refus ${m.subtask}`) : null);
  const r = await turn({ tickets, host, cursor: memCursor() });
  // a refuse T-2.1 ; T-1.1 va à b dans le même tour, a n'est pas retenté.
  assert.deepEqual(r.assigned, [{ subtask: "T-1.1", executor: "b" }]);
  assert.deepEqual(host.calls.filter((c) => c.startsWith("assign")), ["assign a T-2.1", "assign b T-1.1"]);
});

test("un seul exécuteur, un candidat prioritaire toujours refusé : le suivant part, et le refusé attend son délai sans repasser in-dev", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  host.failAssign = (m) => (m.ticket === "T-2" ? new HostError("unknown repository") : null);
  const cursor = memCursor();
  const refusals = new Map<string, number>();
  let t = 0;
  const now = () => t;
  const r1 = await turn({ tickets, host, cursor, refusals, now });
  // a refuse T-2.1, reste libre pour le tour : T-1.1 part sur a.
  assert.deepEqual(r1.assigned, [{ subtask: "T-1.1", executor: "a" }]);
  assert.equal(await status(tickets, "T-2.1"), "ready");
  // a finit T-1.1 ; au tour suivant, T-2.1 est encore dans son délai : rien ne
  // lui est tenté, elle ne repasse pas in-dev, a reste libre.
  host.finish("a");
  host.calls = [];
  t = 60_000;
  const r2 = await turn({ tickets, host, cursor, refusals, now });
  assert.deepEqual(r2.completed, ["T-1.1"]);
  assert.deepEqual(r2.assigned, []);
  assert.ok(!host.calls.some((c) => c.startsWith("assign")), host.calls.join("\n"));
  assert.equal(await status(tickets, "T-2.1"), "ready");
  // Le délai passé, elle est retentée.
  host.failAssign = null;
  t = 6 * 60_000;
  const r3 = await turn({ tickets, host, cursor, refusals, now });
  assert.deepEqual(r3.assigned, [{ subtask: "T-2.1", executor: "a" }]);
});

test("un exécuteur qui refuse deux sous-tâches dans un tour en sort ; les autres continuent", async () => {
  const { tickets } = await setup();
  const t3 = await tickets.createTicket({ title: "t3", description: "d", priority: 3, repositories: [{ name: "web", base: "main" }] });
  await tickets.setTicketStatus({ id: t3.id, status: "dev" });
  await tickets.createSubtask({ ticket: t3.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s" });
  const host = new FakeHost(["a"]);
  host.failAssign = (m) => new HostError(`refus ${m.subtask}`);
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(host.calls.filter((c) => c.startsWith("assign")), ["assign a T-2.1", "assign a T-1.1"]);
  assert.equal(await status(tickets, "T-3.1"), "ready");
});

test("une mission dont la session est blocked est signalée à chaque tour, sans reprise ni libération", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.executors[0].session = "blocked"; // a tient T-2.1
  host.calls = [];
  const r = await turn({ tickets, host, cursor });
  assert.deepEqual(r.problems, [
    "T-2: T-2.1 on a: the agent's session is blocked, waiting for an answer on its screen: read it with hc read <machine>/agent",
  ]);
  assert.deepEqual(r.recovered, []);
  assert.ok(!host.calls.some((c) => c.startsWith("release") || c.startsWith("assign")), host.calls.join("\n"));
  assert.equal(await status(tickets, "T-2.1"), "in-dev");
});

test("une mission dont la session n'annonce aucun état est signalée passé le délai, puis oubliée quand elle en annonce un", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  const cursor = memCursor();
  const silent = new Map<string, number>();
  let t = 0;
  const now = () => t;
  await turn({ tickets, host, cursor, silent, now });
  host.executors[0].session = "unknown";
  t = 1_000;
  assert.deepEqual((await turn({ tickets, host, cursor, silent, now })).problems, []);
  t = 1_000 + SILENT_SESSION_MS - 1;
  assert.deepEqual((await turn({ tickets, host, cursor, silent, now })).problems, []);
  t = 1_000 + SILENT_SESSION_MS;
  assert.deepEqual((await turn({ tickets, host, cursor, silent, now })).problems, [
    "T-2: T-2.1 on a: no session state for 2 minutes (container stopped, hc unreachable, or an agent that announces nothing): read its screen with hc read <machine>/agent",
  ]);
  assert.ok(!host.calls.some((c) => c.startsWith("release")));
  // Un état annoncé : le compte repart de zéro.
  host.executors[0].session = "working";
  await turn({ tickets, host, cursor, silent, now });
  host.executors[0].session = "unknown";
  t += 60_000;
  assert.deepEqual((await turn({ tickets, host, cursor, silent, now })).problems, []);
});

test("une session none ne déclenche pas de reprise ; un exécuteur unknown n'est ni libre ni libéré", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  host.executors[0].mission = { kind: "dev", ticket: "T-2", subtask: "T-2.1", repository: "web", branch: "agent/T-2.1", base: "origin/main" };
  host.executors[0].session = "none";
  await tickets.setSubtaskStatus({ id: "T-2.1", status: "in-dev" });
  host.executors[1].mission = { kind: "dev", ticket: "T-1", subtask: "T-1.1", repository: "web", branch: "agent/T-1.1", base: "origin/main" };
  host.executors[1].session = "unknown";
  await tickets.setSubtaskStatus({ id: "T-1.1", status: "in-dev" });
  host.executors[2].session = "unknown"; // c : sans mission, mais injoignable
  // T-3.1 est prête : seul c pourrait la prendre.
  const t3 = await tickets.createTicket({ title: "t3", description: "d", priority: 3, repositories: [{ name: "web", base: "main" }] });
  await tickets.setTicketStatus({ id: t3.id, status: "dev" });
  await tickets.createSubtask({ ticket: t3.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s" });
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.recovered, []);
  assert.deepEqual(r.assigned, []);
  assert.ok(!host.calls.some((c) => c.startsWith("release") || c.startsWith("assign")));
});

test("un journal reparti de zéro (last < curseur) : curseur remis à 0 et relu dans le même tour", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.finish("a"); // T-2.1, id 1 dans le nouveau journal
  cursor.value = 7; // le curseur de l'ancien journal
  host.calls = [];
  const r = await turn({ tickets, host, cursor });
  assert.deepEqual(host.calls.filter((c) => c.startsWith("events")), ["events 7", "events 0"]);
  assert.deepEqual(r.completed, ["T-2.1"]);
  assert.equal(cursor.value, 1);
});

test("une erreur hors domaine est préfixée internal:", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  host.failStatus = new TypeError("boum");
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.problems, ["internal: boum"]);
});

test("une sous-tâche in-dev tenue par personne revient à ready et est redistribuée", async () => {
  const { tickets } = await setup();
  await tickets.setSubtaskStatus({ id: "T-1.1", status: "in-dev" });
  const host = new FakeHost(["a", "b"]);
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-2.1", "T-1.1"]);
  assert.equal(await status(tickets, "T-1.1"), "in-dev");
});

test("une mission tenue dont la session est perdue est libérée puis relancée en reprise", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.executors[1].session = "lost"; // b tient T-1.1
  host.calls = [];
  const r = await turn({ tickets, host, cursor });
  assert.deepEqual(r.recovered, ["T-1.1"]);
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(host.calls.filter((c) => c !== "status" && !c.startsWith("events")), ["release b", "assign b T-1.1"]);
  assert.match(host.assigned.at(-1)!.mission.instruction, /This mission resumes/);
});

test("assign qui lève : la sous-tâche revient à ready, un problème, l'autre ticket est distribué", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  host.failAssign = (m) => (m.ticket === "T-2" ? new HostError("unknown repository") : null);
  const r = await turn({ tickets, host, cursor: memCursor() });
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
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /connexion refusée/);
  assert.deepEqual(host.calls, ["events 0"]);
  assert.equal(readFileSync(join(dir, "T-1", "subtasks", "1.md"), "utf8"), before);
});

test("un fichier de sous-tâche illisible dans T-1 : T-2 est distribué, une ligne de problème pour T-1", async () => {
  const { dir, tickets } = await setup();
  writeFileSync(join(dir, "T-1", "subtasks", "2.md"), "pas un en-tête\n\nx");
  const host = new FakeHost(["a", "b"]);
  const r = await turn({ tickets, host, cursor: memCursor() });
  assert.deepEqual(r.assigned.map((x) => x.subtask), ["T-2.1"]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^T-1: /);
});

test("un ticket illisible est signalé, pas ignoré en silence", async () => {
  const { dir, tickets } = await setup();
  mkdirSync(join(dir, "T-9"));
  writeFileSync(join(dir, "T-9", "ticket.md"), "status: dev\n\nx");
  const r = await turn({ tickets, host: new FakeHost(["a", "b"]), cursor: memCursor() });
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

test("fileCursor : un rename en échec ne laisse pas de temporaire", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cursor-"));
  const path = join(dir, "cursor");
  mkdirSync(path); // un dossier non vide à la place du fichier : le rename échoue
  writeFileSync(join(path, "x"), "");
  assert.throws(() => fileCursor(path).write(3));
  assert.deepEqual(readdirSync(dir), ["cursor"]);
});

test("un done avec compte rendu laisse un commentaire note de l'exécuteur sur le ticket", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.finish("a", { report: "Did x; checked y." });
  await turn({ tickets, host, cursor });
  const { comments } = await tickets.listComments({ ticket: "T-2" });
  assert.deepEqual(comments.map((c) => [c.author, c.kind, c.text]), [["a", "note", "Did x; checked y."]]);
});

test("une session perdue sur un ticket qui attend l'humain : libérée, pas relancée", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  // T-2.1 sur a ; une demande de T-2 attend l'humain.
  await tickets.openRequest({ ticket: "T-2", subtask: "T-2.1", text: "Which limit?" });
  host.executors.find((e) => e.name === "a")!.session = "lost";
  host.calls = [];
  await turn({ tickets, host, cursor });
  assert.ok(host.calls.includes("release a"));
  assert.ok(!host.calls.some((c) => c.startsWith("assign") && c.includes("T-2.")), host.calls.join(","));
  assert.equal(await status(tickets, "T-2.1"), "ready");
});

test("la mission envoyée porte le spec.md de la base dans files.spec", async () => {
  const { tickets } = await setup();
  await tickets.writeMission({ ticket: "T-2", file: "spec", text: "# The spec\n" });
  const host = new FakeHost(["a"]);
  await turn({ tickets, host, cursor: memCursor() });
  const m = host.assigned[0].mission;
  assert.equal(m.subtask, "T-2.1");
  assert.deepEqual(m.files, { spec: "# The spec\n", answers: null, split: null });
  assert.ok(m.instruction.includes("/home/aiuser/.forge/mission/spec.md"));
});

test("a plain done of the last sub-task leaves the ticket in dev while one of its requests waits for the human", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  // T-1 n'a qu'une sous-tâche, tenue par b ; une demande reste ouverte.
  const holder = host.executors.find((e) => e.mission?.subtask === "T-1.1")!;
  await tickets.openRequest({ ticket: "T-1", subtask: "T-1.1", text: "Which limit?" });
  host.finish(holder.name);
  await turn({ tickets, host, cursor });
  assert.equal(await status(tickets, "T-1.1"), "done");
  assert.equal((await tickets.getTicket({ id: "T-1" })).status, "dev");
});

// ---------------------------------------------------------------- ask : une question pour l'humain (décision 35)

test("ask: the request is opened, the emitter released, the sub-task ready; the ticket gets no mission while it waits", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.ask("a", "Which limit?", "100 per page");
  const r = await turn({ tickets, host, cursor });
  const [req] = await tickets.listRequests({ ticket: "T-2", open: true });
  assert.deepEqual([req.subtask, req.text, req.recommended], ["T-2.1", "Which limit?", "100 per page"]);
  assert.ok(host.calls.includes("release a"));
  assert.equal(await status(tickets, "T-2.1"), "ready");
  assert.ok(!r.assigned.some((x) => x.subtask.startsWith("T-2.")), JSON.stringify(r.assigned));
  assert.equal(cursor.value, 1);
  // L'humain répond : le tour suivant relance T-2.1, avec la réponse.
  await tickets.answerRequest({ ticket: "T-2", id: req.id, text: "50" });
  const next = await turn({ tickets, host, cursor });
  assert.deepEqual(next.assigned.map((x) => x.subtask), ["T-2.1"]);
  assert.ok(host.assigned.at(-1)!.mission.instruction.includes("Which limit?"));
});

test("ask: a recommended answer of several lines goes into the request's text, under Recommended answer:", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  host.ask("a", "Which limit?", "100 per page,\nor 50 on mobile");
  await turn({ tickets, host, cursor });
  const [req] = await tickets.listRequests({ ticket: "T-2" });
  assert.equal(req.recommended, null);
  assert.equal(req.text, "Which limit?\n\nRecommended answer:\n100 per page,\nor 50 on mobile");
});

test("ask read again: no second request after a crash; a sub-task another executor holds is left alone", async () => {
  const { tickets } = await setup();
  const host = new FakeHost(["a", "b", "c"]);
  const cursor = memCursor();
  await turn({ tickets, host, cursor });
  // Un crash après l'ouverture : la demande est là, a tient encore T-2.1.
  await tickets.openRequest({ ticket: "T-2", subtask: "T-2.1", text: "Which limit?" });
  host.ask("a", "Which limit?");
  await turn({ tickets, host, cursor });
  assert.equal((await tickets.listRequests({ ticket: "T-2" })).length, 1);
  assert.equal(await status(tickets, "T-2.1"), "ready");
  // Relu pendant que c tient la sous-tâche : rien ne change.
  await tickets.setSubtaskStatus({ id: "T-2.1", status: "in-dev" });
  const c = host.executors.find((e) => e.name === "c")!;
  c.mission = { kind: "dev", ticket: "T-2", subtask: "T-2.1", repository: "web", branch: "agent/T-2.1", base: "origin/main" };
  c.session = "working";
  host.calls = [];
  cursor.value = 0;
  await turn({ tickets, host, cursor });
  assert.equal(await status(tickets, "T-2.1"), "in-dev");
  assert.ok(!host.calls.some((x) => x.startsWith("release")), host.calls.join(","));
  assert.equal((await tickets.listRequests({ ticket: "T-2" })).length, 1);
});
