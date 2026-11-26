import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig, type ForgeConfig } from "../cli/lib/config.ts";
import { CONTROL, executorName, projectMembers, repoOriginMirror, repoTeamMirror } from "../cli/lib/project.ts";
import {
  CLAUDE_JSON, convergeControl, convergeExecutor, provisionControl, provisionExecutor, ticketsBase, TICKETS_MOUNT, TRUST_SCRIPT,
} from "../cli/lib/project-provision.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-project-prov-"));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  // Les XDG_* de la machine (la CI définit XDG_CONFIG_HOME) l'emporteraient sur FORGE_HOME.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  process.env.FORGE_API_RUNTIME = "/run/user/1000/forge-api";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS", "FORGE_API_RUNTIME"]) delete process.env[k];
});

const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
];
// Un hook qui marche refuse la commande interdite de la sonde avec le code 2.
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" }];
// Aucun clone (ni donc de remote team) n'existe encore dans le /workspace d'un exécuteur neuf.
const NO_CLONE: ExecRule[] = [{ match: "-- test -d /workspace/", code: 1 }, { match: "remote get-url team", code: 2 }];

const config = (repositories: Record<string, unknown> = { web: { repo: "o/web" }, api: { repo: "o/api" } }): ForgeConfig =>
  parseConfig("/c.json", {
    project: {
      repositories,
      executors: { count: 2, memory: "8GiB", cpu: 2 },
      tickets: { base: "~/tickets" },
    },
  });

const member = (cfg: ForgeConfig, name: string) => projectMembers(cfg.project!).find((m) => m.name === name)!;
const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));

function setup(rules: ExecRule[] = []) {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...rules, ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx };
}

test("an executor of a two-repository project: both device pairs, both clones as aiuser, the team remote, its kit and its socket", async () => {
  const cfg = config();
  const { fake, ctx } = setup(NO_CLONE);
  const name = executorName(1);
  await provisionExecutor(ctx, cfg, member(cfg, name));

  const calls = flat(ctx);
  const launch = calls.find((l) => l.includes(" launch "))!;
  for (const part of ["--profile agent-forge", "-c user.forge.role=executor", "-c limits.memory=8GiB", "-c limits.cpu=2"]) {
    assert.ok(launch.includes(part), `${part} in ${launch}`);
  }
  assert.ok(!launch.includes("user.forge.team"), launch);

  const devices = fake.expandedDevices("agent-forge", name);
  for (const repo of ["web", "api"]) {
    assert.deepEqual(devices[`origin-${repo}`],
      { type: "disk", source: repoOriginMirror(repo), path: `/forge/origins/${repo}.git`, readonly: "true" });
    assert.deepEqual(devices[`team-${repo}`],
      { type: "disk", source: repoTeamMirror(repo), path: `/forge/teams/${repo}.git`, readonly: "true" });
    const clone = calls.findIndex((c) => c.includes(`git clone --no-local /forge/origins/${repo}.git /workspace/${repo}`));
    assert.ok(clone >= 0, calls.join("\n"));
    assert.ok(calls[clone].includes("--user 1001 --group 1001"), calls[clone]);
    const remote = calls.findIndex((c) => c.includes(`git -C /workspace/${repo} remote add team /forge/teams/${repo}.git`));
    assert.ok(remote > clone, calls.join("\n"));
    assert.ok(calls.some((c) => c.includes(`cd /workspace/${repo} && `) && c.includes(".git/info/exclude") &&
      c.includes("/.claude/bash-audit.log") && c.includes("/.claude/settings.local.json")), calls.join("\n"));
  }
  assert.equal(devices.workspace.path, "/workspace");

  assert.ok(fake.files.get(`agent-forge/${name}/home/aiuser/.claude/agents/branch-reviewer.md`));
  assert.ok(fake.files.get(`agent-forge/${name}/home/aiuser/.claude/skills/tdd/SKILL.md`));
  assert.deepEqual(devices["forge-api"], {
    type: "proxy", bind: "instance", listen: "unix:/var/lib/forge/api.sock",
    connect: `unix:/run/user/1000/forge-api/${name}.sock`, uid: "1001", gid: "1001", mode: "0600",
  });
  assert.ok(fake.files.get(`agent-forge/${name}/usr/local/bin/forge-team`));

  const conf = fake.instances.get("agent-forge")!.get(name)!.config;
  assert.equal(conf["user.forge.mode"], "supervised");
  assert.equal(conf["user.forge.image_commit"], "IMGSHA");
  assert.equal(conf["user.forge.provisioning"], undefined);
  assert.equal(conf["user.forge.provisioning_workspace"], undefined);
});

// Claude Code ouvre un écran de confiance pour tout dossier non accepté : la
// session d'un exécuteur, lancée dans le clone, y resterait bloquée.
test("an executor's provisioning and converge pre-accept Claude Code's trust for every clone, after pushing its onboarding state", async () => {
  const cfg = config();
  const { ctx } = setup(NO_CLONE);
  const name = executorName(1);
  await provisionExecutor(ctx, cfg, member(cfg, name));
  const trust = (calls: string[][]) => calls.filter((c) => c.includes("-e") && c.includes(TRUST_SCRIPT));
  let found = trust(ctx.calls);
  assert.equal(found.length, 1, flat(ctx).join("\n"));
  assert.ok(found[0].join(" ").includes("--user 1001 --group 1001"), found[0].join(" "));
  assert.deepEqual(found[0].slice(found[0].indexOf(TRUST_SCRIPT) + 1), [CLAUDE_JSON, "/workspace/web", "/workspace/api"]);
  const pushed = ctx.calls.findIndex((c) => c.join(" ").includes("/home/aiuser/.claude.json") && c.includes("push"));
  assert.ok(pushed >= 0 && pushed < ctx.calls.indexOf(found[0]), "after the onboarding state, which it would otherwise lose");

  const { fake: fake2, ctx: ctx2 } = setup();
  fake2.addInstance("agent-forge", name, {
    status: "Running", profiles: ["agent-forge"], config: { "user.forge.role": "executor" },
    devices: { "origin-web": { type: "disk" }, "team-web": { type: "disk" }, "origin-api": { type: "disk" }, "team-api": { type: "disk" } },
  });
  await convergeExecutor(ctx2, cfg, member(cfg, name));
  found = trust(ctx2.calls);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].slice(found[0].indexOf(TRUST_SCRIPT) + 1), [CLAUDE_JSON, "/workspace/web", "/workspace/api"]);
});

test("the trust script adds the clones to ~/.claude.json and keeps what Claude Code wrote there", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-trust-"));
  try {
    const file = join(dir, "claude.json");
    const run = (...dirs: string[]) => spawnSync(process.execPath, ["-e", TRUST_SCRIPT, file, ...dirs], { encoding: "utf8" });
    // Absent : créé, 0600.
    assert.equal(run("/workspace/web").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).projects["/workspace/web"],
      { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Ce que Claude Code a écrit depuis reste, un refus explicite est remplacé.
    writeFileSync(file, JSON.stringify({
      numStartups: 7, mcpServers: { x: { command: "y" } },
      projects: {
        "/workspace": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
        "/workspace/web": { hasTrustDialogAccepted: false, lastCost: 1.5 },
      },
    }));
    assert.equal(run("/workspace/web", "/workspace/api").status, 0);
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.numStartups, 7);
    assert.deepEqual(j.mcpServers, { x: { command: "y" } });
    assert.deepEqual(j.projects["/workspace"], { hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
    assert.deepEqual(j.projects["/workspace/web"], { hasTrustDialogAccepted: true, lastCost: 1.5, hasCompletedProjectOnboarding: true });
    assert.deepEqual(j.projects["/workspace/api"], { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
    assert.deepEqual(readdirSync(dir), ["claude.json"], "no temporary file left");
    // Illisible : refusé, le fichier n'est pas touché.
    writeFileSync(file, "{ not json");
    const bad = run("/workspace/web");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /claude\.json/);
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("converging an executor adds the devices and the clone of a repository added since, and keeps the others", async () => {
  const before = config({ web: { repo: "o/web" } });
  const { fake, ctx } = setup([
    { match: "-- test -d /workspace/api/.git", code: 1 }, { match: "-C /workspace/api remote get-url team", code: 2 },
  ]);
  const name = executorName(1);
  fake.addInstance("agent-forge", name, {
    status: "Running", profiles: ["agent-forge"],
    config: { "user.forge.role": "executor" },
    devices: { "origin-web": { type: "disk" }, "team-web": { type: "disk" } },
  });
  const after = config({ web: { repo: "o/web" }, api: { repo: "o/api" } });
  await convergeExecutor(ctx, after, member(before, name));

  const calls = flat(ctx);
  const devices = fake.expandedDevices("agent-forge", name);
  assert.ok(devices["origin-api"] && devices["team-api"]);
  assert.equal(calls.filter((c) => c.includes("config device add") && c.includes("-web ")).length, 0, calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("git clone --no-local /forge/origins/api.git /workspace/api")));
  assert.ok(!calls.some((c) => c.includes("/workspace/web") && c.includes("git clone")));
  assert.ok(!calls.some((c) => c.includes(" launch ")));
  // Le remote team d'un clone déjà là n'est pas rajouté ; l'exclusion du journal se repose.
  assert.ok(!calls.some((c) => c.includes("-C /workspace/web remote add team")));
  assert.ok(calls.some((c) => c.includes("cd /workspace/web && ") && c.includes(".git/info/exclude") &&
    c.includes("/.claude/settings.local.json")));
});

test("a clone whose team remote is missing (an interrupted provisioning) gets it at the next converge", async () => {
  const cfg = config({ web: { repo: "o/web" } });
  const { fake, ctx } = setup([{ match: "-C /workspace/web remote get-url team", code: 2 }]);
  const name = executorName(1);
  fake.addInstance("agent-forge", name, {
    status: "Running", profiles: ["agent-forge"], config: { "user.forge.role": "executor" },
    devices: { "origin-web": { type: "disk" }, "team-web": { type: "disk" } },
  });
  await convergeExecutor(ctx, cfg, member(cfg, name));
  const calls = flat(ctx);
  assert.ok(!calls.some((c) => c.includes("git clone")));
  assert.ok(calls.some((c) => c.includes("git -C /workspace/web remote add team /forge/teams/web.git")), calls.join("\n"));
});

test("the control: the ticket base mounted under forge-orch's home, group 1001 and setgid, the ACL, a socket for uid 1002, no clone", async () => {
  const cfg = config();
  const { fake, ctx } = setup();
  await provisionControl(ctx, cfg, member(cfg, CONTROL));

  const base = join(home, "tickets");
  assert.ok(existsSync(base));
  assert.equal(statSync(base).mode & 0o777, 0o770);

  const calls = flat(ctx);
  const launch = calls.find((l) => l.includes(" launch "))!;
  assert.ok(launch.includes("-c user.forge.role=control"), launch);
  const devices = fake.expandedDevices("agent-forge", CONTROL);
  assert.deepEqual(devices.tickets, { type: "disk", source: base, path: TICKETS_MOUNT });
  assert.equal(TICKETS_MOUNT, "/var/lib/forge-orch/tickets");
  const mount = calls.findIndex((c) => c.includes("config device add agent-control tickets"));
  const home0700 = calls.findIndex((c) => c.includes("-- install -d -o forge-orch -g forge-orch -m 0700 /var/lib/forge-orch"));
  assert.ok(home0700 >= 0 && home0700 < mount, calls.join("\n"));
  const root = `incus --project agent-forge exec ${CONTROL} -- `;
  for (const cmd of ["chgrp -R 1001 /var/lib/forge-orch/tickets", "chmod 2770 /var/lib/forge-orch/tickets",
    "setfacl -R -m g:1001:rwX -m d:g:1001:rwX /var/lib/forge-orch/tickets"]) {
    const at = calls.indexOf(`${root}${cmd}`);
    assert.ok(at > mount, `${cmd}\n${calls.join("\n")}`);
  }
  assert.deepEqual(devices["forge-api"], {
    type: "proxy", bind: "instance", listen: "unix:/var/lib/forge/api.sock",
    connect: `unix:/run/user/1000/forge-api/${CONTROL}.sock`, uid: "1002", gid: "1002", mode: "0600",
  });
  assert.ok(!calls.some((c) => c.includes("git clone")));
  assert.equal(devices.workspace, undefined);
  assert.equal(fake.files.get(`agent-forge/${CONTROL}/home/aiuser/.claude/skills/.forge-kit`), undefined);
  assert.ok(!calls.some((c) => c.includes("hc run")));
  assert.equal(fake.instances.get("agent-forge")!.get(CONTROL)!.config["user.forge.provisioning"], undefined);
});

for (const [missing, rule] of [["forge-orch", "getent passwd forge-orch"], ["setfacl", "which setfacl"]]) {
  test(`an image without ${missing} refuses the control before anything is mounted or pushed, and leaves no container`, async () => {
    const cfg = config();
    const { fake, ctx } = setup([{ match: rule, code: 1 }]);
    await assert.rejects(provisionControl(ctx, cfg, member(cfg, CONTROL)),
      /the image has no forge-orch user: run forge image build/);
    const calls = flat(ctx);
    assert.ok(!calls.some((c) => c.includes("config device add") || c.includes("file push")), calls.join("\n"));
    assert.equal(fake.instances.get("agent-forge")!.get(CONTROL), undefined);
  });
}

test("converging the control re-applies the ACL without mounting the base twice", async () => {
  const cfg = config();
  const { fake, ctx } = setup();
  fake.addInstance("agent-forge", CONTROL, {
    status: "Running", profiles: ["agent-forge"], config: { "user.forge.role": "control" },
    devices: { tickets: { type: "disk", source: join(home, "tickets"), path: TICKETS_MOUNT } },
  });
  await convergeControl(ctx, cfg, member(cfg, CONTROL));
  const calls = flat(ctx);
  assert.ok(!calls.some((c) => c.includes("config device add agent-control tickets")), calls.join("\n"));
  assert.ok(calls.some((c) => c.endsWith("-- setfacl -R -m g:1001:rwX -m d:g:1001:rwX /var/lib/forge-orch/tickets")));
  assert.ok(calls.some((c) => c.includes("getent passwd forge-orch")));
});

const withBase = (base: string) => parseConfig("/c.json", {
  project: { repositories: { web: { repo: "o/web" } }, executors: { count: 1 }, tickets: { base } },
}).project!;

test("the ticket base: the default is accepted; the home, the root, a link to the home and forge's folders are refused", () => {
  assert.equal(ticketsBase(withBase("~/.local/share/agent-forge/tickets")), join(home, ".local", "share", "agent-forge", "tickets"));
  assert.throws(() => ticketsBase(withBase("~/")), /project\.tickets\.base \(~\/\) holds your home/);
  assert.throws(() => ticketsBase(withBase("/")), /project\.tickets\.base \(\/\) is the root of the file system/);
  const links = mkdtempSync(join(tmpdir(), "forge-links-"));
  try {
    symlinkSync(home, join(links, "home"));
    assert.throws(() => ticketsBase(withBase(join(links, "home"))), /holds your home/);
    assert.throws(() => ticketsBase(withBase(join(links, "home", "x", ".."))), /holds your home/);
  } finally {
    rmSync(links, { recursive: true, force: true });
  }
  assert.throws(() => ticketsBase(withBase("~/.local/share/agent-forge")), /holds forge's API data/);
  assert.throws(() => ticketsBase(withBase("~/mirrors/tickets")), /lies inside forge's mirrors/);
});

test("a refused ticket base stops the control before anything is launched", async () => {
  const cfg = parseConfig("/c.json", {
    project: { repositories: { web: { repo: "o/web" } }, executors: { count: 1 }, tickets: { base: "~/" } },
  });
  const { fake, ctx } = setup();
  await assert.rejects(provisionControl(ctx, cfg, member(cfg, CONTROL)), /project\.tickets\.base/);
  assert.ok(!flat(ctx).some((c) => c.includes(" launch ")));
  assert.equal(fake.instances.get("agent-forge")!.get(CONTROL), undefined);
});

// ---------------------------------------------------------------- l'orchestrateur en service

const UNIT = "/etc/systemd/system/forge-orchestrator.service";
const MANIFEST = "/opt/forge/.manifest";
const restarts = (ctx: ReturnType<typeof fakeContext>) =>
  flat(ctx).filter((c) => c.endsWith("-- systemctl restart forge-orchestrator"));
const controlConfig = (prefix: string) => parseConfig("/c.json", {
  project: { repositories: { web: { repo: "o/web" } }, executors: { count: 1 }, tickets: { base: "~/tickets", prefix } },
});
const sources = (dir: string) => readdirSync(join(process.cwd(), "cli", "lib", dir)).filter((f) => f.endsWith(".ts"));
const ACTIVE: ExecRule[] = [{ match: "systemctl is-active forge-orchestrator", stdout: "active\n" }];

test("the control's first provisioning pushes the orchestrator (root, 0644), its unit and manifest, then enables and restarts it", async () => {
  const cfg = controlConfig("Q");
  const { fake, ctx } = setup();
  await provisionControl(ctx, cfg, member(cfg, CONTROL));

  const file = (p: string) => fake.files.get(`agent-forge/${CONTROL}${p}`);
  const pushed = ["/opt/forge/orchestrator.ts",
    ...sources("orchestrator").map((f) => `/opt/forge/lib/orchestrator/${f}`),
    ...sources("tickets").map((f) => `/opt/forge/lib/tickets/${f}`)];
  assert.ok(pushed.includes("/opt/forge/lib/orchestrator/tick.ts") && pushed.includes("/opt/forge/lib/tickets/markdown-base.ts"));
  for (const p of [...pushed, UNIT, MANIFEST]) {
    const f = file(p);
    assert.ok(f, `${p} pushed`);
    assert.deepEqual([f.uid, f.gid, f.mode], ["0", "0", "644"], p);
  }
  const unit = file(UNIT)!.content;
  for (const line of ["User=forge-orch", "SupplementaryGroups=1001", "Restart=always", "RestartSec=5", "UMask=0007",
    "ExecStart=/usr/bin/node /opt/forge/orchestrator.ts --base /var/lib/forge-orch/tickets --socket /var/lib/forge/api.sock --state /var/lib/forge-orch/state --prefix Q"]) {
    assert.ok(unit.split("\n").includes(line), `${line}\n${unit}`);
  }
  const calls = flat(ctx);
  const at = (s: string) => calls.findIndex((c) => c.endsWith(`-- ${s}`));
  assert.ok(at("install -d -o forge-orch -g forge-orch -m 0700 /var/lib/forge-orch/state") >= 0, calls.join("\n"));
  const reload = at("systemctl daemon-reload");
  const enable = at("systemctl enable forge-orchestrator");
  const restart = at("systemctl restart forge-orchestrator");
  assert.ok(reload >= 0 && reload < enable && enable < restart, calls.join("\n"));
  // Le socket de l'API existe avant que le service ne démarre.
  assert.ok(calls.findIndex((c) => c.includes("config device add agent-control forge-api")) < restart, calls.join("\n"));
});

test("converging an unchanged control restarts nothing; a stopped service is only started", async () => {
  const cfg = controlConfig("T");
  const { fake, ctx } = setup();
  await provisionControl(ctx, cfg, member(cfg, CONTROL));

  const again = fakeContext({ incus: fake, rules: [...ACTIVE, ...IDENTITY, ...HOOK_BLOCKS] });
  await convergeControl(again, cfg, member(cfg, CONTROL));
  assert.deepEqual(restarts(again), []);
  assert.ok(!flat(again).some((c) => c.includes("forge-orchestrator.service") || c.endsWith("systemctl start forge-orchestrator")),
    flat(again).join("\n"));

  const stopped = fakeContext({ incus: fake, rules: [{ match: "systemctl is-active forge-orchestrator", code: 3, stdout: "inactive\n" },
    ...IDENTITY, ...HOOK_BLOCKS] });
  await convergeControl(stopped, cfg, member(cfg, CONTROL));
  assert.deepEqual(restarts(stopped), []);
  assert.ok(flat(stopped).some((c) => c.endsWith("-- systemctl start forge-orchestrator")), flat(stopped).join("\n"));
});

test("a changed orchestrator source, or a changed prefix, restarts the service at the next converge", async () => {
  const repo = mkdtempSync(join(tmpdir(), "forge-repo-copy-"));
  try {
    for (const d of ["cli", "container", "teams"]) cpSync(join(process.cwd(), d), join(repo, d), { recursive: true });
    process.env.FORGE_REPO_DIR = repo;
    const cfg = controlConfig("T");
    const { fake, ctx } = setup();
    await provisionControl(ctx, cfg, member(cfg, CONTROL));
    assert.equal(restarts(ctx).length, 1);

    appendFileSync(join(repo, "cli", "lib", "orchestrator", "tick.ts"), "\n// changé\n");
    const changed = fakeContext({ incus: fake, rules: [...ACTIVE, ...IDENTITY, ...HOOK_BLOCKS] });
    await convergeControl(changed, cfg, member(cfg, CONTROL));
    assert.equal(restarts(changed).length, 1);
    assert.ok(fake.files.get(`agent-forge/${CONTROL}/opt/forge/lib/orchestrator/tick.ts`)!.content.endsWith("// changé\n"));

    const renamed = controlConfig("R");
    const prefixed = fakeContext({ incus: fake, rules: [...ACTIVE, ...IDENTITY, ...HOOK_BLOCKS] });
    await convergeControl(prefixed, renamed, member(renamed, CONTROL));
    assert.equal(restarts(prefixed).length, 1);
    assert.ok(fake.files.get(`agent-forge/${CONTROL}${UNIT}`)!.content.includes("--prefix R\n"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the instructions of project members are the mission text, with the executor's prompt for an executor only", async () => {
  const cfg = config();
  const { fake, ctx } = setup(NO_CLONE);
  const mission = readFileSync(join(process.cwd(), "container", "CLAUDE.md"), "utf8");
  const prompt = readFileSync(join(process.cwd(), "teams", "reference", "prompts", "executor.md"), "utf8");
  const claudeMd = (name: string) => fake.files.get(`agent-forge/${name}/home/aiuser/.claude/CLAUDE.md`)?.content;
  await provisionExecutor(ctx, cfg, member(cfg, executorName(1)));
  assert.equal(claudeMd(executorName(1)), `${mission}\n${prompt}`);
  assert.ok(fake.files.get(`agent-forge/${executorName(1)}/home/aiuser/.claude/agents/scout.md`));
  assert.ok(fake.files.get(`agent-forge/${executorName(1)}/home/aiuser/.claude/skills/verify-before-report/SKILL.md`));
  await provisionControl(ctx, cfg, member(cfg, CONTROL));
  assert.equal(claudeMd(CONTROL), mission);
});
