// Layer 3 for the API between containers (DX 5, part 2): two throwaway
// containers on a real Incus, opt-in, on a disposable Incus.
//
//   FORGE_INTEGRATION=1 node --test tests/integration/api.test.ts
//
// What the unit tests' fake `incus` and `hc` cannot show: the options of the
// `proxy` device, the messages and the shape of `hc send`, the socket that
// comes back after `incus restart`. `serveApi` runs in this process, with a
// session that announces its own status: no Claude token is needed.
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../cli/lib/api/journal.ts";
import { ensureApiAccess } from "../../cli/lib/api/access.ts";
import { hostSocketPath, serveApi } from "../../cli/lib/api/server.ts";
import { parseConfig } from "../../cli/lib/config.ts";
import { createContext } from "../../cli/lib/context.ts";
import { cmdTeam } from "../../cli/lib/commands/team.ts";
import { installMemberFiles } from "../../cli/lib/team-provision.ts";
import { deliverMessage, hcArgv, MESSAGES_DIR } from "../../cli/lib/hc-session.ts";
import { memberNamed } from "../../cli/lib/team.ts";
import { ENABLED, PREFIX, incus, launch, must, raw, run, waitReady, type Run } from "./lib.ts";

const PROJECT = "agent-forge";
// `agent-forge-selftest-…`: the name prefix the teardown guard recognises.
const TEAM = "forge-selftest";
const LEAD = `agent-${TEAM}-lead`;
const DEV = `agent-${TEAM}-dev-1`;
const NAMES = [LEAD, DEV];
const saved = {
  project: process.env.FORGE_INCUS_PROJECT, runtime: process.env.FORGE_API_RUNTIME,
  config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME,
};
const root = ENABLED ? mkdtempSync(join(tmpdir(), "forge-selftest-api-")) : "";
const stop = new AbortController();
let served: Promise<void> | null = null;

if (ENABLED) {
  process.env.FORGE_INCUS_PROJECT = PROJECT;
  process.env.FORGE_API_RUNTIME = join(root, "run");
  // `forge team status` and `forge team answer` read the config and the journal
  // from the user's directories: a throwaway pair, shared with the service below.
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
}

after(async () => {
  if (!ENABLED) return;
  stop.abort();
  await served;
  for (const name of NAMES) {
    if (name.startsWith(PREFIX)) incus(PROJECT, ["delete", name, "--force"]);
  }
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["FORGE_INCUS_PROJECT", saved.project], ["FORGE_API_RUNTIME", saved.runtime],
    ["XDG_CONFIG_HOME", saved.config], ["XDG_DATA_HOME", saved.data]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const hasImage = () => ENABLED && incus(PROJECT, ["image", "info", "agent-base"]).status === 0;
// The API runs in this process: a call that waits for it must not block the
// event loop (lib.ts's `run` is spawnSync), or the server never answers.
function runAsync(cmd: string, args: string[], input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const asAiuser = (name: string, argv: string[], input = "") =>
  runAsync("incus", ["--project", PROJECT, "exec", name, "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", ...argv], input);
const hc = (name: string, args: string[]) => {
  const argv = hcArgv(name, args);
  return run("incus", argv.slice(1));
};

test("the API over a real proxy device: identity by socket, a message as a file and a notice, a restart", { skip: !ENABLED }, async (t: TestContext) => {
  if (!hasImage()) return t.skip(`no agent-base in project ${PROJECT} (run 'forge image build')`);

  // The lead has a .env and may ask the human; the developer has no .env.
  const envFile = join(root, "lead.env");
  writeFileSync(envFile, "DEMO_GREETING=bonjour\nTRAP=$(touch /tmp/forge-selftest-trap)\n");
  chmodSync(envFile, 0o600);
  const raw_cfg = {
    teams: {
      [TEAM]: {
        repo: "forge-selftest/throwaway",
        roles: {
          lead: { capabilities: ["repo", "assign", "ask-human"], talkTo: ["team"], env: envFile },
          dev: { count: 1, capabilities: ["repo", "publish"], talkTo: ["lead"] },
        },
      },
    },
  };
  mkdirSync(join(root, "config", "agent-forge"), { recursive: true });
  writeFileSync(join(root, "config", "agent-forge", "config.json"), JSON.stringify(raw_cfg));
  const cfg = parseConfig("/c.json", raw_cfg);
  const lines: string[] = [];
  const ctx = { ...createContext(), out: (l: string) => { lines.push(l); } };
  for (const name of NAMES) {
    launch(PROJECT, name);
    await ensureApiAccess(ctx, memberNamed(cfg, name));
  }
  served = serveApi({
    ctx, cfg, journal: Journal.open(join(root, "data", "agent-forge", "api", "journal.jsonl")), secrets: [], now: () => new Date(),
  }, stop.signal);
  for (let i = 0; i < 100 && !NAMES.every((n) => existsSync(hostSocketPath(n))); i++) await new Promise((r) => setTimeout(r, 50));

  // The API knows the caller by the socket: each container is answered as itself.
  const leadStatus = must("forge-team status in the lead", await asAiuser(LEAD, ["forge-team", "status"]));
  assert.match(leadStatus.stdout, new RegExp(`^${DEV} role=dev`, "m"), raw("the lead's status", leadStatus));
  const devStatus = must("forge-team status in the developer", await asAiuser(DEV, ["forge-team", "status"]));
  assert.match(devStatus.stdout, new RegExp(`^${LEAD} role=lead`, "m"), raw("the developer's status", devStatus));
  assert.doesNotMatch(devStatus.stdout, new RegExp(`^${DEV} `, "m"));

  // A container holds its own socket only: nothing of the other's host socket is in it.
  assert.equal(incus(PROJECT, ["exec", DEV, "--", "test", "-e", hostSocketPath(LEAD)]).status, 1,
    "the lead's host socket path exists in the developer's container");
  assert.equal(must("socket in the developer", incus(PROJECT, ["exec", DEV, "--", "stat", "-c", "%U %a", "/var/lib/forge/api.sock"])).stdout.trim(),
    "aiuser 600");

  // A session that announces itself idle (OSC 7501), then echoes what it is typed.
  // Its program is named forge-agent: only such a session is a live one.
  const fake = "/home/aiuser/fake/forge-agent";
  must("a stand-in for forge-agent", incus(PROJECT, ["file", "push", "-", `${LEAD}${fake}`, "--create-dirs", "--uid", "1001", "--gid", "1001", "--mode", "755"],
    "#!/bin/sh\nprintf '\\033]7501;state=idle:app=fake\\033\\\\'\ncat\n"));
  must("a fake session in the lead", hc(LEAD, ["run", "--bg", "--name", "agent", "--cwd", "/workspace", fake]));
  const body = "Détail : Esc \u001b, fin de collage \u001b[201~\n";
  const sent = must("forge-team message", await asAiuser(DEV, ["forge-team", "message", LEAD, "Fini, branche agent/x"], body));
  const id = /^ok (\d+)$/m.exec(sent.stdout)?.[1];
  assert.ok(id, raw("the message's id", sent));
  const path = `${MESSAGES_DIR}/${id}.md`;
  // The body is a file, byte for byte; the session only got the notice.
  assert.equal(must("read the message file", incus(PROJECT, ["file", "pull", `${LEAD}${path}`, "-"])).stdout, body);
  const screen = must("hc read", hc(LEAD, ["read", "agent"])).stdout;
  assert.ok(screen.includes(`[forge] message ${id} from ${DEV}: Fini, branche agent/x (detail: ${path})`), raw("the lead's screen", { status: 0, stdout: screen, stderr: "" }));
  assert.ok(!screen.includes("201~"), "a byte of the body reached the terminal");

  // hc's own words for a session that has ended: deliverMessage reads them as "no live session".
  must("kill the session", hc(LEAD, ["kill", "agent"]));
  await assert.rejects(deliverMessage(ctx, LEAD, DEV, 99, "Fini", null), new RegExp(`${LEAD} has no live session`));

  // A terminal hc kept and runs as a shell is not a session: a message is refused
  // and nothing is typed into it.
  must("a kept shell as the agent terminal", hc(LEAD, ["run", "--bg", "--keep", "--name", "agent", "/bin/bash"]));
  const toShell = await asAiuser(DEV, ["forge-team", "message", LEAD, "Fini, branche agent/y"], "");
  assert.equal(toShell.status, 1, raw("a message to a shell", toShell));
  assert.match(toShell.stderr, new RegExp(`${LEAD} has no live session`));
  assert.doesNotMatch(must("hc read", hc(LEAD, ["read", "agent"])).stdout, /\[forge\] message/);
  must("kill the shell", hc(LEAD, ["kill", "agent"]));

  // The socket comes back with the container.
  must("incus restart", incus(PROJECT, ["restart", LEAD]));
  waitReady(PROJECT, LEAD);
  const again = must("forge-team status after the restart", await asAiuser(LEAD, ["forge-team", "status"]));
  assert.match(again.stdout, new RegExp(`^${DEV} role=dev`, "m"));

  // A question reaches the Inbox of `forge team status --json --quick`.
  const asked = must("forge-team ask in the lead", await asAiuser(LEAD, ["forge-team", "ask", "Quel séparateur ?"], "Détail de la question\n"));
  const question = Number(/^ok (\d+)$/m.exec(asked.stdout)?.[1]);
  assert.ok(question > 0, raw("the question's id", asked));
  const inbox = async () => {
    lines.length = 0;
    await cmdTeam(ctx, ["status"], { json: true, quick: true });
    return (JSON.parse(lines[0]) as { inbox: { id: number; from: string; hasBody: boolean }[] }).inbox;
  };
  assert.deepEqual((await inbox()).map((q) => [q.id, q.from, q.hasBody]), [[question, LEAD, true]]);

  // The answer is typed into the live session, and the Inbox empties; a second one is refused.
  must("a fake session in the lead", hc(LEAD, ["run", "--bg", "--name", "agent", "--cwd", "/workspace", fake]));
  lines.length = 0;
  assert.equal(await cmdTeam(ctx, ["answer", String(question)], { stdin: async () => JSON.stringify({ summary: "Garde le français" }) }), 0);
  assert.match(lines.join("\n"), /delivered to/);
  const typed = must("hc read", hc(LEAD, ["read", "agent"])).stdout;
  assert.ok(typed.includes(`[forge] answer ${question} from human: Garde le français`), raw("the lead's screen", { status: 0, stdout: typed, stderr: "" }));
  assert.deepEqual(await inbox(), []);
  await assert.rejects(cmdTeam(ctx, ["answer", String(question)], { stdin: async () => JSON.stringify({ summary: "Encore" }) }), /already answered/);
  must("kill the session", hc(LEAD, ["kill", "agent"]));

  // A role's .env: in its containers, mode 600, owner 1001; none for a role without.
  for (const name of NAMES) await installMemberFiles(ctx, memberNamed(cfg, name));
  const envPath = "/home/aiuser/.config/forge/env";
  assert.equal(must("stat the lead's env", incus(PROJECT, ["exec", LEAD, "--", "stat", "-c", "%a %u", envPath])).stdout.trim(), "600 1001");
  assert.notEqual(incus(PROJECT, ["exec", DEV, "--", "test", "-e", envPath]).status, 0, "a role without env has a file");
  // forge-agent exports the variables to its process and runs nothing: a stand-in claude shows them.
  const claude = must("a stand-in claude", incus(PROJECT, ["file", "push", "-", `${LEAD}/home/aiuser/fake/claude`, "--create-dirs", "--uid", "1001", "--gid", "1001", "--mode", "755"],
    "#!/bin/sh\necho \"GREETING=$DEMO_GREETING TRAP=$TRAP\"\n"));
  assert.equal(claude.status, 0);
  must("a throwaway token", incus(PROJECT, ["file", "push", "-", `${LEAD}/home/aiuser/fake/token`, "--uid", "1001", "--gid", "1001", "--mode", "600"], "tok-selftest\n"));
  const launched = await asAiuser(LEAD, ["env", "PATH=/home/aiuser/fake:/usr/local/bin:/usr/bin:/bin", "FORGE_TOKEN_FILE=/home/aiuser/fake/token", "/usr/local/bin/forge-agent"]);
  assert.match(launched.stdout, /GREETING=bonjour TRAP=\$\(touch \/tmp\/forge-selftest-trap\)/, raw("forge-agent with a .env", launched));
  assert.notEqual(incus(PROJECT, ["exec", LEAD, "--", "test", "-e", "/tmp/forge-selftest-trap"]).status, 0, "the .env was executed");
});
