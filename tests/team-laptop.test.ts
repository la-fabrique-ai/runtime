import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { cmdTeamLaptop } from "../cli/lib/commands/team-laptop.ts";
import { remoteAttachForwarding } from "../cli/lib/laptop/remote.ts";
import { viaCommand } from "../cli/lib/laptop/machines.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-team-laptop-"));
  process.env.FORGE_HOME = tmp;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  saveHost(host("forge-local"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
});

const host = (name: string, kind: LaptopHost["kind"] = "remote"): LaptopHost => ({
  name, kind, address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
  adminKey: "/keys/admin", exposure: "public", done: [],
});
const HC: ExecRule = { match: "hc --version", stdout: "hc 0.1.21\n" };

test("assign forwards the instruction as stdin, with the host's own command and no agent forwarding", async () => {
  const ctx = fakeContext({ rules: [{ match: "'forge' 'team' 'assign'", stdout: "Assigned T-3.1 to agent-executor-1 (web, from origin/main).\n" }] });
  const code = await cmdTeamLaptop(ctx, ["assign", "agent-executor-1", "T-3.1"], { stdin: async () => "X" });
  assert.equal(code, 0);
  assert.deepEqual(ctx.calls[0], ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-local", "--",
    "'forge' 'team' 'assign' 'agent-executor-1' 'T-3.1'"]);
  assert.equal(ctx.execOptions[0]?.input, "X");
  assert.deepEqual(ctx.out_lines, ["Assigned T-3.1 to agent-executor-1 (web, from origin/main)."]);
});

test("assign relays --repository and --base; without a sub-task it asks for one before any SSH", async () => {
  const ctx = fakeContext({ rules: [{ match: "'forge' 'team' 'assign'", stdout: "ok\n" }] });
  await cmdTeamLaptop(ctx, ["assign", "agent-executor-1", "T-3.2"], { stdin: async () => "X", repository: "api", base: "agent/T-3.1" });
  assert.equal(ctx.calls[0].at(-1), "'forge' 'team' 'assign' 'agent-executor-1' 'T-3.2' '--repository' 'api' '--base' 'agent/T-3.1'");
  const none = fakeContext();
  await assert.rejects(() => cmdTeamLaptop(none, ["assign", "agent-executor-1"], { stdin: async () => "X" }), /an executor and a sub-task are required/);
  assert.deepEqual(none.calls, []);
});

test("up checks hc, converges with the agent forwarded, then registers the machines of every declared container", async () => {
  const rows = JSON.stringify({ members: [{ name: "agent-control" }, { name: "agent-executor-1" }] });
  const ctx = fakeContext({ rules: [
    HC, { match: "'forge' 'team' 'status' '--json'", stdout: rows },
    { match: "hc machine ls --json", stdout: JSON.stringify({ machines: [] }) },
  ] });
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  // Hors de la connexion partagée : une connexion maître ouverte sans agent ne
  // transmettrait pas l'agent à cette session.
  assert.deepEqual(ctx.attachCalls[0].argv,
    ["ssh", "-A", "-o", "ControlPath=none", "forge-local", "--", "'forge' 'team' 'converge'"]);
  const adds = ctx.calls.filter((c) => c[0] === "hc" && c[2] === "add");
  assert.deepEqual(adds.map((c) => c[4]), ["forge-local-control", "forge-local-executor-1"]);
  assert.equal(adds[0][6], viaCommand("forge-local", "agent-control"));
  await assert.rejects(() => cmdTeamLaptop(fakeContext({ rules: [HC] }), ["up", "web"]), /a project converges as a whole/);
});

test("up on a project host registers one machine per member, from the project's status rows", async () => {
  const rows = JSON.stringify({ members: ["agent-control", "agent-executor-1", "agent-executor-2"].map((name) =>
    ({ name, kind: name === "agent-control" ? "control" : "executor", present: true, mission: null, session: "none" })) });
  const ctx = fakeContext({ rules: [
    HC, { match: "'forge' 'team' 'status' '--json'", stdout: rows },
    { match: "hc machine ls --json", stdout: JSON.stringify({ machines: [] }) },
  ] });
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  const adds = ctx.calls.filter((c) => c[0] === "hc" && c[2] === "add");
  assert.deepEqual(adds.map((c) => c[4]), ["forge-local-control", "forge-local-executor-1", "forge-local-executor-2"]);
});

test("a Mac whose hc is not the pinned version converges nothing", async () => {
  const ctx = fakeContext({ rules: [{ match: "hc --version", stdout: "hc 0.1.20\n" }] });
  await assert.rejects(() => cmdTeamLaptop(ctx, ["up"]), /hc 0\.1\.21/);
  assert.deepEqual(ctx.attachCalls, []);
});

test("a cloud host never gets the forwarded agent", () => {
  assert.throws(() => remoteAttachForwarding(fakeContext(), host("forge-dev", "cloud"), ["forge", "team", "sync", "web"]), /cloud host/);
});

// Le même `forge team status --json`, avant puis après la convergence de l'hôte.
// Le nouvel objet de l'hôte, ou le tableau d'un hôte plus ancien (`asArray`).
function upContext(before: unknown[], after: unknown[], machines: unknown[], asArray = false) {
  const base = fakeContext({ rules: [HC, { match: "hc machine ls --json", stdout: JSON.stringify({ machines }) }] });
  let statuses = 0;
  const ctx = { ...base, exec: async (argv: string[], o?: Parameters<typeof base.exec>[1]) => argv.join(" ").includes("'team' 'status' '--json'")
    ? { code: 0, stderr: "", stdout: JSON.stringify(((rows) => asArray ? rows : { members: rows })(statuses++ === 0 ? before : after)) } : base.exec(argv, o) };
  return { base, ctx };
}
const row = (name: string, present: boolean) => ({ name, present });
const machine = (container: string, extra: Record<string, unknown> = {}) =>
  ({ name: `forge-local-${container.replace(/^agent-/, "")}`, target: viaCommand("forge-local", container), ...extra });
const REBUILT = { state: "unreachable", why: 'a different core answers there ("abc")' };

test("up replaces the machine of a container it has just created, and says so", async () => {
  const { base, ctx } = upContext(
    [row("agent-executor-1", false), row("agent-executor-2", true)],
    [row("agent-executor-1", true), row("agent-executor-2", true)],
    [machine("agent-executor-1", REBUILT), machine("agent-executor-2")]);
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  const hc = base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls").map((c) => c.slice(0, 5).join(" "));
  assert.deepEqual(hc, ["hc machine rm forge-local-executor-1", "hc machine add --name forge-local-executor-1"]);
  assert.deepEqual(base.out_lines, ["Replaced Herdr App machine forge-local-executor-1: its container was recreated."]);
});

test("up never re-pins a machine whose container it did not recreate: it says to click Connect", async () => {
  const both = [row("agent-executor-1", true)];
  const { base, ctx } = upContext(both, both, [machine("agent-executor-1", REBUILT)]);
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  assert.deepEqual(base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls"), []);
  assert.ok(base.err_lines.some((l) => l.includes("forge-local-executor-1") && l.includes("Connect")), base.err_lines.join("\n"));
  assert.ok(!base.out_lines.some((l) => l.includes("up to date")));
});

test("up assumes nothing about what converge created when the host cannot say (no `present`)", async () => {
  const old = [{ name: "agent-executor-1" }];
  const { base, ctx } = upContext(old, old, [machine("agent-executor-1")], true);
  await cmdTeamLaptop(ctx, ["up"]);
  assert.deepEqual(base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls"), []);
  assert.deepEqual(base.out_lines, ["Herdr App's machines are up to date."]);
});

test("status relays --json and --quick to the host's own command", async () => {
  const ctx = fakeContext({ rules: [{ match: "'forge' 'team' 'status'", stdout: "{}\n" }] });
  assert.equal(await cmdTeamLaptop(ctx, ["status"], { json: true, quick: true }), 0);
  assert.ok(String(ctx.calls[0].at(-1)).endsWith("'forge' 'team' 'status' '--json' '--quick'"), ctx.calls[0].join(" "));
});

// `forge team summary --json` : une ligne de JSON, un hôte injoignable est une entrée en erreur.
test("summary answers one line of JSON for every installed host; an unreachable one has its error and empty counts", async () => {
  saveHost({ ...host("forge-local"), done: ["setup"] });
  saveHost({ ...host("forge-two"), done: ["setup"] });
  const mission = { kind: "dev", ticket: "T-1", subtask: "T-1.1", repository: "web", branch: "agent/T-1.1", base: "origin/main" };
  const status = { members: [
    { name: "agent-control", kind: "control", present: true, mission: null, session: "none", orchestrator: "act\u001bive" },
    { name: "agent-executor-1", kind: "executor", present: true, mission, session: "working" },
    { name: "agent-executor-2", kind: "executor", present: true, mission, session: "idle" },
    { name: "agent-executor-3", kind: "executor", present: true, mission: null, session: "none" },
    { name: "agent-executor-4", kind: "executor", present: false, mission: null, session: "none" },
  ] };
  const ctx = fakeContext({ rules: [
    { match: "forge-local -- ", stdout: JSON.stringify(status) },
    { match: "forge-two -- ", code: 255, stderr: "ssh: connect to host: Connection refused\n" },
  ] });
  assert.equal(await cmdTeamLaptop(ctx, ["summary"], { json: true }), 0);
  assert.equal(ctx.out_lines.length, 1);
  const report = JSON.parse(ctx.out_lines[0]);
  assert.deepEqual(report.hosts[0], { host: "forge-local", executors: { working: 1, idle: 1, free: 1 }, orchestrator: "active", error: null });
  assert.equal(report.hosts[1].error, "ssh: connect to host: Connection refused");
  assert.deepEqual(report.hosts[1].executors, { working: 0, idle: 0, free: 0 });
  assert.ok(ctx.execOptions.every((o) => o?.timeoutMs === 20000));
  await assert.rejects(() => cmdTeamLaptop(fakeContext(), ["summary"]), /only has a JSON form/);
  const one = fakeContext();
  await assert.rejects(() => cmdTeamLaptop(one, ["summary"], { json: true, host: "forge-local" }), /covers every installed host: it takes no --host/);
  assert.deepEqual(one.calls, []);
});

test("the Inbox's commands are gone", async () => {
  for (const sub of ["inbox", "watch", "question"]) {
    await assert.rejects(() => cmdTeamLaptop(fakeContext(), [sub]), /Usage: forge team up/);
  }
});
