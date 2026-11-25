// Provisioning d'un membre d'équipe (DX 5, §5.2) : le même parcours que
// provisionContainer, sans ce qui est propre à une tâche (ni worktree, ni
// `.trees/`), plus ce qui est propre à un membre : ses capacités (clone et
// miroir `origin` pour `repo`, miroir d'équipe pour `read-team`), ses limites,
// ses marqueurs `user.forge.*` et ses plugins. Le container a son propre hc
// (dans l'image) : forge n'y lance une session qu'à l'assignation d'une tâche.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import {
  BASE_IMAGE, latestImageCommit, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY,
} from "./containers.ts";
import { configSet, configUnset, deviceNames, execAsAgent, execAsAgentArgv, forgeProject, incus, pullText, pushText, waitReady } from "./incus.ts";
import {
  cloneWorkspace, ensureMirror, ensureTeamMirror, fetchMirrorLfs, MIRROR_MOUNT, mirrorRepo, ORIGIN_DEVICE, pointOriginAtMirror,
  originMirrorPath, requireMirrorOf, TEAM_DEVICE, TEAM_MOUNT, teamMirrorPath,
} from "./mirror.ts";
import {
  hostGitIdentity, LFS_FILTERS_INSTALL, LFS_FILTERS_READ, LFS_HOOKS_INSTALL, LFS_HOOKS_READ, pushClaudeToken, pushFile, refreshClaude,
  requireClaudeToken, requireHookBlocks, requireHostLfs, requireRuntime, workspaceIsReusable,
} from "./commands/provision.ts";
import { egressNames, PROFILE } from "./objects.ts";
import { memoriesDir, repoRoot, workspacesDir } from "./paths.ts";
import { applyStrictSettings, requireStrictRuntime, strictLaunchArgs } from "./strict.ts";
import type { Member } from "./team.ts";
import { CONTAINER_ENV_PATH, readEnvFile } from "./dotenv.ts";
import { ensureApiAccess, type SocketOwner } from "./api/access.ts";
import { ensurePilotRepos } from "./pilot-repos.ts";
import { installReferenceKit } from "./reference-kit.ts";

const MODE = "supervised";
const CLAUDE_MD = "/home/aiuser/.claude/CLAUDE.md";
// Le seul marché de plugins que forge sait ajouter (comme Superpowers l'était
// avant la partie 1a) ; un plugin `nom@autre` est refusé avant toute création.
const MARKETPLACES: Record<string, string> = {
  "claude-plugins-official": "https://github.com/anthropics/claude-plugins-official.git",
};

// Les deux miroirs d'une équipe se nomment d'après elle : l'origine de son
// dépôt (comme celui d'un container, mais partagé par ses membres) et le miroir
// des branches des développeurs (teamMirrorPath).
export { originMirrorPath };

export { ensureTeamMirror, teamMirrorPath };

export async function provisionMember(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void> {
  const team = m.team === null ? null : cfg.teams[m.team];
  // Préconditions, toutes vérifiées avant de rien créer.
  requireClaudeToken();
  requirePlugins(m);
  if (m.prompt !== null) readPrompt(m); // lisible avant de rien créer
  const identity = team?.gitIdentity ?? await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  if (m.lfs) await requireHostLfs(ctx);
  const plan = m.strict ? await requireStrictRuntime(ctx) : null;
  const readTeam = m.capabilities.includes("read-team");
  const workspaceDir = join(workspacesDir(), m.name);

  // Le miroir `origin` de l'équipe : créé (SSH, agent de l'humain) avant le
  // lancement, comme provisionContainer.
  const origin = m.repo !== null && m.team !== null ? originMirrorPath(m.team) : null;
  let reuseWorkspace: boolean;
  if (origin !== null && m.repo !== null) {
    const existing = await mirrorRepo(ctx, origin);
    if (existsSync(origin)) requireMirrorOf(origin, m.repo, existing);
    reuseWorkspace = workspaceIsReusable(workspaceDir, origin, m.repo, existing);
    ctx.out(existsSync(origin) ? `Reusing the team mirror ${origin}...` : `Fetching ${m.repo} into the team mirror...`);
    await ensureMirror(ctx, origin, m.repo);
    // A container that reads LFS content needs the objects in the mirror before
    // it clones: without them it would hold pointers, so a failure stops here.
    // The other members of the team leave the refresh to `forge team sync`.
    if (m.lfs) {
      ctx.out(`Fetching the LFS objects of ${m.repo} into the team mirror...`);
      const lfs = await fetchMirrorLfs(ctx, origin, m.repo);
      if (lfs.code !== 0) {
        throw new ForgeError(`fetching the LFS objects failed: ${lfs.stderr.trim() || `exit code ${lfs.code}`}\n` +
          "Did your SSH agent reach the host? Run forge team up from your machine: it forwards the agent.");
      }
      if (lfs.warning) ctx.err(`WARNING: ${lfs.warning}`);
    }
  } else {
    reuseWorkspace = existsSync(workspaceDir) && readdirSync(workspaceDir).length > 0;
  }
  if (readTeam && m.team !== null) await ensureTeamMirror(ctx, m.team);

  ctx.out(`Creating container ${m.name}...`);
  const keys: string[] = [
    "-c", `${PROVISIONING_KEY}=${m.repo ?? m.name}`,
    "-c", `${PROVISIONING_WORKSPACE_KEY}=${reuseWorkspace ? "kept" : "new"}`,
    "-c", `user.forge.role=${m.role}`,
  ];
  if (m.team !== null) keys.push("-c", `user.forge.team=${m.team}`);
  if (m.repo !== null) keys.push("-c", `user.forge.repo=${m.repo}`);
  // What converge compares with the role later: the clone is made once.
  keys.push("-c", `user.forge.lfs=${m.lfs}`);
  if (m.memory !== null) keys.push("-c", `limits.memory=${m.memory}`);
  if (m.cpu !== null) keys.push("-c", `limits.cpu=${m.cpu}`);
  const strictArgs = plan ? strictLaunchArgs(plan, egressNames(forgeProject())) : [];
  await mustSucceed("incus launch", ctx.exec(incus("launch", BASE_IMAGE, m.name, "--profile", PROFILE, ...keys, ...strictArgs)));
  await waitReady(ctx, m.name);
  if (plan) await applyStrictSettings(ctx, m.name, plan);

  mkdirSync(workspaceDir, { recursive: true });
  ctx.out("Mounting the mirrors and the workspace...");
  if (origin !== null) {
    await mustSucceed("mount mirror", ctx.exec(incus("config", "device", "add", m.name, ORIGIN_DEVICE, "disk",
      `source=${origin}`, `path=${MIRROR_MOUNT}`, "readonly=true")));
  }
  if (readTeam && m.team !== null) {
    await mustSucceed("mount team mirror", ctx.exec(incus("config", "device", "add", m.name, TEAM_DEVICE, "disk",
      `source=${teamMirrorPath(m.team)}`, `path=${TEAM_MOUNT}`, "readonly=true")));
  }
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", m.name, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));
  await ensureMemberMounts(ctx, cfg, m);

  if (origin !== null) {
    if (reuseWorkspace) {
      ctx.out(`Reusing the existing clone in ${workspaceDir}...`);
      await mustSucceed("realign origin remote", pointOriginAtMirror(ctx, m.name, m.lfs));
    } else {
      ctx.out(`Cloning ${m.repo} in the container...`);
      // The filters come first, without the skip: the clone smudges from the mirror.
      if (m.lfs) await mustSucceed(`git-lfs filters in ${m.name}`, execAsAgent(ctx, m.name, LFS_FILTERS_READ));
      await mustSucceed("clone repository", cloneWorkspace(ctx, m.name, m.lfs));
    }
  }

  if (origin !== null) {
    // Le hook écrit son journal d'audit dans /workspace/.claude : sans cette
    // exclusion, un clone neuf paraîtrait sale à l'assignation d'une tâche.
    await mustSucceed("audit log exclude", execAsAgent(ctx, m.name,
      "cd /workspace && { grep -qxF '/.claude/bash-audit.log' .git/info/exclude || echo '/.claude/bash-audit.log' >> .git/info/exclude; }"));
  }

  ctx.out("Configuring git (the team's identity, unsigned commits)...");
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email], ["commit.gpgsign", "false"]]) {
    await mustSucceed(`git config ${key}`, execAsAgentArgv(ctx, m.name, ["git", "config", "--global", key, value]));
  }
  if (readTeam && origin !== null) {
    // Un clone réutilisé peut déjà avoir le remote : `add` échoue alors, on le réaligne.
    const add = await execAsAgentArgv(ctx, m.name, ["git", "-C", "/workspace", "remote", "add", "team", TEAM_MOUNT]);
    if (add.code !== 0) {
      await mustSucceed("realign team remote",
        execAsAgentArgv(ctx, m.name, ["git", "-C", "/workspace", "remote", "set-url", "team", TEAM_MOUNT]));
    }
  }

  await pushClaudeToken(ctx, m.name);
  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    m.name, "/home/aiuser/.claude.json", 1001, "600");

  await installMemberFiles(ctx, m);

  await refreshClaude(ctx, m.name, m.strict);
  await installPlugins(ctx, m);

  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, m.name, `echo '${MODE}' > /home/aiuser/.claude/forge-mode`));
  await mustSucceed("record forge mode", configSet(ctx, m.name, "user.forge.mode", MODE));

  ctx.out("Installing git-lfs filters...");
  await mustSucceed(`git-lfs filters in ${m.name}`, execAsAgent(ctx, m.name, m.lfs ? LFS_FILTERS_READ : LFS_FILTERS_INSTALL));
  if (origin !== null) {
    const hooks = await execAsAgent(ctx, m.name, `cd /workspace && ${m.lfs ? LFS_HOOKS_READ : LFS_HOOKS_INSTALL}`);
    if (hooks.code !== 0) {
      ctx.err(`WARNING: installing git-lfs hooks in /workspace failed: ${hooks.stderr.trim() || `exit code ${hooks.code}`}`);
    }
    // A workspace made before `lfs` was on holds pointers: forge fetches the
    // content now (`git lfs pull` never overwrites a modified file).
    if (m.lfs && reuseWorkspace) {
      ctx.out("Pulling the LFS files into the reused workspace...");
      const pull = await execAsAgent(ctx, m.name, "cd /workspace && git lfs pull");
      if (pull.code !== 0) {
        ctx.err(`WARNING: git lfs pull in /workspace failed, its LFS files may stay pointers: ${pull.stderr.trim() || `exit code ${pull.code}`}`);
      }
    }
  }

  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit", configSet(ctx, m.name, "user.forge.image_commit", await latestImageCommit(ctx)));
  ctx.out("Recording forge metadata...");
  await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_KEY));
  await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_WORKSPACE_KEY));
  ctx.out(`Container ${m.name} provisioned.`);
}

// Les montages et clones qui dépendent de la config d'un membre et qui s'ajoutent
// après sa création : `provisionMember` l'appelle pour un container neuf,
// `converge` pour un container déjà là.
export async function ensureMemberMounts(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void> {
  await ensurePilotRepos(ctx, cfg, m);
  await ensureMemory(ctx, m);
}

// Où Claude Code garde sa mémoire automatique dans le container.
export const MEMORY_PATH = "/home/aiuser/.claude/projects/-workspace/memory";
export const MEMORY_DEVICE = "memory";

// Le Pilote et le Lead de référence ont une mémoire sur l'hôte, qui survit au
// container. Incus crée en root le parent manquant du chemin d'un device : on crée
// d'abord le dossier du projet en aiuser, sinon Claude Code ne pourrait plus y
// écrire ses transcripts.
async function ensureMemory(ctx: Context, m: Member): Promise<void> {
  if (m.reference?.memory !== true) return;
  const source = join(memoriesDir(), m.name);
  mkdirSync(source, { recursive: true });
  if ((await deviceNames(ctx, m.name)).includes(MEMORY_DEVICE)) return;
  ctx.out(`Mounting ${m.name}'s memory from ${source}...`);
  await mustSucceed("create the memory parent",
    execAsAgentArgv(ctx, m.name, ["mkdir", "-p", dirname(MEMORY_PATH)]));
  await mustSucceed("mount the memory", ctx.exec(incus("config", "device", "add", m.name,
    MEMORY_DEVICE, "disk", `source=${source}`, `path=${MEMORY_PATH}`)));
}

// Ce que forge pose dans un membre et qu'une mise à jour de forge ou du prompt
// d'un rôle change : les instructions (avec le prompt du rôle), le lanceur, le
// canal d'API et forge-team, le hook et les réglages. `provisionMember` l'appelle
// pour un container neuf, `converge` pour un container déjà là. Rend vrai quand
// les instructions ont changé : une session déjà lancée ne les relit pas.
// `api` : le canal d'un container de projet (exécuteur ou contrôle), toujours
// posé, avec le propriétaire de sa socket et le fichier d'instructions de
// container/ qu'il reçoit (CLAUDE.md par défaut) ; sans lui, needsApi tranche.
export async function installMemberFiles(
  ctx: Context, m: Member, api: { owner: SocketOwner; instructions?: string } | null = null,
): Promise<{ instructionsChanged: boolean }> {
  ctx.out("Installing Claude team instructions...");
  const rolePrompt = m.prompt === null ? "" : readPrompt(m);
  const instructions = readFileSync(join(repoRoot(), "container", api?.instructions ?? "CLAUDE.md"), "utf8");
  const text = [instructions, rolePrompt, designsNote(m)].filter((p) => p !== "").join("\n");
  // Le .env du rôle, lu et vérifié avant que quoi que ce soit soit poussé.
  const env = m.env === null ? null : readEnvFile(m.env);
  const before = await pullText(ctx, m.name, CLAUDE_MD);
  await mustSucceed("push CLAUDE.md", pushText(ctx, m.name, CLAUDE_MD, text, { uid: 1001, gid: 1001, mode: "644" }));
  const envChanged = await installEnv(ctx, m, env);
  await pushFile(ctx, "push forge-agent", join(repoRoot(), "container", "forge-agent"),
    m.name, "/usr/local/bin/forge-agent", 0, "755");
  if (api === null) await ensureApiAccess(ctx, m);
  else await ensureApiAccess(ctx, { name: m.name, api: true }, api.owner);

  // Le hook et les réglages appartiennent à root : l'agent ne peut pas les
  // réécrire en place.
  ctx.out("Installing Claude security hooks...");
  await mustSucceed("create hooks directory",
    ctx.exec(incus("exec", m.name, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks")));
  await pushFile(ctx, "push pre-bash.sh", join(repoRoot(), "container", "pre-bash.sh"),
    m.name, "/home/aiuser/.claude/hooks/pre-bash.sh", 0, "755");
  await mustSucceed("push Claude settings",
    pushText(ctx, m.name, "/home/aiuser/.claude/settings.json", settingsFor(m), { uid: 0, gid: 0, mode: "644" }));
  await requireHookBlocks(ctx, m.name);
  const kitChanged = await installReferenceKit(ctx, m);
  return { instructionsChanged: before !== text || envChanged || kitChanged };
}

// Où le dépôt de l'équipe versionne ses designs (teams.<équipe>.designs), à la
// fin des instructions : un membre lit celui de son équipe, le Pilote celui de
// chaque équipe. Sans la clé, rien : les designs restent chez le Pilote.
function designsNote(m: Member): string {
  const entries = Object.entries(m.designs);
  if (entries.length === 0) return "";
  if (m.team !== null) {
    return "## Designs de l'équipe\n" +
      `Le dépôt versionne ses designs sous \`${entries[0][1]}\` : la première sous-tâche d'une demande y commite ` +
      "le design du Pilote. Ceux qui y sont déjà donnent le contexte des demandes passées.\n";
  }
  return "## Designs des équipes\n" +
    "Ces dépôts versionnent leurs designs, et la première sous-tâche d'une demande y commite le tien. " +
    "Avant d'écrire un design, relis ceux qui touchent la demande " +
    "(sous `/workspace/depots/<équipe>/<chemin>`, si tu as `read-repos`) :\n" +
    entries.map(([team, path]) => `- \`${team}\` : \`${path}\`\n`).join("");
}

// Le .env du rôle : poussé (uid 1001, mode 600) quand le membre en a un, retiré
// sinon, pour qu'un rôle qui perd son `env` perde ses variables au `converge`
// suivant. Rend vrai quand le fichier a changé : une session lancée ne le relit pas.
async function installEnv(ctx: Context, m: Member, env: string | null): Promise<boolean> {
  const before = await pullText(ctx, m.name, CONTAINER_ENV_PATH);
  if (env === null) {
    if (before === null) return false;
    await mustSucceed("remove the .env", execAsAgentArgv(ctx, m.name, ["rm", "-f", CONTAINER_ENV_PATH]));
    return true;
  }
  await mustSucceed("push the .env", pushText(ctx, m.name, CONTAINER_ENV_PATH, env, { uid: 1001, gid: 1001, mode: "600" }));
  return before !== env;
}

// container/settings.json, plus `enabledPlugins` quand le rôle a des plugins.
function settingsFor(m: Member): string {
  const base = JSON.parse(readFileSync(join(repoRoot(), "container", "settings.json"), "utf8")) as Record<string, unknown>;
  if (m.plugins.length > 0) base.enabledPlugins = Object.fromEntries(m.plugins.map((p) => [p, true]));
  // Les développeurs et le Reviewer de référence n'ont pas de mémoire.
  if (m.reference?.memory === false) base.autoMemoryEnabled = false;
  return `${JSON.stringify(base, null, 2)}\n`;
}

function marketplaceOf(plugin: string): string {
  return plugin.slice(plugin.indexOf("@") + 1);
}

export function requirePlugins(m: Member): void {
  for (const plugin of m.plugins) {
    if (!plugin.includes("@") || !(marketplaceOf(plugin) in MARKETPLACES)) {
      throw new ForgeError(
        `${m.name}: plugin ${plugin} is not <name>@<marketplace> with a marketplace forge knows (${Object.keys(MARKETPLACES).join(", ")}).`);
    }
  }
}

function readPrompt(m: Member): string {
  try {
    return readFileSync(m.prompt!, "utf8");
  } catch (e) {
    throw new ForgeError(`${m.name}: cannot read the prompt file ${m.prompt}: ${(e as Error).message}`);
  }
}

// Comme Superpowers l'était avant la partie 1a : en strict, un échec est un
// avertissement (GitHub n'est peut-être pas dans la liste blanche).
export async function installPlugins(ctx: Context, m: Member): Promise<void> {
  if (m.plugins.length === 0) return;
  ctx.out("Installing Claude plugins...");
  for (const market of new Set(m.plugins.map(marketplaceOf))) {
    const added = await execAsAgentArgv(ctx, m.name, ["claude", "plugin", "marketplace", "add", MARKETPLACES[market]]);
    if (added.code !== 0) return pluginFailure(ctx, m, added.stderr, added.code);
  }
  for (const plugin of m.plugins) {
    const r = await execAsAgentArgv(ctx, m.name, ["claude", "plugin", "install", plugin]);
    if (r.code !== 0) return pluginFailure(ctx, m, r.stderr, r.code);
  }
}

function pluginFailure(ctx: Context, m: Member, stderr: string, code: number): void {
  const why = stderr.trim() || `exit code ${code}`;
  if (!m.strict) throw new ForgeError(`install Claude plugins in ${m.name} failed: ${why}`);
  ctx.err(`WARNING: installing the plugins of ${m.name} failed (strict mode: ${why}). Allow the GitHub group in the egress allowlist, run forge setup, then install them inside the container.`);
}
