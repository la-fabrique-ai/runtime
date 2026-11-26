import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMissionLock } from "../cli/lib/api/mission-lock.ts";

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-mission-lock-"));
  lock = join(dir, "api", "mission.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Un verrou tenu par un autre processus : son dossier et son `owner`.
function heldBy(pid: number, owner = `${pid} ${randomUUID()}\n`): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), owner);
}
const deadPid = () => Number(spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
const left = () => readdirSync(join(dir, "api")).filter((n) => !n.includes(".takeover-"));

test("the lock holds this process's pid and token while the change runs, and is gone after, even on a refusal", async () => {
  const seen = await withMissionLock(async () => readFileSync(join(lock, "owner"), "utf8"), { path: lock });
  assert.match(seen, new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`));
  assert.equal(existsSync(lock), false);
  await assert.rejects(withMissionLock(async () => { throw new Error("refused"); }, { path: lock }), /refused/);
  assert.deepEqual(left(), []);
});

test("a lock another live process holds is waited for, then taken once it is released", async () => {
  const other = spawn("sleep", ["30"]);
  try {
    heldBy(other.pid!);
    let waited = 0;
    // L'autre processus libère son verrou pendant la troisième attente.
    const sleep = async (_ms: number) => { if (++waited === 3) rmSync(lock, { recursive: true }); };
    const ran = await withMissionLock(async () => "ran", { path: lock, sleep });
    assert.equal(ran, "ran");
    assert.equal(waited, 3);
  } finally {
    other.kill();
  }
});

test("a second process waits for the first one's change, then runs its own", async () => {
  // Le premier : un vrai processus Node qui prend le verrou et le garde 600 ms.
  const script = `import { withMissionLock } from ${JSON.stringify(join(import.meta.dirname, "..", "cli", "lib", "api", "mission-lock.ts"))};
await withMissionLock(async () => { console.log("held"); await new Promise((r) => setTimeout(r, 600)); }, { path: ${JSON.stringify(lock)} });`;
  const first = spawn("node", ["--input-type=module", "-e", script]);
  await new Promise<void>((resolve) => first.stdout.on("data", () => resolve()));
  const start = Date.now();
  await withMissionLock(async () => {
    assert.ok(Date.now() - start >= 300, "the second one waited");
  }, { path: lock });
  await new Promise((resolve) => first.on("close", resolve));
});

test("a lock whose holder is dead is taken over at once", async () => {
  heldBy(deadPid());
  let waited = 0;
  await withMissionLock(async () => {}, { path: lock, sleep: async () => { waited++; } });
  assert.equal(waited, 0);
});

test("two waiters that see the same dead holder: one takes it over, the changes never overlap", async () => {
  heldBy(deadPid());
  // Les deux appels lisent le même détenteur mort avant que l'un ne le reprenne.
  let reached = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  const beforeTakeover = async () => { if (++reached === 2) release(); await both; };
  let active = 0;
  let overlap = false;
  const change = async () => {
    if (++active > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 30));
    active--;
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
  await Promise.all([1, 2].map(() => withMissionLock(change, { path: lock, sleep, beforeTakeover })));
  assert.equal(reached, 2);
  assert.equal(overlap, false);
  assert.equal(readdirSync(join(dir, "api")).filter((n) => n.includes(".takeover-")).length, 1);
  assert.deepEqual(left(), []);
});

test("a legacy empty lock is replaced", async () => {
  mkdirSync(lock, { recursive: true });
  assert.equal(await withMissionLock(async () => "ran", { path: lock, waitMs: 0 }), "ran");
  assert.deepEqual(left(), []);
});

// Un verrou vivant arrive toujours en place avec son `owner` : un `owner` absent
// ou malformé ne se reprend jamais (le lire pendant un échange de verrou ne
// doit pas faire prendre le nouveau, vivant, pour abandonné).
test("a lock whose owner is missing or malformed is never taken over: refused after the wait, naming its path", async () => {
  for (const make of [
    () => { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "pid"), "1\n"); },
    () => heldBy(0, "not an owner\n"),
  ]) {
    make();
    let ran = false;
    await assert.rejects(withMissionLock(async () => { ran = true; }, { path: lock, waitMs: 0 }),
      (e: Error) => e.message.includes(lock) && /no valid owner/.test(e.message));
    assert.equal(ran, false);
    assert.ok(existsSync(lock), "left alone");
    rmSync(lock, { recursive: true });
  }
});

test("a lock still held past the wait is refused, and left alone", async () => {
  const other = spawn("sleep", ["30"]);
  try {
    heldBy(other.pid!);
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    await assert.rejects(withMissionLock(async () => {}, { path: lock, waitMs: 1000, ...clock }),
      /the host is busy with another mission change/);
    assert.ok(existsSync(join(lock, "owner")), "the other process's lock is left alone");
  } finally {
    other.kill();
  }
});

test("an owner write that fails leaves no lock behind", async () => {
  let ran = false;
  // `owner` déjà là comme dossier : l'écriture échoue (EISDIR).
  const beforeOwnerWrite = (tmp: string) => mkdirSync(join(tmp, "owner"));
  await assert.rejects(withMissionLock(async () => { ran = true; }, { path: lock, beforeOwnerWrite }));
  assert.equal(ran, false);
  assert.deepEqual(left(), []);
});
