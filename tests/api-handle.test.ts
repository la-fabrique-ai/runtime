import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type FakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { handleRequest, type ApiDeps } from "../cli/lib/api/handle.ts";
import { Journal } from "../cli/lib/api/journal.ts";
import { memberNamed } from "../cli/lib/team.ts";

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        lead: { capabilities: ["repo", "assign", "read-team", "ask-human"], talkTo: ["pilot", "team"] },
        dev: { count: 2, capabilities: ["repo", "publish"], talkTo: ["lead"] },
        reviewer: { capabilities: ["repo", "read-team"], talkTo: ["lead"] },
      },
    },
  },
  pilot: { capabilities: ["assign"], talkTo: ["web"] },
});
const PILOT = "agent-pilot";
const LEAD = "agent-web-lead";
const DEV1 = "agent-web-dev-1";
const DEV2 = "agent-web-dev-2";
const REV = "agent-web-reviewer";

let home: string;
let fake: FakeIncus;
let ctx: FakeContext;
let d: ApiDeps;
// L'état de session que `hc get agent` rend, par container, et les envois reçus.
let sessions: Record<string, string>;
let sends: { container: string; notice: string }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-api-handle-"));
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  fake = FakeIncus.withRuntime();
  for (const name of [PILOT, LEAD, DEV1, DEV2, REV]) {
    fake.addInstance("agent-forge", name, { status: "Running", config: name === DEV1 ? { "user.forge.base.fix-login": "origin/main" } : {} });
  }
  sessions = Object.fromEntries([PILOT, LEAD, DEV1, DEV2, REV].map((n) => [n, "idle"]));
  sends = [];
  ctx = fakeContext({ incus: fake });
  const inner = ctx.exec;
  ctx.exec = async (argv, opts) => {
    const hc = argv.indexOf("hc");
    if (hc > 0 && argv[0] === "incus") {
      const container = argv[argv.indexOf("exec") + 1];
      if (argv[hc + 1] === "get") {
        ctx.calls.push(argv);
        const state = sessions[container];
        if (state === "none") return { code: 1, stdout: "", stderr: "no such terminal" };
        // hc garde un terminal sorti, sans statut.
        return { code: 0, stdout: JSON.stringify(
          state === "exited" ? { state: "finished", exit_code: 0, status: null }
            // Un terminal gardé par hc, relancé en shell : vivant, sans statut d'agent.
            : state === "unknown" ? { argv: ["forge-agent"], state: "live", status: null }
            : state === "lost" ? { argv: ["/bin/bash"], keep: true, state: "live", status: null }
              : { argv: ["/usr/local/bin/forge-agent", "--forge-task", "t"], state: "live", status: { state } }), stderr: "" };
      }
      if (argv[hc + 1] === "kill") {
        ctx.calls.push(argv);
        sessions[container] = "exited";
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[hc + 1] === "run") sessions[container] = "idle";
      if (argv[hc + 1] === "send") {
        ctx.calls.push(argv);
        sends.push({ container, notice: argv.at(-1)! });
        return { code: 0, stdout: '{"turn":1,"status":"working","started":true}', stderr: "" };
      }
    }
    return inner(argv, opts);
  };
  d = { ctx, cfg, journal: Journal.open(join(home, "api", "journal.jsonl")), secrets: ["tok-123"], now: () => new Date("2026-11-14T10:00:00Z") };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_MIRRORS;
});

const call = (caller: string, req: Record<string, unknown>) => handleRequest(d, memberNamed(cfg, caller), JSON.stringify(req));
const keys = (name: string) => fake.instances.get("agent-forge")!.get(name)!.config;
const file = (container: string, id: number) => fake.files.get(`agent-forge/${container}/home/aiuser/.forge/messages/${id}.md`);
const joined = () => ctx.calls.map((c) => c.join(" "));

test("a developer's message: its branch is refreshed in the team mirror first, then the file, then the notice", async () => {
  const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Fini, branche agent/fix-login", body: "Détail\n\u001b[201~" });
  assert.deepEqual(reply, { ok: true, id: 1 });
  const calls = joined();
  const fetch = calls.findIndex((c) => c.includes("fetch --no-tags src +refs/heads/agent/fix-login"));
  const push = calls.findIndex((c) => c.includes("file push") && c.includes(`${LEAD}/home/aiuser/.forge/messages/1.md`));
  const send = calls.findIndex((c) => c.includes("hc send"));
  assert.ok(fetch >= 0 && push > fetch && send > push, calls.join("\n"));
  assert.equal(file(LEAD, 1)!.content, "Détail\n\u001b[201~");
  assert.deepEqual(sends, [{ container: LEAD, notice: `[forge] message 1 from ${DEV1}: Fini, branche agent/fix-login (detail: /home/aiuser/.forge/messages/1.md)` }]);
  const [e] = d.journal.entries();
  assert.deepEqual([e.id, e.caller, e.op, e.to, e.outcome, e.summary, e.text],
    [1, DEV1, "message", LEAD, "ok", "Fini, branche agent/fix-login", "Détail\n\u001b[201~"]);
});

test("two messages sent together get two ids and two files", async () => {
  const [a, b] = await Promise.all([
    call(DEV1, { op: "message", to: LEAD, summary: "Un", body: "premier" }),
    call(DEV2, { op: "message", to: LEAD, summary: "Deux", body: "second" }),
  ]);
  assert.deepEqual([a, b].map((r) => r.ok && r.id).sort(), [1, 2]);
  assert.deepEqual([file(LEAD, 1)!.content, file(LEAD, 2)!.content].sort(), ["premier", "second"]);
});

test("a developer may not message another developer: refused, no hc call, one refused entry", async () => {
  const reply = await call(DEV1, { op: "message", to: DEV2, summary: "Salut" });
  // Le refus dit à qui l'appelant peut écrire.
  const error = `${DEV1} may not talk to ${DEV2}: it may talk to ${LEAD}`;
  assert.deepEqual(reply, { ok: false, error });
  assert.equal(sends.length, 0);
  assert.deepEqual(d.journal.entries().map((e) => [e.outcome, e.error]), [["refused", error]]);
});

test("a message to a session that does not exist or has exited is refused, never queued", async () => {
  for (const state of ["exited", "none"]) {
    sessions[LEAD] = state;
    const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Salut" });
    assert.ok(!reply.ok && reply.error.startsWith(`${LEAD} has no live session`) && reply.error.includes("until it is released"), JSON.stringify(reply));
  }
  assert.equal(sends.length, 0);
});

test("assign needs the capability; the lead's assign records the task and who gave it", async () => {
  assert.deepEqual(await call(REV, { op: "assign", to: LEAD, text: "x" }), { ok: false, error: `${REV} has no assign capability` });
  const reply = await call(LEAD, { op: "assign", to: DEV2, task: "fix-login-2", text: "Corrige" });
  assert.deepEqual(reply, { ok: true, id: 2 });
  assert.equal(keys(DEV2)["user.forge.task"], "fix-login-2");
  assert.equal(keys(DEV2)["user.forge.assigned_by"], LEAD);
});

test("the notice says it is the report of an agent the recipient retains, only when the recipient assigned its task", async () => {
  const notice = async (assignedBy: string | undefined) => {
    for (const k of ["user.forge.task", "user.forge.assigned_by"]) delete keys(DEV1)[k];
    if (assignedBy !== undefined) Object.assign(keys(DEV1), { "user.forge.task": "fix-login", "user.forge.assigned_by": assignedBy });
    await call(DEV1, { op: "message", to: LEAD, summary: "Fini" });
    return sends.at(-1)!.notice;
  };
  const mention = `, on the task you assigned it (fix-login; forge-team release ${DEV1} once it is finished)`;
  assert.match(await notice(LEAD), new RegExp(`^\\[forge\\] message \\d+ from ${DEV1}${mention.replace(/[()]/g, "\\$&")}: Fini$`));
  assert.doesNotMatch(await notice(PILOT), /on the task you assigned it/, "another assigner");
  assert.doesNotMatch(await notice(undefined), /on the task you assigned it/, "no task");
  keys(DEV1)["user.forge.task"] = "(no branch)";
  keys(DEV1)["user.forge.assigned_by"] = LEAD;
  await call(DEV1, { op: "message", to: LEAD, summary: "Fini" });
  assert.match(sends.at(-1)!.notice, /\(without a branch; forge-team release/);
});

test("a forge-agent that has not announced a status yet is waited for, then the message is delivered", async () => {
  sessions[LEAD] = "unknown";
  const waits: number[] = [];
  ctx.sleep = async (ms) => { waits.push(ms); if (waits.length === 3) sessions[LEAD] = "idle"; };
  const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Salut" });
  assert.ok(reply.ok, JSON.stringify(reply));
  assert.deepEqual(waits, [1000, 1000, 1000]);
  assert.equal(sends.length, 1);
});

test("a forge-agent that announces nothing for the whole wait is refused, and nothing is typed", async () => {
  sessions[LEAD] = "unknown";
  const waits: number[] = [];
  ctx.sleep = async (ms) => { waits.push(ms); };
  const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Salut" });
  assert.ok(!reply.ok && reply.error.startsWith(`${LEAD} has no live session`), JSON.stringify(reply));
  assert.equal(waits.length, 9, "about ten looks, a second apart");
  assert.equal(sends.length, 0);
});

test("a kept terminal that is not forge-agent (a shell) is refused at once, without waiting, and nothing is typed", async () => {
  sessions[LEAD] = "lost";
  const waits: number[] = [];
  ctx.sleep = async (ms) => { waits.push(ms); };
  const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Salut" });
  assert.ok(!reply.ok && reply.error.startsWith(`${LEAD} has no live session`), JSON.stringify(reply));
  assert.deepEqual(waits, []);
  assert.equal(sends.length, 0);
});

test("a message to a member that was released is refused: release stopped its session", async () => {
  keys(DEV1)["user.forge.task"] = "fix-login";
  keys(DEV1)["user.forge.assigned_by"] = LEAD;
  assert.ok((await call(LEAD, { op: "message", to: DEV1, summary: "Un" })).ok);
  assert.ok((await call(LEAD, { op: "release", to: DEV1 })).ok);
  const reply = await call(LEAD, { op: "message", to: DEV1, summary: "Deux" });
  assert.ok(!reply.ok && reply.error.startsWith(`${DEV1} has no live session`), JSON.stringify(reply));
  assert.equal(sends.length, 1);
});

test("release is only for who assigned the task", async () => {
  keys(DEV1)["user.forge.task"] = "fix-login";
  keys(DEV1)["user.forge.assigned_by"] = "human";
  const reply = await call(LEAD, { op: "release", to: DEV1 });
  assert.equal(reply.ok, false);
  assert.match((reply as { error: string }).error, /was assigned by human: only that member or the human can release it/);
  assert.equal(keys(DEV1)["user.forge.task"], "fix-login");
});

test("ask-human needs its capability; the entry keeps summary and body", async () => {
  assert.deepEqual(await call(DEV1, { op: "ask-human", summary: "Q" }), { ok: false, error: `${DEV1} has no ask-human capability` });
  assert.deepEqual(await call(LEAD, { op: "ask-human", summary: "Quel séparateur ?", body: "Détail" }), { ok: true, id: 2 });
  const e = d.journal.entries()[1];
  assert.deepEqual([e.op, e.summary, e.text, e.outcome], ["ask-human", "Quel séparateur ?", "Détail", "ok"]);
});

test("status lists the lead's talk-to, with who each one waits on until its session works", async () => {
  keys(DEV1)["user.forge.task"] = "fix-login";
  await call(DEV1, { op: "message", to: LEAD, summary: "Fini" });
  const rows = async () => {
    const r = await call(LEAD, { op: "status" });
    assert.ok(r.ok);
    return (r as unknown as { you: unknown; team: { name: string; role: string; busy: boolean; task: string | null; session: string; waitingOn: string | null }[] }).team;
  };
  assert.deepEqual((await rows()).map((r) => r.name), [PILOT, DEV1, DEV2, REV]);
  // `you` : ce qu'un agent ne peut savoir autrement ; `publishes` : prend-il un nom de tâche.
  const status = (await call(LEAD, { op: "status" })) as unknown as { you: { name: string; role: string; capabilities: string[]; talkTo: string[] }; team: { name: string; publishes: boolean }[] };
  assert.deepEqual([status.you.name, status.you.role, status.you.talkTo], [LEAD, "lead", [PILOT, DEV1, DEV2, REV]]);
  assert.ok(status.you.capabilities.includes("assign"));
  assert.deepEqual(status.team.map((r) => r.publishes), [false, true, true, false]);
  const dev1 = (await rows()).find((r) => r.name === DEV1)!;
  assert.deepEqual([dev1.role, dev1.busy, dev1.task, dev1.session, dev1.waitingOn], ["dev", true, "fix-login", "idle", LEAD]);
  // `assignedByYou` : celui que l'appelant retient.
  const assignedBy = async (caller: string, name: string) => ((await call(caller, { op: "status" })) as unknown as { team: { name: string; assignedByYou: boolean }[] }).team.find((r) => r.name === name)!.assignedByYou;
  keys(DEV1)["user.forge.assigned_by"] = LEAD;
  assert.equal(await assignedBy(LEAD, DEV1), true);
  assert.equal(await assignedBy(LEAD, DEV2), false, "free");
  keys(DEV1)["user.forge.assigned_by"] = PILOT;
  assert.equal(await assignedBy(LEAD, DEV1), false, "assigned by someone else");
  sessions[DEV1] = "working";
  assert.equal((await rows()).find((r) => r.name === DEV1)!.waitingOn, null);
});

test("two leads' assigns of the same free developer at once: one wins, the other is told it is busy", async () => {
  const replies = await Promise.all([
    call(LEAD, { op: "assign", to: DEV2, task: "a", text: "Un" }),
    call(LEAD, { op: "assign", to: DEV2, task: "b", text: "Deux" }),
  ]);
  assert.equal(replies.filter((r) => r.ok).length, 1);
  assert.match((replies.find((r) => !r.ok) as { error: string }).error, /busy with/);
  assert.equal(joined().filter((c) => c.includes("hc run") && c.includes(DEV2)).length, 1);
});

test("an unreadable line is refused and journaled without a verb or a text", async () => {
  const reply = await handleRequest(d, memberNamed(cfg, DEV1), "not json");
  assert.equal(reply.ok, false);
  const [e] = d.journal.entries();
  assert.deepEqual([e.caller, e.op, e.outcome, e.text], [DEV1, null, "refused", null]);
});
