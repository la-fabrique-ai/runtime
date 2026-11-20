// The members of the configured teams: one container per agent, named after
// its team, role and index, with the `talkTo` lists resolved to container
// names. Pure functions: nothing here touches Incus.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeConfig } from "./config.ts";
import { ForgeError } from "./context.ts";
import type { Capability } from "./team-config.ts";
import { forgeHome, repoRoot } from "./paths.ts";
import { validateContainerName } from "./validate.ts";

export const PILOT = "agent-pilot";
const MAX_NAME = 63;

export type Member = {
  name: string; team: string | null; role: string; index: number | null; repo: string | null;
  capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null; cpu: number | null;
  plugins: string[]; prompt: string | null;
  env: string | null; // the role's .env, as an expanded host path
  lfs: boolean; // the role's `lfs`; always false for the Pilot
  reference: ReferenceKit | null; // le kit d'un rôle de référence, null pour un prompt personnalisé
  designs: Record<string, string>; // équipe → `designs` : la sienne pour un membre, toutes pour le Pilote
};

// Ce qu'un rôle de référence reçoit en plus de son prompt (teams/reference/roles.json).
export type ReferenceKit = { skills: string[]; agents: string[]; memory: boolean };

// The reference team shipped in the repository (teams/reference): opt-in, with
// `"prompts": "reference"` on a team and `"prompt": "reference"` on the Pilot.
export const REFERENCE_PROMPTS = join(repoRoot(), "teams", "reference", "prompts");

// Lu à l'appel, pas au chargement : les tests pointent FORGE_REPO_DIR ailleurs.
export function referenceDir(): string {
  return join(repoRoot(), "teams", "reference");
}

function referenceRoles(): Record<string, ReferenceKit> {
  return JSON.parse(readFileSync(join(referenceDir(), "roles.json"), "utf8")) as Record<string, ReferenceKit>;
}

export function referenceKit(role: string): ReferenceKit {
  const roles = referenceRoles();
  if (!roles[role]) throw new ForgeError(`no reference kit for role ${role} (known: ${Object.keys(roles).join(", ")})`);
  return roles[role];
}

// Les rôles d'une équipe de référence : ceux de roles.json, hors le Pilote.
const referenceRoleNames = (): string[] => Object.keys(referenceRoles()).filter((r) => r !== "pilot").sort();

function rolePrompt(prompts: string | null, role: string): string | null {
  if (prompts === null) return null;
  if (prompts !== "reference") return `${prompts}/${role}.md`;
  const known = referenceRoleNames();
  if (!known.includes(role)) {
    throw new ForgeError(`no reference prompt for role ${role} (reference roles: ${known.join(", ")})`);
  }
  return join(REFERENCE_PROMPTS, `${role}.md`);
}

const hostPath = (p: string | null): string | null => (p !== null && p.startsWith("~/") ? join(forgeHome(), p.slice(2)) : p);

// Pilot first, then the teams in key order, the roles in key order.
export function members(cfg: ForgeConfig): Member[] {
  const out: Member[] = [];
  const all = (team: string) => out.filter((m) => m.team === team);
  if (cfg.pilot) {
    out.push({
      name: PILOT, team: null, role: "pilot", index: null, repo: null, capabilities: cfg.pilot.capabilities,
      talkTo: [], strict: cfg.pilot.strict, memory: cfg.pilot.memory, cpu: null, plugins: cfg.pilot.plugins,
      prompt: cfg.pilot.prompt === "reference" ? join(REFERENCE_PROMPTS, "pilot.md") : cfg.pilot.prompt, env: hostPath(cfg.pilot.env),
      lfs: false,
      reference: cfg.pilot.prompt === "reference" ? referenceKit("pilot") : null,
      designs: Object.fromEntries(Object.entries(cfg.teams).flatMap(([t, c]) => c.designs === null ? [] : [[t, c.designs]])),
    });
  }
  for (const [team, t] of Object.entries(cfg.teams)) {
    for (const [role, r] of Object.entries(t.roles)) {
      const indexes: (number | null)[] = r.count === null ? [null] : Array.from({ length: r.count }, (_, i) => i + 1);
      for (const index of indexes) {
        const name = `agent-${team}-${role}${index === null ? "" : `-${index}`}`;
        if (name.length > MAX_NAME) throw new ForgeError(`container name ${name} is longer than ${MAX_NAME} characters: shorten the team or role name`);
        validateContainerName(name);
        out.push({
          name, team, role, index, repo: r.capabilities.includes("repo") ? t.repo : null,
          capabilities: r.capabilities, talkTo: [], strict: r.strict, memory: r.memory, cpu: r.cpu,
          plugins: r.plugins, prompt: rolePrompt(t.prompts, role), env: hostPath(r.env), lfs: r.lfs,
          reference: t.prompts === "reference" ? referenceKit(role) : null,
          designs: t.designs === null ? {} : { [team]: t.designs },
        });
      }
    }
  }
  // talkTo is resolved once every member exists: a role word means every
  // container of that role, `team` every other member of the team, `pilot` the
  // Pilot; for the Pilot, a team name means that team's leads.
  const configured = (m: Member) => m.team === null ? cfg.pilot!.talkTo : cfg.teams[m.team].roles[m.role].talkTo;
  for (const m of out) {
    const names: string[] = [];
    for (const word of configured(m)) {
      if (m.team === null) names.push(...all(word).filter((x) => x.role === "lead").map((x) => x.name));
      else if (word === "pilot") { if (cfg.pilot) names.push(PILOT); }
      else if (word === "team") names.push(...all(m.team).map((x) => x.name));
      else names.push(...all(m.team).filter((x) => x.role === word).map((x) => x.name));
    }
    m.talkTo = [...new Set(names)].filter((n) => n !== m.name);
  }
  return out;
}

// Whether the team's origin mirror must hold the LFS objects: a container of
// the team reads them from it. The mirror is shared, the reading is per role.
export function teamWantsLfs(cfg: ForgeConfig, team: string): boolean {
  return Object.values(cfg.teams[team]?.roles ?? {}).some((r) => r.lfs);
}

export function memberNamed(cfg: ForgeConfig, name: string): Member {
  const all = members(cfg);
  const found = all.find((m) => m.name === name);
  if (!found) throw new ForgeError(`${name} is not declared in the config (declared: ${all.map((m) => m.name).join(", ") || "none"})`);
  return found;
}
