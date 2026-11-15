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
const HC: ExecRule = { match: "hc --version", stdout: "hc 0.1.20\n" };

test("assign forwards the instruction as stdin, with the host's own command and no agent forwarding", async () => {
  const ctx = fakeContext({ rules: [{ match: "'forge' 'team' 'assign'", stdout: "Assigned fix-login to agent-web-dev-1.\n" }] });
  const code = await cmdTeamLaptop(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "X" });
  assert.equal(code, 0);
  assert.deepEqual(ctx.calls[0], ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-local", "--",
    "'forge' 'team' 'assign' 'agent-web-dev-1' 'fix-login'"]);
  assert.equal(ctx.execOptions[0]?.input, "X");
  assert.deepEqual(ctx.out_lines, ["Assigned fix-login to agent-web-dev-1."]);
});

test("up checks hc, converges with the agent forwarded, then registers the machines of every declared container", async () => {
  const rows = JSON.stringify([{ name: "agent-web-lead" }, { name: "agent-web-dev-1" }]);
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
  assert.deepEqual(adds.map((c) => c[4]), ["forge-local-web-lead", "forge-local-web-dev-1"]);
  assert.equal(adds[0][6], viaCommand("forge-local", "agent-web-lead"));
});

test("a Mac whose hc is not the pinned version converges nothing", async () => {
  const ctx = fakeContext({ rules: [{ match: "hc --version", stdout: "hc 0.1.21\n" }] });
  await assert.rejects(() => cmdTeamLaptop(ctx, ["up"]), /hc 0\.1\.20/);
  assert.deepEqual(ctx.attachCalls, []);
});

test("a cloud host never gets the forwarded agent", () => {
  assert.throws(() => remoteAttachForwarding(fakeContext(), host("forge-dev", "cloud"), ["forge", "team", "sync", "web"]), /cloud host/);
});

// Le même `forge team status --json`, avant puis après la convergence de l'hôte.
function upContext(before: unknown[], after: unknown[], machines: unknown[]) {
  const base = fakeContext({ rules: [HC, { match: "hc machine ls --json", stdout: JSON.stringify({ machines }) }] });
  let statuses = 0;
  const ctx = { ...base, exec: async (argv: string[], o?: Parameters<typeof base.exec>[1]) => argv.join(" ").includes("'team' 'status' '--json'")
    ? { code: 0, stderr: "", stdout: JSON.stringify(statuses++ === 0 ? before : after) } : base.exec(argv, o) };
  return { base, ctx };
}
const row = (name: string, present: boolean) => ({ name, present });
const machine = (container: string, extra: Record<string, unknown> = {}) =>
  ({ name: `forge-local-${container.replace(/^agent-/, "")}`, target: viaCommand("forge-local", container), ...extra });
const REBUILT = { state: "unreachable", why: 'a different core answers there ("abc")' };

test("up replaces the machine of a container it has just created, and says so", async () => {
  const { base, ctx } = upContext(
    [row("agent-web-lead", false), row("agent-web-dev-1", true)],
    [row("agent-web-lead", true), row("agent-web-dev-1", true)],
    [machine("agent-web-lead", REBUILT), machine("agent-web-dev-1")]);
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  const hc = base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls").map((c) => c.slice(0, 5).join(" "));
  assert.deepEqual(hc, ["hc machine rm forge-local-web-lead", "hc machine add --name forge-local-web-lead"]);
  assert.deepEqual(base.out_lines, ["Replaced Herdr App machine forge-local-web-lead: its container was recreated."]);
});

test("up never re-pins a machine whose container it did not recreate: it says to click Connect", async () => {
  const both = [row("agent-web-lead", true)];
  const { base, ctx } = upContext(both, both, [machine("agent-web-lead", REBUILT)]);
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  assert.deepEqual(base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls"), []);
  assert.ok(base.err_lines.some((l) => l.includes("forge-local-web-lead") && l.includes("Connect")), base.err_lines.join("\n"));
  assert.ok(!base.out_lines.some((l) => l.includes("up to date")));
});

test("up assumes nothing about what converge created when the host cannot say (no `present`)", async () => {
  const old = [{ name: "agent-web-lead" }];
  const { base, ctx } = upContext(old, old, [machine("agent-web-lead")]);
  await cmdTeamLaptop(ctx, ["up"]);
  assert.deepEqual(base.calls.filter((c) => c[0] === "hc" && c[1] === "machine" && c[2] !== "ls"), []);
  assert.deepEqual(base.out_lines, ["Herdr App's machines are up to date."]);
});
