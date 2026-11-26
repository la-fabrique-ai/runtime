// Le provisioning des containers d'un projet (forge à tickets) : le container
// de contrôle, où l'orchestrateur tiendra la base des tickets, et les
// exécuteurs, qui ont un clone de chaque dépôt (/workspace/<nom>). Les fichiers
// que forge pose dans chacun sont ceux d'agent-files.ts ; le contrôle n'a ni
// clone ni session dans la partie 1.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { BASE_IMAGE, latestImageCommit, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY } from "./containers.ts";
import {
  configSet, configUnset, deleteInstance, deviceNames, execArgv, execAsAgent, execAsAgentArgv, forgeProject, incus, pullText, pushText, waitReady,
} from "./incus.ts";
import { lfsMirrorConfig } from "./mirror.ts";
import {
  hostGitIdentity, LFS_FILTERS_INSTALL, LFS_FILTERS_READ, pushClaudeToken, pushFile, refreshClaude,
  requireClaudeToken, requireHostLfs, requireRuntime,
} from "./commands/provision.ts";
import { egressNames, PROFILE } from "./objects.ts";
import { apiDataDir, configPath, forgeHome, memoriesDir, mirrorsDir, repoRoot, workspacesDir } from "./paths.ts";
import { ensureRepoMirrors, repoOriginMirror, repoTeamMirror, type ProjectMember } from "./project.ts";
import type { ProjectConfig } from "./project-config.ts";
import { applyStrictSettings, requireStrictRuntime, strictLaunchArgs } from "./strict.ts";
import { referenceDir, referenceKit, type ReferenceKit } from "./reference-kit.ts";
import { AIUSER_SOCKET, CONTAINER_SOCKET, ORCH_SOCKET } from "./api/access.ts";
import { ensureRunning } from "./session.ts";
import { installAgentFiles, installPlugins, requirePlugins, type AgentFiles } from "./agent-files.ts";

const MODE = "supervised";

// Dans un exécuteur : les miroirs de chaque dépôt, en lecture seule, et son clone.
export const ORIGINS_MOUNT = "/forge/origins";
export const TEAMS_MOUNT = "/forge/teams";
export const originDevice = (repo: string) => `origin-${repo}`;
export const teamDevice = (repo: string) => `team-${repo}`;
export const cloneDir = (repo: string) => `/workspace/${repo}`;

// Dans le contrôle : la maison de l'orchestrateur (forge-orch, 0700 : aiuser ne
// peut pas y entrer) et la base des tickets montée dessous.
export const ORCH_USER = "forge-orch";
export const ORCH_HOME = "/var/lib/forge-orch";
export const TICKETS_MOUNT = `${ORCH_HOME}/tickets`;
export const TICKETS_DEVICE = "tickets";
// Le groupe d'aiuser, dont forge-orch est membre ; l'humain sur l'hôte y est vu
// sous l'uid 1001 (raw.idmap du profil).
const AIUSER_GROUP = "1001";
const NO_ORCH = "the image has no forge-orch user: run forge image build";

// Le kit d'un exécuteur et son prompt : le rôle `executor` de roles.json et
// teams/reference/prompts/executor.md. Les instructions du container (la mission,
// container/CLAUDE.md) sont les mêmes pour le contrôle, qui les lit pour
// comprendre ce que font les exécuteurs.
export const executorKit = (): ReferenceKit => referenceKit("executor");
const executorPrompt = (): string => join(referenceDir(), "prompts", "executor.md");

function requireProject(cfg: ForgeConfig): ProjectConfig {
  if (cfg.project === null) throw new ForgeError("no project in the configuration");
  return cfg.project;
}

const hostPath = (p: string): string => (p.startsWith("~/") ? join(forgeHome(), p.slice(2)) : p);

// Un chemin absolu sans `..` ni lien symbolique : la partie qui existe passe
// par realpath, le reste (pas encore créé) s'y ajoute tel quel.
function realPath(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realPath(parent), basename(abs));
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// Le dossier de la base des tickets sur l'hôte, `~/` résolu. forge le monte en
// lecture-écriture dans le contrôle et y repose, en root et récursivement, le
// groupe, le setgid et l'ACL : une base qui contiendrait le home de l'humain,
// sa config forge ou les données de forge (miroirs, workspaces, mémoires,
// journal de l'API) en réécrirait les droits (~/.ssh, le token Claude). Une
// base dans les miroirs ou les workspaces se mêlerait aux dépôts des agents.
// Refusée avant tout montage ou commande.
export function ticketsBase(p: ProjectConfig): string {
  const base = realPath(hostPath(p.tickets.base));
  const refuse = (why: string) =>
    new ForgeError(`project.tickets.base (${p.tickets.base}) ${why}: choose a folder of its own, such as ~/.local/share/agent-forge/tickets`);
  if (base === sep) throw refuse("is the root of the file system");
  const guarded: [string, string][] = [
    [forgeHome(), "your home"], [dirname(configPath()), "forge's config folder"], [mirrorsDir(), "forge's mirrors"],
    [workspacesDir(), "forge's workspaces"], [memoriesDir(), "forge's memories"], [apiDataDir(), "forge's API data"],
  ];
  for (const [dir, what] of guarded) {
    if (within(realPath(dir), base)) throw refuse(`holds ${what} (${dir})`);
  }
  for (const [dir, what] of [[mirrorsDir(), "forge's mirrors"], [workspacesDir(), "forge's workspaces"]]) {
    if (within(base, realPath(dir))) throw refuse(`lies inside ${what} (${dir})`);
  }
  return base;
}

// Ce que les aides d'agent-files.ts lisent d'un container du projet : le kit,
// le prompt, les plugins et le .env des exécuteurs ; rien de tout cela pour le contrôle.
function agentFiles(p: ProjectConfig, m: ProjectMember): AgentFiles {
  const executor = m.kind === "executor";
  const e = p.executors;
  return {
    name: m.name, strict: executor && e.strict, plugins: executor ? e.plugins : [],
    prompt: executor ? executorPrompt() : null, env: executor && e.env !== null ? hostPath(e.env) : null,
    reference: executor ? executorKit() : null,
  };
}

async function launch(ctx: Context, name: string, keys: string[], strictArgs: string[]): Promise<void> {
  ctx.out(`Creating container ${name}...`);
  await mustSucceed("incus launch", ctx.exec(incus("launch", BASE_IMAGE, name, "--profile", PROFILE, ...keys, ...strictArgs)));
  await waitReady(ctx, name);
}

async function configureGit(ctx: Context, name: string, identity: { name: string; email: string }): Promise<void> {
  ctx.out("Configuring git (the project's identity, unsigned commits)...");
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email], ["commit.gpgsign", "false"]]) {
    await mustSucceed(`git config ${key}`, execAsAgentArgv(ctx, name, ["git", "config", "--global", key, value]));
  }
}

export const CLAUDE_JSON = "/home/aiuser/.claude.json";

async function pushAgentState(ctx: Context, name: string): Promise<void> {
  await pushClaudeToken(ctx, name);
  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    name, CLAUDE_JSON, 1001, "600");
}

// Claude Code demande, pour chaque dossier où il démarre, si on lui fait
// confiance, « No, exit » présélectionné : une session lancée dans un clone non
// accepté reste à cet écran sans lire sa consigne. Ce script, lancé par node
// dans le container en aiuser (`node -e TRUST_SCRIPT <fichier> <dossier>...`),
// ajoute chaque dossier aux projets acceptés du fichier, sans toucher au reste
// de ce que Claude Code y a écrit ; il n'écrit que s'il change quelque chose,
// par un temporaire renommé. Un fichier illisible est refusé, laissé tel quel.
export const TRUST_SCRIPT = `
const fs = require("fs");
const [file, ...dirs] = process.argv.slice(1);
let j = {};
try {
  j = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") { console.error(file + " is not readable JSON: " + e.message); process.exit(2); }
}
if (typeof j !== "object" || j === null || Array.isArray(j)) { console.error(file + " is not a JSON object"); process.exit(2); }
if (typeof j.projects !== "object" || j.projects === null || Array.isArray(j.projects)) j.projects = {};
let changed = false;
for (const d of dirs) {
  const p = typeof j.projects[d] === "object" && j.projects[d] !== null ? j.projects[d] : {};
  for (const k of ["hasTrustDialogAccepted", "hasCompletedProjectOnboarding"]) {
    if (p[k] !== true) { p[k] = true; changed = true; }
  }
  j.projects[d] = p;
}
if (changed) {
  const tmp = file + ".forge-trust-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
`;

// La confiance de Claude Code pour chaque clone, le dossier où `assign` lance
// la session (missions.ts) : à la création, et à chaque converge (un dépôt
// ajouté au projet depuis).
export const trustedDirs = (p: ProjectConfig): string[] => Object.keys(p.repositories).map(cloneDir);

async function trustClones(ctx: Context, p: ProjectConfig, name: string): Promise<void> {
  ctx.out("Pre-accepting Claude Code's trust for each clone...");
  await mustSucceed(`pre-accept Claude Code's trust in ${name}`,
    execAsAgentArgv(ctx, name, ["node", "-e", TRUST_SCRIPT, CLAUDE_JSON, ...trustedDirs(p)]));
}

// `workspace` : le marqueur du workspace a été posé au lancement (exécuteur).
async function finish(ctx: Context, m: AgentFiles, workspace: boolean): Promise<void> {
  await refreshClaude(ctx, m.name, m.strict);
  await installPlugins(ctx, m);
  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, m.name, `echo '${MODE}' > /home/aiuser/.claude/forge-mode`));
  await mustSucceed("record forge mode", configSet(ctx, m.name, "user.forge.mode", MODE));
  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit", configSet(ctx, m.name, "user.forge.image_commit", await latestImageCommit(ctx)));
  ctx.out("Recording forge metadata...");
  await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_KEY));
  if (workspace) await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_WORKSPACE_KEY));
  ctx.out(`Container ${m.name} provisioned.`);
}

// ---------------------------------------------------------------- exécuteurs

export async function provisionExecutor(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<void> {
  const p = requireProject(cfg);
  const member = agentFiles(p, m);
  // Préconditions, toutes vérifiées avant de rien créer.
  requireClaudeToken();
  requirePlugins(member);
  const identity = p.gitIdentity ?? await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  if (Object.values(p.repositories).some((r) => r.lfs)) await requireHostLfs(ctx);
  const plan = member.strict ? await requireStrictRuntime(ctx) : null;
  // Les miroirs (SSH, agent de l'humain) avant le lancement.
  await ensureRepoMirrors(ctx, p);

  const workspaceDir = join(workspacesDir(), m.name);
  const reuse = existsSync(workspaceDir) && readdirSync(workspaceDir).length > 0;
  const keys = [
    "-c", `${PROVISIONING_KEY}=${m.name}`,
    "-c", `${PROVISIONING_WORKSPACE_KEY}=${reuse ? "kept" : "new"}`,
    "-c", "user.forge.role=executor",
  ];
  if (p.executors.memory !== null) keys.push("-c", `limits.memory=${p.executors.memory}`);
  if (p.executors.cpu !== null) keys.push("-c", `limits.cpu=${p.executors.cpu}`);
  await launch(ctx, m.name, keys, plan ? strictLaunchArgs(plan, egressNames(forgeProject())) : []);
  if (plan) await applyStrictSettings(ctx, m.name, plan);

  mkdirSync(workspaceDir, { recursive: true });
  ctx.out("Mounting the workspace...");
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", m.name, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));
  await ensureExecutorRepos(ctx, p, m.name);
  await configureGit(ctx, m.name, identity);
  await pushAgentState(ctx, m.name);
  await trustClones(ctx, p, m.name);
  await installAgentFiles(ctx, member, AIUSER_SOCKET);
  await finish(ctx, member, true);
}

// Un exécuteur déjà là : ses fichiers, et les devices et clones des dépôts
// ajoutés à la config depuis (un dépôt retiré garde les siens). Rend vrai quand
// les instructions ont changé : une session lancée ne les relit pas.
export async function convergeExecutor(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<{ instructionsChanged: boolean }> {
  const p = requireProject(cfg);
  await ensureRunning(ctx, m.name);
  const present = new Set(await deviceNames(ctx, m.name));
  const added = Object.fromEntries(Object.entries(p.repositories)
    .filter(([name]) => !present.has(originDevice(name)) || !present.has(teamDevice(name))));
  if (Object.keys(added).length > 0) {
    if (Object.values(added).some((r) => r.lfs)) await requireHostLfs(ctx);
    await ensureRepoMirrors(ctx, { ...p, repositories: added });
  }
  await ensureExecutorRepos(ctx, p, m.name);
  await trustClones(ctx, p, m.name);
  return installAgentFiles(ctx, agentFiles(p, m), AIUSER_SOCKET);
}

// Les filtres LFS globaux d'aiuser : avec le smudge dès qu'un dépôt lit ses
// objets LFS (chaque clone règle ensuite le sien, `--local`).
const lfsFilters = (p: ProjectConfig) => (Object.values(p.repositories).some((r) => r.lfs) ? LFS_FILTERS_READ : LFS_FILTERS_INSTALL);

// Les fichiers que forge et Claude Code écrivent dans le clone, jamais du travail.
const EXCLUDED = ["/.claude/bash-audit.log", "/.claude/settings.local.json"];

// Idempotent : les filtres LFS globaux, puis par dépôt les deux devices s'ils
// manquent, le clone s'il manque, et à chaque passage le remote `team` et
// les exclusions (EXCLUDED), qu'un clone interrompu après coup n'aurait pas.
// Git ne tourne que dans le container, en aiuser.
async function ensureExecutorRepos(ctx: Context, p: ProjectConfig, name: string): Promise<void> {
  const present = new Set(await deviceNames(ctx, name));
  // Les filtres d'abord : un clone LFS fait le smudge depuis le miroir.
  await mustSucceed(`git-lfs filters in ${name}`, execAsAgent(ctx, name, lfsFilters(p)));
  for (const [repo, { repo: ownerRepo, lfs }] of Object.entries(p.repositories)) {
    const origin = `${ORIGINS_MOUNT}/${repo}.git`;
    const team = `${TEAMS_MOUNT}/${repo}.git`;
    for (const [device, source, path] of [
      [originDevice(repo), repoOriginMirror(repo), origin], [teamDevice(repo), repoTeamMirror(repo), team],
    ]) {
      if (present.has(device)) continue;
      ctx.out(`Mounting ${source} in ${name} (read-only)...`);
      await mustSucceed(`mount ${device}`, ctx.exec(incus("config", "device", "add", name, device, "disk",
        `source=${source}`, `path=${path}`, "readonly=true")));
    }
    const dir = cloneDir(repo);
    if ((await execAsAgentArgv(ctx, name, ["test", "-d", `${dir}/.git`])).code !== 0) {
      await cloneRepo(ctx, name, repo, ownerRepo, lfs);
    }
    if ((await execAsAgentArgv(ctx, name, ["git", "-C", dir, "remote", "get-url", "team"])).code !== 0) {
      await mustSucceed(`add the team remote of ${repo}`, execAsAgentArgv(ctx, name, ["git", "-C", dir, "remote", "add", "team", team]));
    }
    // Le hook écrit son journal d'audit dans <cwd>/.claude, et Claude Code y
    // range ses permissions locales (settings.local.json) : sans ces
    // exclusions, un clone neuf paraîtrait sale. `repo` suit REPO_NAME.
    const excludes = EXCLUDED.map((x) => `{ grep -qxF '${x}' .git/info/exclude || echo '${x}' >> .git/info/exclude; }`).join(" && ");
    await mustSucceed("clone excludes", execAsAgent(ctx, name, `cd ${dir} && ${excludes}`));
  }
}

async function cloneRepo(ctx: Context, name: string, repo: string, ownerRepo: string, lfs: boolean): Promise<void> {
  const origin = `${ORIGINS_MOUNT}/${repo}.git`;
  const dir = cloneDir(repo);
  ctx.out(`Cloning ${ownerRepo} into ${name}:${dir}...`);
  // Sans `lfs`, pas de smudge : le miroir n'a aucun objet LFS et le container
  // n'a pas de réseau vers eux. Avec, les objets se lisent dans le miroir.
  const clone = lfs
    ? ["git", "clone", ...lfsMirrorConfig(origin).flatMap(([k, v]) => ["-c", `${k}=${v}`]), "--no-local", origin, dir]
    : ["env", "GIT_LFS_SKIP_SMUDGE=1", "git", "clone", "--no-local", origin, dir];
  await mustSucceed(`clone ${repo} in ${name}`, execAsAgentArgv(ctx, name, clone));
  // Les hooks LFS et le filtre de ce clone (`--local`) : un dépôt sans `lfs`
  // garde le smudge sauté même quand un autre dépôt le fait.
  const hooks = await execAsAgentArgv(ctx, name, ["git", "-C", dir, "lfs", "install", "--local", ...(lfs ? [] : ["--skip-smudge"])]);
  if (hooks.code !== 0) {
    ctx.err(`WARNING: installing git-lfs hooks in ${dir} failed: ${hooks.stderr.trim() || `exit code ${hooks.code}`}`);
  }
}

// ---------------------------------------------------------------- contrôle

export async function provisionControl(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<void> {
  const p = requireProject(cfg);
  const member = agentFiles(p, m);
  requireClaudeToken();
  const identity = p.gitIdentity ?? await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  ticketsBase(p);

  await launch(ctx, m.name, ["-c", `${PROVISIONING_KEY}=${m.name}`, "-c", "user.forge.role=control"], []);
  // L'utilisateur de l'orchestrateur et setfacl ne se voient que dans un
  // container de l'image : sans eux, celui qu'on vient de lancer est retiré, rien
  // n'y a été monté ni poussé.
  try {
    await requireOrchestratorImage(ctx, m.name);
  } catch (e) {
    await deleteInstance(ctx, m.name);
    throw e;
  }
  await ensureTicketBase(ctx, p, m.name);
  await configureGit(ctx, m.name, identity);
  await pushAgentState(ctx, m.name);
  await installAgentFiles(ctx, member, ORCH_SOCKET);
  await installOrchestrator(ctx, cfg, m);
  await finish(ctx, member, false);
}

// Le contrôle déjà là : l'image, la base des tickets (droits et ACL reposés à
// chaque fois), ses fichiers et l'orchestrateur.
export async function convergeControl(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<{ instructionsChanged: boolean }> {
  const p = requireProject(cfg);
  ticketsBase(p);
  await ensureRunning(ctx, m.name);
  await requireOrchestratorImage(ctx, m.name);
  await ensureTicketBase(ctx, p, m.name);
  const files = await installAgentFiles(ctx, agentFiles(p, m), ORCH_SOCKET);
  await installOrchestrator(ctx, cfg, m);
  return files;
}

async function requireOrchestratorImage(ctx: Context, name: string): Promise<void> {
  for (const probe of [["getent", "passwd", ORCH_USER], ["which", "setfacl"]]) {
    if ((await execArgv(ctx, name, probe)).code !== 0) throw new ForgeError(NO_ORCH);
  }
}

// La base des tickets : un dossier de l'humain sur l'hôte (créé en 0770 s'il
// manque), monté en lecture-écriture sous la maison de forge-orch, sans
// `shift` (le raw.idmap du profil y fait voir l'humain en 1001). Dedans, en
// root : le groupe 1001, le setgid, et l'ACL par défaut qui garde ce que crée
// chaque côté (l'humain, quel que soit son umask, ou forge-orch) inscriptible
// par l'autre.
async function ensureTicketBase(ctx: Context, p: ProjectConfig, name: string): Promise<void> {
  const base = ticketsBase(p);
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true });
    chmodSync(base, 0o770);
  }
  // Avant le device : Incus créerait en root un parent manquant du point de montage.
  await mustSucceed(`prepare ${ORCH_HOME}`, execArgv(ctx, name,
    ["install", "-d", "-o", ORCH_USER, "-g", ORCH_USER, "-m", "0700", ORCH_HOME]));
  if (!(await deviceNames(ctx, name)).includes(TICKETS_DEVICE)) {
    ctx.out(`Mounting the ticket base ${base} in ${name}...`);
    await mustSucceed("mount the ticket base", ctx.exec(incus("config", "device", "add", name, TICKETS_DEVICE, "disk",
      `source=${base}`, `path=${TICKETS_MOUNT}`)));
  }
  for (const argv of [
    ["chgrp", "-R", AIUSER_GROUP, TICKETS_MOUNT],
    ["chmod", "2770", TICKETS_MOUNT],
    ["setfacl", "-R", "-m", `g:${AIUSER_GROUP}:rwX`, "-m", `d:g:${AIUSER_GROUP}:rwX`, TICKETS_MOUNT],
  ]) {
    await mustSucceed(`${argv[0]} the ticket base`, execArgv(ctx, name, argv));
  }
}

// ---------------------------------------------------------------- l'orchestrateur

// Le code de l'orchestrateur dans le contrôle : orchestrator.ts et ses deux
// dossiers, dans la même disposition que cli/, pour que ses imports relatifs
// tiennent (il n'importe que node:* et ces dossiers, tests/orchestrator-imports.test.ts).
export const ORCH_DIR = "/opt/forge";
export const ORCH_UNIT = "/etc/systemd/system/forge-orchestrator.service";
export const ORCH_SERVICE = "forge-orchestrator";
const ORCH_MANIFEST = `${ORCH_DIR}/.manifest`;
const ORCH_STATE = `${ORCH_HOME}/state`;
const ORCH_LIBS = ["orchestrator", "tickets"];

// L'unité : forge-orch, que systemd lance avec ses groupes supplémentaires
// (initgroups), dont 1001, qui lui ouvre la base des tickets ; la ligne
// SupplementaryGroups le redit. Jamais `incus exec --user`, qui les perd.
// UMask 0007 : ce qu'il écrit dans la base reste inscriptible par le groupe.
// Node vient de NodeSource (rôle forge_image), en /usr/bin/node.
export function orchestratorUnit(prefix: string): string {
  return [
    "[Unit]",
    "Description=forge orchestrator (ticket-driven project)",
    "After=network.target",
    "",
    "[Service]",
    `User=${ORCH_USER}`,
    `Group=${ORCH_USER}`,
    `SupplementaryGroups=${AIUSER_GROUP}`,
    `ExecStart=/usr/bin/node ${ORCH_DIR}/orchestrator.ts --base ${TICKETS_MOUNT} --socket ${CONTAINER_SOCKET} --state ${ORCH_STATE} --prefix ${prefix}`,
    "Restart=always",
    "RestartSec=5",
    "UMask=0007",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

type OrchFile = { dest: string; content: string };

function orchestratorFiles(prefix: string): OrchFile[] {
  const cli = join(repoRoot(), "cli");
  const read = (rel: string): OrchFile => {
    try {
      return { dest: `${ORCH_DIR}/${rel}`, content: readFileSync(join(cli, rel), "utf8") };
    } catch (e) {
      throw new ForgeError(`cannot read cli/${rel}: ${(e as Error).message}`);
    }
  };
  const libs = ORCH_LIBS.flatMap((d) => readdirSync(join(cli, "lib", d)).filter((f) => f.endsWith(".ts")).sort()
    .map((f) => read(`lib/${d}/${f}`)));
  return [read("orchestrator.ts"), ...libs, { dest: ORCH_UNIT, content: orchestratorUnit(prefix) }];
}

// Pose l'orchestrateur et son unité quand le manifeste (sha256 des fichiers et
// de l'unité, comme installReferenceKit) a changé : daemon-reload, enable,
// restart, et rend vrai. Sinon rien n'est poussé : le service est seulement
// démarré s'il n'est pas actif. Le code appartient à root (0644, dossiers
// 0755) : forge-orch le lit sans pouvoir le changer.
export async function installOrchestrator(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<boolean> {
  const p = requireProject(cfg);
  // Tout est lu avant le moindre appel : un fichier manquant ne casse rien.
  const files = orchestratorFiles(p.tickets.prefix);
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.dest}\0${f.content}\0`);
  const manifest = `${hash.digest("hex")}\n`;
  await mustSucceed(`prepare ${ORCH_STATE}`, execArgv(ctx, m.name,
    ["install", "-d", "-o", ORCH_USER, "-g", ORCH_USER, "-m", "0700", ORCH_STATE]));
  const svc = (...argv: string[]) => mustSucceed(`systemctl ${argv[0]} ${ORCH_SERVICE}`, execArgv(ctx, m.name, ["systemctl", ...argv]));

  if ((await pullText(ctx, m.name, ORCH_MANIFEST)) === manifest) {
    if ((await orchestratorState(ctx, m.name)) !== "active") await svc("start", ORCH_SERVICE);
    return false;
  }
  ctx.out("Installing the orchestrator...");
  // Un fichier retiré du code doit disparaître du container ; les dossiers
  // d'abord, en root 0755 (--create-dirs ne fixe pas leur mode).
  await mustSucceed(`remove the old ${ORCH_DIR}`, execArgv(ctx, m.name, ["rm", "-rf", ORCH_DIR]));
  await mustSucceed(`create ${ORCH_DIR}`, execArgv(ctx, m.name,
    ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", ...ORCH_LIBS.map((d) => `${ORCH_DIR}/lib/${d}`)]));
  for (const f of files) {
    await mustSucceed(`push ${f.dest}`, pushText(ctx, m.name, f.dest, f.content, { uid: 0, gid: 0, mode: "644" }));
  }
  // Le manifeste en dernier : une pose interrompue se refait au prochain converge.
  await mustSucceed("push the orchestrator manifest", pushText(ctx, m.name, ORCH_MANIFEST, manifest, { uid: 0, gid: 0, mode: "644" }));
  await svc("daemon-reload");
  await svc("enable", ORCH_SERVICE);
  await svc("restart", ORCH_SERVICE);
  return true;
}

export type OrchestratorState = "active" | "failed" | "inactive" | "unknown";
const ORCH_STATES: readonly string[] = ["active", "failed", "inactive"];

// `systemctl is-active` dans le contrôle, avec un délai. Il sort en erreur pour
// un service inactif ou en échec mais en écrit l'état : seul stdout compte ;
// un délai dépassé, un container injoignable ou un autre état valent `unknown`.
export async function orchestratorState(ctx: Context, name: string, timeoutMs = 10_000): Promise<OrchestratorState> {
  const r = await ctx.exec(incus("exec", name, "--", "systemctl", "is-active", ORCH_SERVICE), { timeoutMs });
  if (r.timedOut) return "unknown";
  const state = r.stdout.trim();
  return ORCH_STATES.includes(state) ? state as OrchestratorState : "unknown";
}
