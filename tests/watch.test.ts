import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import type { TeamStatus } from "../cli/lib/commands/team.ts";
import { renderWatch, watchLoop } from "../cli/lib/laptop/watch.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const member = (name: string, role: string, over: Partial<TeamStatus["members"][number]> = {}) =>
  ({ name, team: "web", role, present: true, task: null, assignedBy: null, session: "none", waitingOn: null, ...over }) as TeamStatus["members"][number];
const STATUS: TeamStatus = {
  members: [
    member("agent-web-lead", "lead", { task: "(no branch)", session: "idle", waitingOn: "human" }),
    member("agent-web-dev-1", "dev", { task: "fix-login", session: "working" }),
  ],
  inbox: [{ id: 7, from: "agent-web-lead", time: new Date(NOW.getTime() - 120_000).toISOString(), summary: "Quel séparateur ?", hasBody: false }],
  mirrors: [{ team: "web", originAgeSeconds: 180 }],
};

test("renderWatch: the members, the Inbox with the question's age, the mirror's age", () => {
  const text = renderWatch("forge-local", STATUS, null, NOW, NOW, 100);
  const lines = text.split("\n");
  assert.match(lines[0], /^forge team forge-local  \d\d:\d\d:\d\d$/);
  assert.match(lines[1], /^MEMBER\s+ROLE\s+TASK\s+SESSION\s+WAITING$/);
  assert.match(lines[2], /^agent-web-lead\s+lead\s+\(no branch\)\s+idle\s+human$/);
  assert.match(lines[3], /^agent-web-dev-1\s+dev\s+fix-login\s+working\s+-$/);
  assert.deepEqual(lines.slice(4), ["INBOX", "  #7 agent-web-lead 2 min: Quel séparateur ?", "web: origin mirror synced 3 min ago"]);
});

test("renderWatch: text from an agent never reaches the screen with a control character, and a line is cut to the width", () => {
  const evil: TeamStatus = {
    ...STATUS,
    members: [member("agent-web-lead\u001b[2J", "lead")],
    inbox: [{ id: 1, from: "agent-web-lead", time: NOW.toISOString(), summary: "Salut\u001b[2J\u0007 et la suite très longue", hasBody: true }],
  };
  const text = renderWatch("h", evil, null, NOW, NOW, 30);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), JSON.stringify(text));
  assert.ok(text.split("\n").every((l) => l.length <= 30));
});

test("renderWatch: an error after a good status keeps the members and says since when", () => {
  const good = new Date(NOW.getTime() - 60_000);
  const text = renderWatch("h", STATUS, "no answer from h in 20 s", good, NOW, 100);
  assert.ok(text.includes("agent-web-dev-1"));
  assert.match(text.split("\n").at(-1)!, /^unreachable since \d\d:\d\d:\d\d: no answer from h in 20 s$/);
  assert.match(renderWatch("h", null, "boom", null, NOW, 100), /unreachable: boom$/);
});

const HOST = { name: "forge-local" } as LaptopHost;

test("watchLoop never has two calls in flight, even when the host is slower than the interval", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const ctx = fakeContext();
  ctx.sleep = async () => {};
  ctx.exec = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return ++calls < 4 ? { code: 0, stdout: JSON.stringify(STATUS), stderr: "" } : { code: 255, stdout: "", stderr: "ssh: timed out\n" };
  };
  const sigint = new Promise<void>((resolve) => setTimeout(() => { process.emit("SIGINT"); resolve(); }, 200));
  assert.equal(await watchLoop(ctx, HOST, {}), 0);
  await sigint;
  assert.equal(maxInFlight, 1);
  assert.ok(calls >= 4, `${calls} calls`);
  // Après le dernier bon état, l'erreur se montre sur la dernière vue.
  assert.match(ctx.out_lines.at(-1)!, /unreachable since .*: ssh: timed out/);
});

test("watchLoop with once: one call to the host's quick status, with a timeout, exit code 0", async () => {
  const ctx = fakeContext({ rules: [{ match: "'team' 'status' '--json' '--quick'", stdout: JSON.stringify(STATUS) }] });
  assert.equal(await watchLoop(ctx, HOST, { once: true }), 0);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.execOptions[0]?.timeoutMs, 20000);
  assert.ok(ctx.out_lines[0].startsWith("\u001b[H\u001b[2J"));
});
