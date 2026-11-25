import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// Un verrou tenu par un autre processus : son dossier et son pid.
function heldBy(pid: number): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${pid}\n`);
}

test("the lock holds this process's pid while the change runs, and is gone after, even on a refusal", async () => {
  const seen = await withMissionLock(async () => readFileSync(join(lock, "pid"), "utf8").trim(), { path: lock });
  assert.equal(seen, String(process.pid));
  assert.equal(existsSync(lock), false);
  await assert.rejects(withMissionLock(async () => { throw new Error("refused"); }, { path: lock }), /refused/);
  assert.equal(existsSync(lock), false);
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
  const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  heldBy(Number(gone.stdout.trim()));
  let waited = 0;
  await withMissionLock(async () => {}, { path: lock, sleep: async () => { waited++; } });
  assert.equal(waited, 0);
});

test("a lock still held past the wait is refused, and a pid-less lock is waited for only for a while", async () => {
  const other = spawn("sleep", ["30"]);
  try {
    heldBy(other.pid!);
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    await assert.rejects(withMissionLock(async () => {}, { path: lock, waitMs: 1000, ...clock }),
      /the host is busy with another mission change/);
    assert.ok(existsSync(lock), "the other process's lock is left alone");
  } finally {
    other.kill();
  }
  // Un dossier sans pid, vieux de plus de dix secondes : abandonné.
  rmSync(lock, { recursive: true });
  mkdirSync(lock);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lock, old, old);
  await withMissionLock(async () => {}, { path: lock, waitMs: 0 });
});
