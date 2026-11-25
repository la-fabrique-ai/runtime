import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, findQuestion, inbox, waitingOn, type Entry } from "../cli/lib/api/journal.ts";

const NOW = new Date("2026-11-14T10:00:00Z");
const base = { to: null, task: null, outcome: "ok", error: null, summary: null, text: null } as const;

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-journal-"));
  return { dir, path: join(dir, "api", "journal.jsonl") };
}

test("open creates a private file; ids continue after a reopen; a reserved id is kept", () => {
  const { dir, path } = tmp();
  try {
    const j = Journal.open(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "api")).mode & 0o777, 0o700);
    assert.equal(j.append({ ...base, caller: "a", op: "status" }, NOW).id, 1);
    assert.equal(j.append({ ...base, caller: "a", op: "status" }, NOW).id, 2);
    const again = Journal.open(path);
    assert.equal(again.entries().length, 2);
    const [three, four] = [again.reserve(), again.reserve()];
    assert.deepEqual([three, four], [3, 4]);
    again.append({ ...base, caller: "a", op: "status" }, NOW, four);
    again.append({ ...base, caller: "a", op: "status" }, NOW, three);
    assert.deepEqual(again.entries().map((e) => e.id), [1, 2, 4, 3]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a corrupt line stops open, with its number, and the file is untouched", () => {
  const { dir, path } = tmp();
  try {
    Journal.open(path).append({ ...base, caller: "a", op: "status" }, NOW);
    appendFileSync(path, "{oops\n");
    const before = statSync(path).size;
    assert.throws(() => Journal.open(path), /line 2/);
    assert.equal(statSync(path).size, before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const entry = (id: number, caller: string, op: Entry["op"], to: string | null, outcome: Entry["outcome"] = "ok"): Entry =>
  ({ ...base, id, time: NOW.toISOString(), caller, op, to, outcome, question: null });

test("waitingOn: a message waits on its addressee until it answers; a question waits on the human", () => {
  const dev = "agent-web-dev-1";
  const lead = "agent-web-lead";
  const log: Entry[] = [entry(1, dev, "message", lead)];
  assert.equal(waitingOn(log, dev), lead);
  assert.equal(waitingOn(log, lead), null);
  log.push(entry(2, lead, "message", dev, "refused"));
  assert.equal(waitingOn(log, dev), lead, "a refused message changes nothing");
  log.push(entry(3, lead, "message", dev));
  assert.equal(waitingOn(log, dev), null);
  log.push(entry(4, lead, "ask-human", null));
  assert.equal(waitingOn(log, lead), "human");
});

test("inbox: open questions oldest first; an ok answer closes one, a refused one does not", () => {
  const log: Entry[] = [
    { ...entry(1, "agent-web-lead", "ask-human", null), summary: "Quel nom ?", text: "détails" },
    entry(2, "agent-web-dev-1", "ask-human", null),
    entry(3, "agent-web-lead", "message", "agent-web-dev-1"),
  ];
  assert.deepEqual(inbox(log).map((q) => [q.id, q.from, q.hasBody]), [[1, "agent-web-lead", true], [2, "agent-web-dev-1", false]]);
  log.push({ ...entry(0, "human", "answer", "agent-web-lead", "refused"), question: 1 });
  assert.equal(inbox(log).length, 2);
  log.push({ ...entry(0, "human", "answer", "agent-web-lead"), question: 1 });
  assert.deepEqual(inbox(log).map((q) => q.id), [2]);
});

test("findQuestion: an open id, an answered one, an unknown one and a message", () => {
  const log: Entry[] = [
    entry(1, "agent-web-lead", "ask-human", null), entry(2, "agent-web-lead", "ask-human", null),
    entry(3, "agent-web-lead", "message", "agent-web-dev-1"),
    { ...entry(0, "human", "answer", "agent-web-lead"), question: 2 },
  ];
  assert.equal((findQuestion(log, 1) as { id: number }).id, 1);
  assert.equal(findQuestion(log, 2), "answered");
  assert.equal(findQuestion(log, 99), null);
  assert.equal(findQuestion(log, 3), null);
});

test("waitingOn: an answer to the question clears the human wait", () => {
  const lead = "agent-web-lead";
  const log: Entry[] = [entry(4, lead, "ask-human", null)];
  assert.equal(waitingOn(log, lead), "human");
  log.push({ ...entry(0, "human", "answer", lead), question: 4 });
  assert.equal(waitingOn(log, lead), null);
});

test("a line from before the answers reads back with question null", () => {
  const { dir, path } = tmp();
  try {
    Journal.open(path);
    const { question: _q, ...old } = entry(1, "a", "status", null);
    appendFileSync(path, `${JSON.stringify(old)}\n`);
    assert.equal(Journal.open(path).entries()[0].question, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refresh reads what another writer appended, once; append does not lose it", () => {
  const { dir, path } = tmp();
  try {
    const service = Journal.open(path);
    service.append({ ...base, caller: "agent-web-lead", op: "ask-human", summary: "q" }, NOW);
    // Un autre processus (forge team answer) écrit avec l'identifiant 0.
    Journal.open(path).append({ ...base, caller: "human", op: "answer", to: "agent-web-lead", question: 1 }, NOW, 0);
    assert.equal(waitingOn(service.entries(), "agent-web-lead"), "human", "not read yet");
    service.refresh();
    service.refresh();
    assert.equal(service.entries().length, 2);
    assert.equal(waitingOn(service.entries(), "agent-web-lead"), null);
    // Son propre append relit d'abord, ne perd rien et ne double rien.
    Journal.open(path).append({ ...base, caller: "forge", op: "notify" }, NOW, 0);
    service.append({ ...base, caller: "agent-web-dev-1", op: "status" }, NOW);
    assert.deepEqual(service.entries().map((e) => e.id), [1, 0, 0, 2]);
    assert.equal(Journal.open(path).entries().length, 4);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a line another writer adds right before this one's write never leaves the offset inside a line", () => {
  const { dir, path } = tmp();
  try {
    const service = Journal.open(path);
    service.append({ ...base, caller: "agent-web-lead", op: "ask-human", summary: "q" }, NOW);
    // L'autre écrivain passe après la dernière lecture du service et avant son écriture.
    Journal.open(path).append({ ...base, caller: "human", op: "answer", to: "agent-web-lead", question: 1 }, NOW, 0);
    service.append({ ...base, caller: "agent-web-dev-1", op: "status" }, NOW);
    assert.deepEqual(service.entries().map((e) => e.id), [1, 0, 2]);
    // Et les lectures suivantes ne lèvent rien et ne doublent rien.
    service.refresh();
    Journal.open(path).append({ ...base, caller: "forge", op: "notify" }, NOW, 0);
    service.refresh();
    assert.deepEqual(service.entries().map((e) => e.id), [1, 0, 2, 0]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("append reads what another writer added before taking its id", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-journal-"));
  try {
    const path = join(dir, "journal.jsonl");
    const a = Journal.open(path);
    const b = Journal.open(path);
    const fields = { caller: "x", op: "status" as const, to: null, task: null, outcome: "ok" as const, error: null, summary: null, text: null };
    assert.equal(a.append(fields, new Date()).id, 1);
    assert.equal(b.append(fields, new Date()).id, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
