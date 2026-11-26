// Les noms et les miroirs d'un projet (forge à tickets) : un container de
// contrôle, N exécuteurs, et par dépôt deux miroirs nus sur l'hôte (l'origine,
// copie de GitHub, et celui des branches des agents).
import { join } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { ensureBareTeamMirror, ensureMirror, fetchMirrorLfs } from "./mirror.ts";
import { mirrorPath, mirrorsDir } from "./paths.ts";
import type { ProjectConfig } from "./project-config.ts";
import { validateContainerName } from "./validate.ts";

export const CONTROL = "agent-control";

export function executorName(n: number): string {
  const name = `agent-executor-${n}`;
  validateContainerName(name);
  return name;
}

export type ProjectMember = { name: string; kind: "control" | "executor"; index: number | null };

// Le contrôle d'abord, puis les exécuteurs de 1 à count.
export function projectMembers(p: ProjectConfig): ProjectMember[] {
  const members: ProjectMember[] = [{ name: CONTROL, kind: "control", index: null }];
  for (let n = 1; n <= p.executors.count; n++) members.push({ name: executorName(n), kind: "executor", index: n });
  return members;
}

// Le membre du projet de ce nom ; refusé quand la config n'a pas de projet ou
// ne le déclare pas (forge-proxy, un container d'un autre usage).
export function projectMemberNamed(p: ProjectConfig | null, name: string): ProjectMember {
  const all = p === null ? [] : projectMembers(p);
  const found = all.find((m) => m.name === name);
  if (!found) throw new ForgeError(`${name} is not a container of the project (declared: ${all.map((m) => m.name).join(", ") || "none"})`);
  return found;
}

export const repoOriginMirror = (name: string) => mirrorPath(`repo-${name}`);
export const repoTeamMirror = (name: string) => join(mirrorsDir(), `repo-${name}.agents.git`);

// Pour chaque dépôt : le miroir d'origine (cloné depuis GitHub par l'agent SSH
// transmis, avec les objets LFS quand `lfs`) puis le miroir des agents. Git ne
// tourne que sur les miroirs, jamais dans un clone.
export async function ensureRepoMirrors(ctx: Context, p: ProjectConfig): Promise<void> {
  for (const [name, { repo, lfs }] of Object.entries(p.repositories)) {
    const origin = repoOriginMirror(name);
    await ensureMirror(ctx, origin, repo);
    if (lfs) {
      const r = await fetchMirrorLfs(ctx, origin, repo);
      if (r.code !== 0) throw new ForgeError(`fetch LFS objects of ${repo} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
    }
    await ensureBareTeamMirror(ctx, repoTeamMirror(name));
  }
}
