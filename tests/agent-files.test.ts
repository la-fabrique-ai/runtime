// The guards of what forge puts in a project container: a plugin from an
// unknown marketplace is refused, and the settings say only what the
// container's kit asks for.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { installAgentFiles, requirePlugins, type AgentFiles } from "../cli/lib/agent-files.ts";
import { AIUSER_SOCKET } from "../cli/lib/api/access.ts";
import { referenceKit } from "../cli/lib/reference-kit.ts";
import { MISSION_DIR } from "../cli/lib/orchestrator/instruction.ts";

beforeEach(() => {
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_API_RUNTIME = "/run/user/1000/forge-api";
});
afterEach(() => {
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_API_RUNTIME;
});

const NAME = "agent-executor-1";

function setup(rules: ExecRule[]) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", NAME, { status: "Running" });
  return { fake, ctx: fakeContext({ incus: fake, rules }) };
}

const files = (over: Partial<AgentFiles> = {}): AgentFiles =>
  ({ name: NAME, strict: false, plugins: [], prompt: null, env: null, reference: null, ...over });

test("a plugin from a marketplace forge does not know is refused; one from the official marketplace passes", () => {
  assert.throws(() => requirePlugins(files({ plugins: ["tool@elsewhere"] })),
    /agent-executor-1: plugin tool@elsewhere is not <name>@<marketplace> with a marketplace forge knows \(claude-plugins-official\)/);
  assert.throws(() => requirePlugins(files({ plugins: ["tool"] })), /plugin tool is not/);
  requirePlugins(files({ plugins: ["tool@claude-plugins-official"] }));
});

const settingsOf = (fake: FakeIncus) =>
  JSON.parse(fake.files.get(`agent-forge/${NAME}/home/aiuser/.claude/settings.json`)!.content) as Record<string, unknown>;

test("settings: no plugins, no enabledPlugins; a kit without memory turns the auto memory off; root owns them", async () => {
  const bare = setup([]);
  await installAgentFiles(bare.ctx, files(), AIUSER_SOCKET);
  const plain = settingsOf(bare.fake);
  assert.equal("enabledPlugins" in plain, false);
  assert.equal("autoMemoryEnabled" in plain, false);
  const pushed = bare.fake.files.get(`agent-forge/${NAME}/home/aiuser/.claude/settings.json`)!;
  assert.deepEqual([pushed.uid, pushed.mode], ["0", "644"]);

  const executor = setup([]);
  assert.equal(referenceKit("executor").memory, false);
  await installAgentFiles(executor.ctx, files({ reference: referenceKit("executor"), plugins: ["tool@claude-plugins-official"] }), AIUSER_SOCKET);
  const kit = settingsOf(executor.fake);
  assert.equal(kit.autoMemoryEnabled, false);
  assert.deepEqual(kit.enabledPlugins, { "tool@claude-plugins-official": true });
});

// Sans cette règle, la première lecture d'un fichier de mission ouvre un
// dialogue de permission qui bloque la session (recette de la PR 195) ; elle
// n'ouvre que ce dossier, en lecture, hors des clones.
test("settings: reads of the mission files are allowed, and no other read outside the clones", async () => {
  const { ctx, fake } = setup([]);
  await installAgentFiles(ctx, files(), AIUSER_SOCKET);
  const perms = settingsOf(fake).permissions as Record<string, unknown>;
  assert.ok((perms.allow as string[]).includes(`Read(/${MISSION_DIR}/**)`));
  assert.ok((perms.allow as string[]).every((r) => r !== "Read" && !r.startsWith("Read(//") || r === `Read(/${MISSION_DIR}/**)`));
  assert.equal("additionalDirectories" in perms, false);
  assert.equal("blockReadsOutsideWorkingDirectories" in perms, false);
});

// Sans ce réglage, une session en bypassPermissions s'arrête au démarrage sur
// l'avertissement « Bypass Permissions mode » (No, exit par défaut) : un
// exécuteur lancé par assign y resterait bloqué.
test("settings: the bypass permissions warning is skipped", async () => {
  const { ctx, fake } = setup([]);
  await installAgentFiles(ctx, files(), AIUSER_SOCKET);
  assert.equal(settingsOf(fake).skipDangerousModePermissionPrompt, true);
});

// Plus de hook dans un container : une session en bypassPermissions pourrait le
// retirer, et la frontière est le container lui-même.
test("settings: the settings.json pushed into a container wires no hook", async () => {
  const { ctx, fake } = setup([]);
  await installAgentFiles(ctx, files(), AIUSER_SOCKET);
  assert.equal("hooks" in settingsOf(fake), false);
});
