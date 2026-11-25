// Ce que forge pose dans un container de projet (le contrôle ou un exécuteur)
// et qu'une mise à jour de forge ou du kit change : les instructions
// (container/CLAUDE.md, plus le prompt du rôle), le .env, le lanceur, le canal
// d'API et forge-team, le hook, les réglages, le kit et les plugins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { execAsAgentArgv, incus, pullText, pushText } from "./incus.ts";
import { pushFile, requireHookBlocks } from "./commands/provision.ts";
import { repoRoot } from "./paths.ts";
import { CONTAINER_ENV_PATH, readEnvFile } from "./dotenv.ts";
import { ensureApiAccess, type SocketOwner } from "./api/access.ts";
import { installReferenceKit, type ReferenceKit } from "./reference-kit.ts";

const CLAUDE_MD = "/home/aiuser/.claude/CLAUDE.md";
// Le seul marché de plugins que forge sait ajouter ; un plugin `nom@autre` est
// refusé avant toute création.
const MARKETPLACES: Record<string, string> = {
  "claude-plugins-official": "https://github.com/anthropics/claude-plugins-official.git",
};

// Un container de projet, vu par ces aides : son nom, son mode de sortie, ses
// plugins, le prompt de son rôle, son .env (un chemin de l'hôte, `~/` résolu)
// et son kit de référence.
export type AgentFiles = {
  name: string; strict: boolean; plugins: string[];
  prompt: string | null; env: string | null; reference: ReferenceKit | null;
};

// Rend vrai quand les instructions, le .env ou le kit ont changé : une session
// déjà lancée ne les relit pas. `owner` : le propriétaire de la socket de l'API
// dans le container (aiuser dans un exécuteur, forge-orch dans le contrôle).
export async function installAgentFiles(ctx: Context, m: AgentFiles, owner: SocketOwner): Promise<{ instructionsChanged: boolean }> {
  ctx.out("Installing Claude instructions...");
  const rolePrompt = m.prompt === null ? "" : readPrompt(m);
  const instructions = readFileSync(join(repoRoot(), "container", "CLAUDE.md"), "utf8");
  const text = [instructions, rolePrompt].filter((p) => p !== "").join("\n");
  // Le .env, lu et vérifié avant que quoi que ce soit soit poussé.
  const env = m.env === null ? null : readEnvFile(m.env);
  const before = await pullText(ctx, m.name, CLAUDE_MD);
  await mustSucceed("push CLAUDE.md", pushText(ctx, m.name, CLAUDE_MD, text, { uid: 1001, gid: 1001, mode: "644" }));
  const envChanged = await installEnv(ctx, m, env);
  await pushFile(ctx, "push forge-agent", join(repoRoot(), "container", "forge-agent"),
    m.name, "/usr/local/bin/forge-agent", 0, "755");
  await ensureApiAccess(ctx, m.name, owner);

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

// Le .env : poussé (uid 1001, mode 600) quand le container en a un, retiré
// sinon, pour qu'une config qui perd son `env` perde ses variables au `converge`
// suivant. Rend vrai quand le fichier a changé : une session lancée ne le relit pas.
async function installEnv(ctx: Context, m: AgentFiles, env: string | null): Promise<boolean> {
  const before = await pullText(ctx, m.name, CONTAINER_ENV_PATH);
  if (env === null) {
    if (before === null) return false;
    await mustSucceed("remove the .env", execAsAgentArgv(ctx, m.name, ["rm", "-f", CONTAINER_ENV_PATH]));
    return true;
  }
  await mustSucceed("push the .env", pushText(ctx, m.name, CONTAINER_ENV_PATH, env, { uid: 1001, gid: 1001, mode: "600" }));
  return before !== env;
}

// container/settings.json, plus `enabledPlugins` quand il y a des plugins.
function settingsFor(m: AgentFiles): string {
  const base = JSON.parse(readFileSync(join(repoRoot(), "container", "settings.json"), "utf8")) as Record<string, unknown>;
  if (m.plugins.length > 0) base.enabledPlugins = Object.fromEntries(m.plugins.map((p) => [p, true]));
  // Un kit sans mémoire (l'exécuteur) : chaque mission part d'une session neuve.
  if (m.reference?.memory === false) base.autoMemoryEnabled = false;
  return `${JSON.stringify(base, null, 2)}\n`;
}

function marketplaceOf(plugin: string): string {
  return plugin.slice(plugin.indexOf("@") + 1);
}

export function requirePlugins(m: AgentFiles): void {
  for (const plugin of m.plugins) {
    if (!plugin.includes("@") || !(marketplaceOf(plugin) in MARKETPLACES)) {
      throw new ForgeError(
        `${m.name}: plugin ${plugin} is not <name>@<marketplace> with a marketplace forge knows (${Object.keys(MARKETPLACES).join(", ")}).`);
    }
  }
}

function readPrompt(m: AgentFiles): string {
  try {
    return readFileSync(m.prompt!, "utf8");
  } catch (e) {
    throw new ForgeError(`${m.name}: cannot read the prompt file ${m.prompt}: ${(e as Error).message}`);
  }
}

// En strict, un échec est un avertissement (GitHub n'est peut-être pas dans la
// liste blanche).
export async function installPlugins(ctx: Context, m: AgentFiles): Promise<void> {
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

function pluginFailure(ctx: Context, m: AgentFiles, stderr: string, code: number): void {
  const why = stderr.trim() || `exit code ${code}`;
  if (!m.strict) throw new ForgeError(`install Claude plugins in ${m.name} failed: ${why}`);
  ctx.err(`WARNING: installing the plugins of ${m.name} failed (strict mode: ${why}). Allow the GitHub group in the egress allowlist, run forge setup, then install them inside the container.`);
}
