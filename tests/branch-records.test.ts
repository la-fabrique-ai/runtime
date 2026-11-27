import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchRecord, readBranchRecords, recordBranch, setBuiltOn, type BranchRecord } from "../cli/lib/branch-records.ts";

const rec = (over: Partial<BranchRecord> = {}): BranchRecord => ({
  branch: "agent/t1", repository: "org/a", ticket: "T-1", subtask: "S-1", base: "abc123", executor: null, builtOn: null, ...over,
});
const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "forge-br-")), "sub", "branches.json");

test("un fichier absent se lit vide", () => {
  assert.deepEqual(readBranchRecords(tmpFile()), []);
});

test("enregistrer puis relire, en 0600 et sans reste temporaire", () => {
  const p = tmpFile();
  recordBranch(rec(), p);
  assert.deepEqual(readBranchRecords(p), [rec()]);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(p, "..")), ["branches.json"]);
});

test("une même repository + branch est remplacée", () => {
  const p = tmpFile();
  recordBranch(rec(), p);
  recordBranch(rec({ executor: "dev-1", base: "def" }), p);
  assert.deepEqual(readBranchRecords(p), [rec({ executor: "dev-1", base: "def" })]);
});

test("deux dépôts gardent des enregistrements séparés", () => {
  const p = tmpFile();
  recordBranch(rec(), p);
  recordBranch(rec({ repository: "org/b", base: "zzz" }), p);
  assert.equal(branchRecord("org/a", "agent/t1", p)?.base, "abc123");
  assert.equal(branchRecord("org/b", "agent/t1", p)?.base, "zzz");
  assert.equal(branchRecord("org/c", "agent/t1", p), null);
});

test("un fichier corrompu lève une erreur qui nomme le chemin", () => {
  const p = tmpFile();
  recordBranch(rec(), p);
  for (const bad of ["{nope", '{"version":1,"records":[{"branch":"x"}]}', '{"version":2,"records":[]}',
    JSON.stringify({ version: 1, records: [{ ...rec(), extra: 1 }] }),
    JSON.stringify({ version: 1, records: [{ ...rec(), executor: 3 }] })]) {
    writeFileSync(p, bad);
    assert.throws(() => readBranchRecords(p), (e: Error) => e.message.includes(p));
  }
});

test("un rename qui échoue ne laisse aucun fichier temporaire", () => {
  const p = tmpFile();
  mkdirSync(p, { recursive: true }); // un dossier à l'emplacement du fichier
  assert.throws(() => recordBranch(rec(), p));
  assert.deepEqual(readdirSync(join(p, "..")), ["branches.json"]);
});

test("une fiche de la partie 2, sans builtOn, se lit avec null ; setBuiltOn puis recordBranch gardent la valeur", () => {
  const p = tmpFile();
  const { builtOn: _b, ...old } = rec();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, records: [old] }));
  assert.deepEqual(readBranchRecords(p), [rec()]);
  const sha = "a".repeat(40);
  setBuiltOn("org/a", "agent/t1", sha, p);
  assert.equal(branchRecord("org/a", "agent/t1", p)?.builtOn, sha);
  recordBranch({ ...old, executor: "dev-2" }, p);
  assert.deepEqual(readBranchRecords(p), [rec({ executor: "dev-2", builtOn: sha })]);
});
