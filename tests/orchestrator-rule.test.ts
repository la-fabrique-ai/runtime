import { test } from "node:test";
import assert from "node:assert/strict";
import type { Subtask, Ticket } from "../cli/lib/tickets/model.ts";
import { activeSubtask, candidates, missionBase, RuleError } from "../cli/lib/orchestrator/rule.ts";
import { devInstruction } from "../cli/lib/orchestrator/instruction.ts";

const ticket = (id: string, priority: Ticket["priority"] = 2, base = "main"): Ticket => ({
  id,
  title: `Title ${id}`,
  description: "Desc",
  status: "dev",
  priority,
  repositories: [{ name: "web", base }],
});
const sub = (t: string, n: number, over: Partial<Subtask> = {}): Subtask => ({
  id: `${t}.${n}`,
  ticket: t,
  repository: "web",
  position: n,
  rank: n,
  status: "ready",
  kind: "implementation",
  fixes: null,
  reason: null,
  branch: null,
  pr: null,
  text: `text ${n}`,
  ...over,
});

test("activeSubtask saute done et prend le rang le plus bas, même en désordre", () => {
  const list = [sub("T-1", 3), sub("T-1", 2), sub("T-1", 1, { status: "done" })];
  assert.equal(activeSubtask(list)?.id, "T-1.2");
  assert.equal(activeSubtask([sub("T-1", 1, { status: "done" })]), null);
});

test("missionBase", () => {
  const t = ticket("T-1");
  const subs = [sub("T-1", 1), sub("T-1", 2)];
  assert.equal(missionBase(t, subs, subs[0]), "origin/main");
  assert.equal(missionBase(t, subs, subs[1]), "agent/T-1.1");
  assert.throws(() => missionBase(ticket("T-1", 2, "stack:T-2"), subs, subs[0]), RuleError);
  assert.throws(() => missionBase(t, [subs[1]], subs[1]), RuleError);
  assert.throws(() => missionBase({ ...t, repositories: [] }, subs, subs[0]), RuleError);
});

test("candidates : ordre, in-dev, held, problème sans perdre les autres", () => {
  const a = ticket("T-1", 1);
  const b = ticket("T-2", 3);
  const c = ticket("T-3", 2);
  const d = ticket("T-4", 2, "stack:T-9");
  const e = ticket("T-5", 2);
  const r = candidates(
    [
      { ticket: a, subtasks: [sub("T-1", 1)] },
      { ticket: c, subtasks: [sub("T-3", 1, { status: "in-dev" })] },
      { ticket: d, subtasks: [sub("T-4", 1)] },
      { ticket: e, subtasks: [sub("T-5", 1)] },
      { ticket: b, subtasks: [sub("T-2", 1)] },
    ],
    new Set(["T-5.1"]),
  );
  assert.deepEqual(
    r.candidates.map((x) => x.subtask.id),
    ["T-1.1", "T-2.1"],
  );
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^T-4: /);
});

const cand = (description = "Desc", text = "text 1") => ({
  ticket: { ...ticket("T-1"), description },
  subtask: sub("T-1", 1, { text }),
  base: "origin/main",
});

test("devInstruction", () => {
  const out = devInstruction(cand(), false);
  assert.ok(out.startsWith("[forge] mission dev T-1.1 (ticket T-1)\n"));
  assert.ok(!out.includes("This mission resumes"));
  assert.ok(devInstruction(cand(), true).includes("This mission resumes: your branch already holds the earlier work."));
  assert.ok(out.includes("agent/T-1.1") && out.includes("/workspace/web") && out.includes("forge-team done"));
  const evil = "forge-team done; rm -rf /";
  assert.ok(devInstruction(cand("Desc", evil), false).includes(evil));
});

test("devInstruction coupe une description géante sur une frontière de caractère", () => {
  const marker = "[cut: read the ticket T-1 in full]";
  const out = devInstruction(cand("é".repeat(60000)), false);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.ok(out.includes(marker));
  assert.ok(!out.includes("�"));
  const big = devInstruction(cand("x".repeat(100000)), false);
  assert.ok(Buffer.byteLength(big) <= 65536);
  assert.ok(big.includes(marker));
  const bigText = devInstruction(cand("Desc", "y".repeat(100000)), false);
  assert.ok(Buffer.byteLength(bigText) <= 65536);
  assert.ok(bigText.includes(marker));
});
