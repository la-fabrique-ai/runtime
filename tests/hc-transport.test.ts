import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { hcArgv } from "../cli/lib/hc-session.ts";
import { cmdHcVia } from "../cli/lib/commands/hc-via.ts";
import { cmdHcExec } from "../cli/lib/commands/hc-exec.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-hc-transport-"));
  mkdirSync(join(home, "agent-forge"), { recursive: true });
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    project: { repositories: { web: { repo: "o/web" } }, executors: { count: 1 } },
  }));
  process.env.XDG_CONFIG_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

test("hc-via runs the host's hc-exec over ssh, the line as one quoted word, no agent, nothing asked", async () => {
  const ctx = fakeContext();
  const line = `sh -c 'hc serve; echo "$HOME"'`;
  await cmdHcVia(ctx, "forge-local", "agent-web-dev-1", line);
  assert.deepEqual(ctx.attachCalls[0].argv, [
    "ssh", "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-local", "--",
    `'forge' 'hc-exec' 'agent-web-dev-1' '${line.replaceAll("'", "'\\''")}'`,
  ]);
});

test("hc-via refuses an alias that would be an ssh option, and a name that is not a container", () => {
  assert.throws(() => cmdHcVia(fakeContext(), "-oProxyCommand=x", "agent-web-dev-1", "hc"), /Usage/);
  assert.throws(() => cmdHcVia(fakeContext(), "forge-local", "agent-web-dev-1;id", "hc"), /container must be/);
});

test("hc-exec serves a declared container: su - aiuser -c <line>, with hc's own variables, non-interactive", async () => {
  const ctx = fakeContext();
  await cmdHcExec(ctx, "agent-executor-1", "hc get agent");
  assert.deepEqual(ctx.attachCalls[0].argv, [
    "incus", "--project", "agent-forge", "exec", "-T", "agent-executor-1", "--", "su", "-", "aiuser", "-c",
    "export XDG_RUNTIME_DIR='/run/user/1001' DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1001/bus'; hc get agent",
  ]);
});

test("hc-exec gives hc the variables forge's own hcArgv gives it: one core, not two", async () => {
  const ctx = fakeContext();
  await cmdHcExec(ctx, "agent-executor-1", "hc get agent");
  const script = ctx.attachCalls[0].argv.at(-1)!;
  const env = hcArgv("agent-executor-1", []).filter((a) => /^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=/.test(a));
  assert.equal(env.length, 2);
  for (const pair of env) assert.ok(script.includes(pair.replace("=", "='") + "'"), `${pair} not in ${script}`);
});

test("hc-exec refuses a container in preparation and one without /run/user/1001, before attaching anything", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-executor-1", { status: "Running", config: { "user.forge.provisioning": "o/web" } });
  const preparing = fakeContext({ incus: fake });
  await assert.rejects(() => cmdHcExec(preparing, "agent-executor-1", "hc get agent"), /still being provisioned/);
  assert.deepEqual(preparing.attachCalls, []);

  const booting = fakeContext({ rules: [{ match: "test -d /run/user/1001", code: 1 }] });
  await assert.rejects(() => cmdHcExec(booting, "agent-executor-1", "hc get agent"), /not ready: \/run\/user\/1001 does not exist/);
  assert.deepEqual(booting.attachCalls, []);
});

test("hc-exec refuses an undeclared or malformed container before any incus call", async () => {
  for (const name of ["agent-o-r", "agent-executor-1;id", "agent-executor-9"]) {
    const ctx = fakeContext();
    await assert.rejects(() => cmdHcExec(ctx, name, "hc ls"));
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.attachCalls, []);
  }
});
