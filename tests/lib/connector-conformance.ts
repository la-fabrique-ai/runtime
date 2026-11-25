// Suite de conformité d'un connecteur de tickets : le flux que l'orchestrateur
// pilotera. Chaque cas appelle `make()` pour une base neuve et vide ; tout
// futur adaptateur la réutilise telle quelle.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connector } from "../../cli/lib/tickets/connector.ts";

export function conformance(make: () => Connector): void {
  const repositories = [{ name: "api", base: "main" }];

  test("conformité : un ticket et deux sous-tâches, relus dans l'ordre", async () => {
    const c = make();
    const t = await c.createTicket({ title: "Titre", description: "Desc", priority: 2, repositories });
    const a = await c.createSubtask({ ticket: t.id, repository: "api", position: 1, rank: 1, kind: "implementation", text: "première" });
    const b = await c.createSubtask({ ticket: t.id, repository: "api", position: 2, rank: 2, kind: "implementation", text: "seconde" });
    assert.deepEqual(await c.getTicket({ id: t.id }), t);
    assert.deepEqual((await c.listSubtasks({ ticket: t.id })).map((s) => s.id), [a.id, b.id]);
    assert.equal((await c.listTickets({})).tickets.length, 1);
  });

  test("conformité : une demande ouverte, répondue, relue comme répondue", async () => {
    const c = make();
    const t = await c.createTicket({ title: "T", description: "", repositories });
    const s = await c.createSubtask({ ticket: t.id, repository: "api", position: 1, rank: 1, kind: "implementation", text: "x" });
    const r = await c.openRequest({ ticket: t.id, subtask: s.id, text: "Quelle option ?", recommended: "A" });
    assert.equal((await c.listRequests({ ticket: t.id, open: true })).length, 1);
    await c.answerRequest({ ticket: t.id, id: r.id, text: "B" });
    assert.equal((await c.listRequests({ ticket: t.id, open: true })).length, 0);
    const [back] = await c.listRequests({ ticket: t.id });
    assert.equal(back.answer, "B");
    assert.equal(back.recommended, "A");
  });

  test("conformité : deux commentaires lus au-delà d'un curseur", async () => {
    const c = make();
    const t = await c.createTicket({ title: "T", description: "", repositories });
    const first = await c.addComment({ ticket: t.id, author: "pilote", kind: "note", text: "un" });
    const second = await c.addComment({ ticket: t.id, author: "pilote", kind: "note", text: "deux" });
    const all = await c.listComments({ ticket: t.id });
    assert.deepEqual(all.comments.map((m) => m.id), [first.id, second.id]);
    const rest = await c.listComments({ ticket: t.id, after: first.id });
    assert.deepEqual(rest.comments.map((m) => m.id), [second.id]);
    assert.equal(rest.cursor, second.id);
  });

  test("conformité : les fichiers de mission s'écrivent et se relisent", async () => {
    const c = make();
    const t = await c.createTicket({ title: "T", description: "", repositories });
    assert.deepEqual(await c.readMission({ ticket: t.id }), { spec: null, answers: null, split: null });
    await c.writeMission({ ticket: t.id, file: "spec", text: "la spec" });
    const m = await c.writeMission({ ticket: t.id, file: "split", text: "le découpage" });
    assert.deepEqual(m, { spec: "la spec", answers: null, split: "le découpage" });
    assert.deepEqual(await c.readMission({ ticket: t.id }), m);
  });

  test("conformité : les statuts d'un ticket et d'une sous-tâche, retour en ready pour rebase", async () => {
    const c = make();
    const t = await c.createTicket({ title: "T", description: "", repositories });
    const s = await c.createSubtask({ ticket: t.id, repository: "api", position: 1, rank: 1, kind: "implementation", text: "x" });
    assert.equal((await c.setTicketStatus({ id: t.id, status: "dev" })).status, "dev");
    assert.equal((await c.getTicket({ id: t.id })).status, "dev");
    assert.equal((await c.setSubtaskStatus({ id: s.id, status: "in-dev" })).status, "in-dev");
    const back = await c.setSubtaskStatus({ id: s.id, status: "ready", reason: "rebase" });
    assert.equal(back.status, "ready");
    assert.equal(back.reason, "rebase");
    assert.equal((await c.listSubtasks({ ticket: t.id }))[0].reason, "rebase");
  });
}
