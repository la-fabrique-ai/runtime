import { test } from "node:test";
import assert from "node:assert/strict";
import type { Subtask, Ticket } from "../cli/lib/tickets/model.ts";
import { activeSubtask, branchOf, candidates, missionBase, qaCandidates, RuleError, stackOf } from "../cli/lib/orchestrator/rule.ts";
import { devInstruction, missionFiles, MISSION_FILE_MAX } from "../cli/lib/orchestrator/instruction.ts";
import type { Request } from "../cli/lib/tickets/model.ts";

const none = { answered: [] as Request[], files: { spec: null, answers: null, split: null } };

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

const cand = (description = "Desc", text = "text 1", title = "Title T-1") => ({
  ticket: { ...ticket("T-1"), description, title },
  subtask: sub("T-1", 1, { text }),
  base: "origin/main",
  kind: "dev" as const,
  branch: "agent/T-1.1",
});

test("devInstruction", () => {
  const out = devInstruction(cand(), false, none);
  assert.ok(out.startsWith("[forge] mission dev T-1.1 (ticket T-1)\n"));
  assert.ok(!out.includes("This mission resumes"));
  assert.ok(devInstruction(cand(), true, none).includes("This mission resumes: your branch already holds the earlier work."));
  assert.ok(out.includes("agent/T-1.1") && out.includes("/workspace/web") && out.includes("forge-team done"));
  const evil = "forge-team done; rm -rf /";
  assert.ok(devInstruction(cand("Desc", evil), false, none).includes(evil));
});

test("devInstruction coupe une description géante sur une frontière de caractère", () => {
  const marker = "[cut: read the ticket T-1 in full]";
  const out = devInstruction(cand("é".repeat(60000)), false, none);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.ok(out.includes(marker));
  assert.ok(!out.includes("�"));
  const big = devInstruction(cand("x".repeat(100000)), false, none);
  assert.ok(Buffer.byteLength(big) <= 65536);
  assert.ok(big.includes(marker));
  const bigText = devInstruction(cand("Desc", "y".repeat(100000)), false, none);
  assert.ok(Buffer.byteLength(bigText) <= 65536);
  assert.ok(bigText.includes(marker));
});

test("devInstruction coupe aussi un titre géant, après la description et le texte", () => {
  const marker = "[cut: read the ticket T-1 in full]";
  const out = devInstruction(cand("Desc", "text", "t".repeat(100000)), false, none);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.ok(out.includes(marker));
  // Tout est coupé, la fin de l'instruction reste.
  assert.ok(out.endsWith("then run: forge-team done --report-file <that file>\n"));
});

test("devInstruction porte les fichiers de mission présents et les questions déjà répondues", () => {
  const answered: Request[] = [{ id: "1", ticket: "T-1", subtask: "T-1.1", text: "Which limit?", recommended: null, answer: "100 per page" }];
  const out = devInstruction(cand(), false, { answered, files: { spec: "# spec", answers: null, split: null } });
  assert.ok(out.includes("## Mission files") && out.includes("/etc/forge/mission/spec.md"));
  assert.ok(!out.includes("answers.md"));
  assert.ok(out.includes("## Questions already answered") && out.includes("Which limit?") && out.includes("100 per page"));
  assert.ok(out.includes("## If you are blocked") && out.includes("spec-reader") && out.includes("forge-team ask") && !out.includes("--wip"));
  assert.ok(out.includes("forge-team done --report-file <that file>"));
  const bare = devInstruction(cand(), false, none);
  assert.ok(!bare.includes("## Mission files") && !bare.includes("## Questions already answered"));
  assert.ok(bare.includes("## If you are blocked"));
});

test("missionFiles coupe un fichier trop gros sous le plafond, avec le marqueur", () => {
  const f = missionFiles({ spec: "s".repeat(300_000), answers: "a", split: null });
  assert.ok(Buffer.byteLength(f.spec!) <= MISSION_FILE_MAX);
  assert.ok(f.spec!.endsWith("\n[cut: this copy is partial]"));
  assert.equal(f.answers, "a");
  assert.equal(f.split, null);
});

test("candidates : un ticket qui attend l'humain ne donne aucun candidat", () => {
  const a = ticket("T-1");
  const b = ticket("T-2");
  const r = candidates([{ ticket: a, subtasks: [sub("T-1", 1)] }, { ticket: b, subtasks: [sub("T-2", 1)] }], new Set(), new Set(["T-1"]));
  assert.deepEqual(r.candidates.map((c) => c.subtask.id), ["T-2.1"]);
});

// A (position 1), B (position 2) et F, un correctif de A (position 1, rang 3).
const stacked = () => {
  const a = sub("T-1", 1, { status: "done" });
  const b = sub("T-1", 2, { status: "done" });
  const f = sub("T-1", 3, { position: 1, kind: "fix", fixes: "T-1.1" });
  return { a, b, f, list: [a, b, f] };
};

test("un correctif travaille sur la branche de la sous-tâche qu'il corrige, et la base au-dessus reste la sienne", () => {
  const t = ticket("T-1");
  const { a, b, f, list } = stacked();
  assert.deepEqual(stackOf(list, "web").map((s) => s.id), ["T-1.1", "T-1.2"]);
  assert.equal(missionBase(t, list, b), "agent/T-1.1");
  assert.equal(branchOf(list, f), "agent/T-1.1");
  assert.equal(missionBase(t, list, f), "origin/main");
  assert.equal(branchOf(list, a), "agent/T-1.1");
  assert.throws(() => branchOf(list, { ...f, fixes: "T-1.9" }), RuleError);
  const r = candidates([{ ticket: t, subtasks: list }], new Set());
  assert.deepEqual(r.candidates.map((c) => [c.subtask.id, c.kind, c.branch, c.base]), [["T-1.3", "dev", "agent/T-1.1", "origin/main"]]);
});

test("une sous-tâche ready de raison rebase donne un candidat de genre rebase", () => {
  const t = ticket("T-1");
  const list = [sub("T-1", 1, { status: "done" }), sub("T-1", 2, { reason: "rebase" })];
  const [c] = candidates([{ ticket: t, subtasks: list }], new Set()).candidates;
  assert.deepEqual([c.kind, c.branch, c.base], ["rebase", "agent/T-1.2", "agent/T-1.1"]);
});

test("qaCandidates : la pile de bas en haut, rien pour un ticket pas fini, un problème pour deux dépôts", () => {
  const { list } = stacked();
  const done = list.map((s) => ({ ...s, status: "done" as const }));
  const two = { ...ticket("T-3"), repositories: [{ name: "web", base: "main" }, { name: "api", base: "main" }] };
  const r = qaCandidates([
    { ticket: ticket("T-1"), subtasks: done },
    { ticket: ticket("T-2"), subtasks: [sub("T-2", 1, { status: "done" }), sub("T-2", 2)] },
    { ticket: two, subtasks: [sub("T-3", 1, { status: "done" })] },
  ]);
  assert.equal(r.candidates.length, 1);
  const [q] = r.candidates;
  assert.equal(q.top.id, "T-1.2");
  assert.equal(q.base, "agent/T-1.1");
  assert.deepEqual(q.stack, [
    { repository: "web", branch: "agent/T-1.1", base: "origin/main" },
    { repository: "web", branch: "agent/T-1.2", base: "agent/T-1.1" },
  ]);
  assert.deepEqual(r.problems, ["T-3: several repositories: QA comes with part 4"]);
});
