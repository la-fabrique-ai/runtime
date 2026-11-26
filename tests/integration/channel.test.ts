// Le canal local de l'orchestrateur (plan 2c), sur un Incus jetable, opt-in :
// après un converge, aiuser du contrôle parle au canal et à lui seul ; un
// exécuteur n'a pas de canal.
//
//   FORGE_INTEGRATION=1 node --test --test-concurrency=1 tests/integration/channel.test.ts
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CONTROL, executorName } from "../../cli/lib/project.ts";
import { CHANNEL_SOCKET } from "../../cli/lib/project-provision.ts";
import { ENABLED, must, raw } from "./lib.ts";
import { pause, projectHarness, type ProjectHarness } from "./project-lib.ts";

const PROJECT = "forge-selftest-channel";
// Les suites incus (1, 2), egress (3), project (4) et orchestrator (5) ont les leurs.
const SLOT = "6";
const EXECUTOR = executorName(1);

const h: ProjectHarness | null = ENABLED ? projectHarness(PROJECT, SLOT, 1) : null;

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  h!.before();
});

after(async () => {
  if (h) await h.after();
});

// Un client de socket en une ligne de Node : 0 s'il se connecte, 1 sinon.
const CONNECT = "const s=require('node:net').connect(process.argv[1]);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));";

test("aiuser in the control reaches the channel, not the orchestrator's files nor the API socket; an executor has no channel", { skip: !ENABLED }, async (t: TestContext) => {
  if (!h!.prepareImage()) return t.skip("no agent-base in project agent-forge (run 'forge image build')");
  const cfg = h!.seed();
  const converged = h!.forge(["team", "converge"]);
  if (converged.status !== 0 && /the image has no forge-orch user/.test(converged.stderr)) {
    return t.skip("agent-base has no forge-orch user: run 'forge image build' with this branch");
  }
  must("team converge", converged);
  await h!.waitOrchestratorActive();
  await h!.serve(cfg);

  // Le canal s'ouvre au démarrage du service.
  let listed = await h!.asAiuser(CONTROL, ["forge-team", "tickets"]);
  for (let i = 0; i < 30 && listed.status !== 0; i++) {
    await pause(1000);
    listed = await h!.asAiuser(CONTROL, ["forge-team", "tickets"]);
  }
  assert.equal(listed.status, 0, raw("forge-team tickets as aiuser in the control", listed));

  const questions = await h!.asAiuser(CONTROL, ["cat", "/var/lib/forge-orch/state/questions.json"]);
  assert.notEqual(questions.status, 0, raw("aiuser reading questions.json", questions));
  const api = await h!.asAiuser(CONTROL, ["node", "-e", CONNECT, "/var/lib/forge/api.sock"]);
  assert.notEqual(api.status, 0, raw("aiuser connecting to the API socket", api));

  const none = await h!.asAiuser(EXECUTOR, ["test", "-e", CHANNEL_SOCKET]);
  assert.notEqual(none.status, 0, `${CHANNEL_SOCKET} exists in ${EXECUTOR}`);
});
