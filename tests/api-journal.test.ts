import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../cli/lib/api/journal.ts";

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

test("a line written before the ticket-driven model (a team verb) still reads, and ids go on after it", () => {
  const { dir, path } = tmp();
  try {
    Journal.open(path);
    const old = { id: 5, time: NOW.toISOString(), caller: "agent-web-lead", op: "message", to: null, task: null,
      outcome: "ok", error: null, summary: "q", text: null, question: null };
    appendFileSync(path, `${JSON.stringify(old)}\n`);
    const j = Journal.open(path);
    assert.equal(j.entries()[0].caller, "agent-web-lead");
    assert.equal(j.append({ ...base, caller: "a", op: "status" }, NOW).id, 6);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refresh reads what another writer appended, once; append does not lose it", () => {
  const { dir, path } = tmp();
  try {
    const service = Journal.open(path);
    service.append({ ...base, caller: "agent-control", op: "status" }, NOW);
    // Un autre processus (forge team release) écrit avec l'identifiant 0.
    Journal.open(path).append({ ...base, caller: "human", op: "release", to: "agent-executor-1" }, NOW, 0);
    assert.equal(service.entries().length, 1, "not read yet");
    service.refresh();
    service.refresh();
    assert.equal(service.entries().length, 2);
    // Son propre append relit d'abord, ne perd rien et ne double rien.
    Journal.open(path).append({ ...base, caller: "forge", op: "notify" }, NOW, 0);
    service.append({ ...base, caller: "agent-executor-1", op: "status" }, NOW);
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
    service.append({ ...base, caller: "agent-control", op: "status" }, NOW);
    // L'autre écrivain passe après la dernière lecture du service et avant son écriture.
    Journal.open(path).append({ ...base, caller: "human", op: "release", to: "agent-executor-1" }, NOW, 0);
    service.append({ ...base, caller: "agent-executor-1", op: "status" }, NOW);
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
