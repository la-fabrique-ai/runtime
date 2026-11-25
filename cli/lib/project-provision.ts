// Le provisioning des containers d'un projet (forge à tickets) : le container
// de contrôle, où l'orchestrateur tiendra la base des tickets, et les
// exécuteurs, qui ont un clone de chaque dépôt. Même parcours que
// provisionMember (team-provision.ts), dont il reprend les aides ; ce qui
// change : les clés `user.forge.role=executor|control` sans équipe, un clone
// par dépôt sous /workspace/<nom>, et le contrôle, qui n'a ni clone ni session
// dans la partie 1.
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { BASE_IMAGE, latestImageCommit, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY } from "./containers.ts";
import {
  configSet, configUnset, deleteInstance, deviceNames, execArgv, execAsAgent, execAsAgentArgv, forgeProject, incus, waitReady,
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
import { referenceKit, type Member, type ReferenceKit } from "./team.ts";
import { AIUSER_SOCKET, ORCH_SOCKET } from "./api/access.ts";
import { ensureRunning } from "./session.ts";
import { installMemberFiles, installPlugins, requirePlugins } from "./team-provision.ts";

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

// Le kit d'un exécuteur : celui du développeur de référence, plus le sous-agent
// qui relit une branche. Construit ici plutôt que dans roles.json, que la partie
// 1d renomme.
export function executorKit(): ReferenceKit {
  const dev = referenceKit("dev");
  return { ...dev, agents: [...new Set([...dev.agents, "branch-reviewer"])] };
}

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

// Un container de projet vu comme un membre, pour les aides de team-provision
// (instructions, hook, réglages, kit, plugins) : ni équipe, ni dépôt unique, ni
// correspondant ; son canal d'API est posé à part (installMemberFiles, `api`).
function asMember(p: ProjectConfig, m: ProjectMember): Member {
  const executor = m.kind === "executor";
  const e = p.executors;
  return {
    name: m.name, team: null, role: m.kind, index: m.index, repo: null, capabilities: [], talkTo: [],
    strict: executor && e.strict, memory: executor ? e.memory : null, cpu: executor ? e.cpu : null,
    plugins: executor ? e.plugins : [], prompt: null, env: executor && e.env !== null ? hostPath(e.env) : null,
    lfs: false, reference: executor ? executorKit() : null, designs: {},
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

async function pushAgentState(ctx: Context, name: string): Promise<void> {
  await pushClaudeToken(ctx, name);
  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    name, "/home/aiuser/.claude.json", 1001, "600");
}

// `workspace` : le marqueur du workspace a été posé au lancement (exécuteur).
async function finish(ctx: Context, m: Member, workspace: boolean): Promise<void> {
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
  const member = asMember(p, m);
  // Préconditions, toutes vérifiées avant de rien créer.
  requireClaudeToken();
  requirePlugins(member);
  const identity = p.gitIdentity ?? await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  if (Object.values(p.repositories).some((r) => r.lfs)) await requireHostLfs(ctx);
  const plan = member.strict ? await requireStrictRuntime(ctx) : null;
  // Les miroirs (SSH, agent de l'humain) avant le lancement, comme provisionMember.
  await ensureRepoMirrors(ctx, p);

  const workspaceDir = join(workspacesDir(), m.name);
  const reuse = existsSync(workspaceDir) && readdirSync(workspaceDir).length > 0;
  const keys = [
    "-c", `${PROVISIONING_KEY}=${m.name}`,
    "-c", `${PROVISIONING_WORKSPACE_KEY}=${reuse ? "kept" : "new"}`,
    "-c", "user.forge.role=executor",
  ];
  if (member.memory !== null) keys.push("-c", `limits.memory=${member.memory}`);
  if (member.cpu !== null) keys.push("-c", `limits.cpu=${member.cpu}`);
  await launch(ctx, m.name, keys, plan ? strictLaunchArgs(plan, egressNames(forgeProject())) : []);
  if (plan) await applyStrictSettings(ctx, m.name, plan);

  mkdirSync(workspaceDir, { recursive: true });
  ctx.out("Mounting the workspace...");
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", m.name, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));
  await ensureExecutorRepos(ctx, p, m.name);
  await configureGit(ctx, m.name, identity);
  await pushAgentState(ctx, m.name);
  await installMemberFiles(ctx, member, { owner: AIUSER_SOCKET });
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
  return installMemberFiles(ctx, asMember(p, m), { owner: AIUSER_SOCKET });
}

// Les filtres LFS globaux d'aiuser : avec le smudge dès qu'un dépôt lit ses
// objets LFS (chaque clone règle ensuite le sien, `--local`).
const lfsFilters = (p: ProjectConfig) => (Object.values(p.repositories).some((r) => r.lfs) ? LFS_FILTERS_READ : LFS_FILTERS_INSTALL);

// Idempotent : les filtres LFS globaux, puis par dépôt les deux devices s'ils
// manquent, le clone s'il manque, et à chaque passage le remote `team` et
// l'exclusion du journal d'audit, qu'un clone interrompu après coup n'aurait pas.
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
    // Le hook écrit son journal d'audit dans <cwd>/.claude : sans cette
    // exclusion, un clone neuf paraîtrait sale. `repo` suit [a-z][a-z0-9-]*.
    await mustSucceed("audit log exclude", execAsAgent(ctx, name,
      `cd ${dir} && { grep -qxF '/.claude/bash-audit.log' .git/info/exclude || echo '/.claude/bash-audit.log' >> .git/info/exclude; }`));
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
  const member = asMember(p, m);
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
  await installMemberFiles(ctx, member, { owner: ORCH_SOCKET });
  await finish(ctx, member, false);
}

// Le contrôle déjà là : l'image, la base des tickets (droits et ACL reposés à
// chaque fois) et ses fichiers.
export async function convergeControl(ctx: Context, cfg: ForgeConfig, m: ProjectMember): Promise<{ instructionsChanged: boolean }> {
  const p = requireProject(cfg);
  ticketsBase(p);
  await ensureRunning(ctx, m.name);
  await requireOrchestratorImage(ctx, m.name);
  await ensureTicketBase(ctx, p, m.name);
  return installMemberFiles(ctx, asMember(p, m), { owner: ORCH_SOCKET });
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
