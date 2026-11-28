import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import type { Connector } from "../cli/lib/tickets/connector.ts";
import type { Ticket } from "../cli/lib/tickets/model.ts";
import { addFix, resolveFixed } from "../cli/lib/orchestrator/fixes.ts";

// T-1 : A (T-1.1, position 1) et B (T-1.2, position 2), finies, dans web.
async function setup(): Promise<{ tickets: Connector; t: Ticket; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-fixes-"));
  const tickets = openMarkdownBase(dir);
  const t = await tickets.createTicket({ title: "t", description: "d", repositories: [{ name: "web", base: "main" }] });
  for (const n of [1, 2]) {
    const s = await tickets.createSubtask({ ticket: t.id, repository: "web", position: n, rank: n, kind: "implementation", text: `s${n}` });
    await tickets.setSubtaskStatus({ id: s.id, status: "done" });
  }
  return { tickets, t, dir };
}

test("un défaut sur A devient un correctif à la position de A, une seule fois, son fichier fini par un saut de ligne", async () => {
  const { tickets, t, dir } = await setup();
  const f = await addFix(tickets, t, { fixes: "T-1.1", text: "the list is empty" });
  assert.deepEqual([f.kind, f.fixes, f.position, f.rank, f.repository, f.status], ["fix", "T-1.1", 1, 3, "web", "ready"]);
  assert.equal(f.text.trimEnd(), "the list is empty");
  assert.ok(readFileSync(join(dir, "T-1", "subtasks", "3.md"), "utf8").endsWith("the list is empty\n"));
  const again = await addFix(tickets, t, { fixes: "T-1.1", text: "the list is empty" });
  assert.equal(again.id, f.id);
  assert.equal((await tickets.listSubtasks({ ticket: t.id })).length, 3);
});

test("un défaut sur un correctif va à la sous-tâche qu'il corrige ; transverse ou inconnu, il va en haut de la pile", async () => {
  const { tickets, t } = await setup();
  const f = await addFix(tickets, t, { fixes: "T-1.1", text: "empty" });
  const list = await tickets.listSubtasks({ ticket: t.id });
  assert.equal(resolveFixed(list, f.id)?.id, "T-1.1");
  assert.equal(resolveFixed(list, null), null);
  assert.equal(resolveFixed(list, "T-9.9"), null);
  const g = await addFix(tickets, t, { fixes: f.id, text: "still empty" });
  assert.deepEqual([g.kind, g.fixes, g.position], ["fix", "T-1.1", 1]);
  const top = await addFix(tickets, t, { fixes: null, text: "transverse" });
  assert.deepEqual([top.kind, top.fixes, top.position, top.repository], ["implementation", null, 3, "web"]);
  const unknown = await addFix(tickets, t, { fixes: "T-9.9", text: "names no sub-task" });
  assert.deepEqual([unknown.kind, unknown.fixes, unknown.position], ["implementation", null, 4]);
});

// Un correctif écrit avant que son fichier finisse par un saut de ligne est
// toujours reconnu : le même défaut relu n'en crée pas un second.
test("un correctif sans saut de ligne final est reconnu par le même défaut", async () => {
  const { tickets, t } = await setup();
  const old = await tickets.createSubtask({ ticket: t.id, repository: "web", position: 1, rank: 3, kind: "fix", fixes: "T-1.1", text: "slow" });
  const again = await addFix(tickets, t, { fixes: "T-1.1", text: "slow" });
  assert.equal(again.id, old.id);
});
