// La clé `project` de la configuration (forge à tickets) : les dépôts du
// projet, ses exécuteurs, l'endroit des tickets. Validée à la main comme
// `teams` : une faute de frappe arrête forge avec le fichier et la clé.
import { configHelpers } from "./config-fields.ts";
import { bool, envPath, memory, plugins } from "./team-config.ts";
import { validateRepo } from "./validate.ts";
import { isTicketId } from "./tickets/model.ts";

export type ProjectConfig = {
  repositories: Record<string, { repo: string; lfs: boolean }>;
  executors: { count: number; memory: string | null; cpu: number | null; strict: boolean; plugins: string[]; env: string | null };
  tickets: { base: string; prefix: string };
  gitIdentity: { name: string; email: string } | null;
};

// Le nom d'un dépôt du projet : des mots [a-z0-9] séparés d'un tiret, le
// premier commençant par une lettre ; ni tiret final ni double tiret. Le même
// motif pour la config, l'API (missions.ts) et `forge upload-pack`.
export const REPO_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const DEFAULT_TICKETS_BASE = "~/.local/share/agent-forge/tickets";

export function parseProject(path: string, raw: unknown): ProjectConfig | null {
  if (raw === undefined || raw === null) return null;
  const { invalid, fields } = configHelpers(path);
  const p = fields(raw, "project", ["repositories", "executors", "tickets", "gitIdentity"]);

  const reposRaw = fields(p.repositories ?? {}, "project.repositories", Object.keys((p.repositories as object) ?? {}));
  const repositories: ProjectConfig["repositories"] = {};
  for (const [name, value] of Object.entries(reposRaw)) {
    const at = `project.repositories.${name}`;
    if (!REPO_NAME.test(name)) throw invalid(at, "a repository name such as web or api-2 ([a-z0-9], dashes)", name);
    const r = fields(value, at, ["repo", "lfs"]);
    if (typeof r.repo !== "string") throw invalid(`${at}.repo`, "an owner/repo string", r.repo);
    try {
      validateRepo(r.repo);
    } catch {
      throw invalid(`${at}.repo`, "owner/repo", r.repo);
    }
    repositories[name] = { repo: r.repo, lfs: bool(invalid, `${at}.lfs`, r.lfs) };
  }
  if (Object.keys(repositories).length === 0) {
    throw invalid("project.repositories", "an object with at least one repository", p.repositories);
  }

  const e = fields(p.executors, "project.executors", ["count", "memory", "cpu", "strict", "plugins", "env"]);
  if (typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 1 || e.count > 16) {
    throw invalid("project.executors.count", "an integer from 1 to 16", e.count);
  }
  if (e.cpu !== undefined && e.cpu !== null && (typeof e.cpu !== "number" || !Number.isInteger(e.cpu) || e.cpu < 1)) {
    throw invalid("project.executors.cpu", "null or a positive integer", e.cpu);
  }
  const executors = {
    count: e.count,
    memory: memory(invalid, "project.executors.memory", e.memory),
    cpu: (e.cpu as number | null | undefined) ?? null,
    strict: bool(invalid, "project.executors.strict", e.strict),
    plugins: plugins(invalid, "project.executors.plugins", e.plugins),
    env: envPath(invalid, "project.executors.env", e.env),
  };

  const t = fields(p.tickets ?? {}, "project.tickets", ["base", "prefix"]);
  const base = t.base ?? DEFAULT_TICKETS_BASE;
  if (typeof base !== "string" || !(base.startsWith("/") || base.startsWith("~/"))) {
    throw invalid("project.tickets.base", "an absolute path (or ~/…)", t.base);
  }
  const prefix = t.prefix ?? "T";
  if (typeof prefix !== "string" || !isTicketId(`${prefix}-1`)) {
    throw invalid("project.tickets.prefix", 'a ticket prefix such as "T" (the ticket id is <prefix>-<n>)', t.prefix);
  }

  let gitIdentity: ProjectConfig["gitIdentity"] = null;
  if (p.gitIdentity !== undefined && p.gitIdentity !== null) {
    const g = fields(p.gitIdentity, "project.gitIdentity", ["name", "email"]);
    for (const k of ["name", "email"] as const) {
      if (typeof g[k] !== "string" || g[k] === "") throw invalid(`project.gitIdentity.${k}`, "a non-empty string", g[k]);
    }
    gitIdentity = { name: g.name as string, email: g.email as string };
  }
  return { repositories, executors, tickets: { base, prefix }, gitIdentity };
}
