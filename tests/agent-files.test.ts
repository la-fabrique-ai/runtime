// The guards of what forge puts in a project container: the security hook is
// probed in both directions, a plugin from an unknown marketplace is refused,
// and the settings say only what the container's kit asks for.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { requireHookBlocks } from "../cli/lib/commands/provision.ts";
import { installAgentFiles, requirePlugins, type AgentFiles } from "../cli/lib/agent-files.ts";
import { AIUSER_SOCKET } from "../cli/lib/api/access.ts";
import { referenceKit } from "../cli/lib/reference-kit.ts";

beforeEach(() => {
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_API_RUNTIME = "/run/user/1000/forge-api";
});
afterEach(() => {
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_API_RUNTIME;
});

const NAME = "agent-executor-1";
const DENY = "forge-hook-probe-deny";
const ALLOW = "forge-hook-probe-allow";
const BLOCKS: ExecRule = { match: DENY, code: 2, stderr: "BLOCKED.\n" };

function setup(rules: ExecRule[]) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", NAME, { status: "Running" });
  return { fake, ctx: fakeContext({ incus: fake, rules }) };
}

const files = (over: Partial<AgentFiles> = {}): AgentFiles =>
  ({ name: NAME, strict: false, plugins: [], prompt: null, env: null, reference: null, ...over });

test("a hook that lets the forbidden probe through stops provisioning, naming it", async () => {
  const { ctx } = setup([{ match: DENY, code: 0 }]);
  await assert.rejects(requireHookBlocks(ctx, NAME),
    (e: unknown) => e instanceof ForgeError && /let a forbidden command through \(exit code 0, expected 2\)/.test(e.message));
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes(ALLOW)), "the allow probe is not even tried");
});

test("a hook that refuses the harmless probe stops provisioning too", async () => {
  const { ctx } = setup([BLOCKS, { match: ALLOW, code: 2, stderr: "BLOCKED.\n" }]);
  await assert.rejects(requireHookBlocks(ctx, NAME), /refuses a harmless command \(exit code 2, expected 0\): BLOCKED/);
});

test("a hook that blocks the one and lets the other through passes, and installAgentFiles runs the probe", async () => {
  const { ctx } = setup([BLOCKS]);
  await requireHookBlocks(ctx, NAME);
  const bad = setup([{ match: DENY, code: 0 }]);
  await assert.rejects(installAgentFiles(bad.ctx, files(), AIUSER_SOCKET), /let a forbidden command through/);
});

test("a plugin from a marketplace forge does not know is refused; one from the official marketplace passes", () => {
  assert.throws(() => requirePlugins(files({ plugins: ["tool@elsewhere"] })),
    /agent-executor-1: plugin tool@elsewhere is not <name>@<marketplace> with a marketplace forge knows \(claude-plugins-official\)/);
  assert.throws(() => requirePlugins(files({ plugins: ["tool"] })), /plugin tool is not/);
  requirePlugins(files({ plugins: ["tool@claude-plugins-official"] }));
});

const settingsOf = (fake: FakeIncus) =>
  JSON.parse(fake.files.get(`agent-forge/${NAME}/home/aiuser/.claude/settings.json`)!.content) as Record<string, unknown>;

test("settings: no plugins, no enabledPlugins; a kit without memory turns the auto memory off; root owns them", async () => {
  const bare = setup([BLOCKS]);
  await installAgentFiles(bare.ctx, files(), AIUSER_SOCKET);
  const plain = settingsOf(bare.fake);
  assert.equal("enabledPlugins" in plain, false);
  assert.equal("autoMemoryEnabled" in plain, false);
  const pushed = bare.fake.files.get(`agent-forge/${NAME}/home/aiuser/.claude/settings.json`)!;
  assert.deepEqual([pushed.uid, pushed.mode], ["0", "644"]);

  const executor = setup([BLOCKS]);
  assert.equal(referenceKit("executor").memory, false);
  await installAgentFiles(executor.ctx, files({ reference: referenceKit("executor"), plugins: ["tool@claude-plugins-official"] }), AIUSER_SOCKET);
  const kit = settingsOf(executor.fake);
  assert.equal(kit.autoMemoryEnabled, false);
  assert.deepEqual(kit.enabledPlugins, { "tool@claude-plugins-official": true });
});
