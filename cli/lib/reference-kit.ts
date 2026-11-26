import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { execAsAgentArgv, pullText, pushText } from "./incus.ts";
import { repoRoot } from "./paths.ts";

export const SKILLS_DIR = "/home/aiuser/.claude/skills";
export const AGENTS_DIR = "/home/aiuser/.claude/agents";
// Le manifeste vit dans SKILLS_DIR : il disparaît avec les skills qu'il décrit.
export const KIT_MANIFEST = "/home/aiuser/.claude/skills/.forge-kit";

// Ce qu'un rôle de référence reçoit en plus de son prompt (teams/reference/roles.json).
export type ReferenceKit = { skills: string[]; agents: string[]; memory: boolean };

// Lu à l'appel, pas au chargement : les tests pointent FORGE_REPO_DIR ailleurs.
export function referenceDir(): string {
  return join(repoRoot(), "teams", "reference");
}

export function referenceKit(role: string): ReferenceKit {
  const roles = JSON.parse(readFileSync(join(referenceDir(), "roles.json"), "utf8")) as Record<string, ReferenceKit>;
  if (!roles[role]) throw new ForgeError(`no reference kit for role ${role} (known: ${Object.keys(roles).join(", ")})`);
  return roles[role];
}

type KitFile = { rel: string; dest: string; content: string };

function readKitFile(rel: string, dest: string): KitFile {
  const path = join(referenceDir(), rel);
  try {
    return { rel, dest, content: readFileSync(path, "utf8") };
  } catch (e) {
    throw new ForgeError(`cannot read teams/reference/${rel}: ${(e as Error).message}`);
  }
}

// Pose les skills et les sous-agents d'un container qui a un kit de référence.
// Rend vrai quand il a poussé (une session lancée ne relit pas ses skills).
export async function installReferenceKit(ctx: Context, m: { name: string; reference: ReferenceKit | null }): Promise<boolean> {
  if (m.reference === null) return false;
  // Tout est lu avant le moindre appel : un fichier manquant n'efface rien.
  const files = [
    ...m.reference.skills.map((s) => readKitFile(`skills/${s}/SKILL.md`, `${SKILLS_DIR}/${s}/SKILL.md`)),
    ...m.reference.agents.map((a) => readKitFile(`agents/${a}.md`, `${AGENTS_DIR}/${a}.md`)),
  ];
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) hash.update(`${f.rel}\0${f.content}\0`);
  const manifest = `${hash.digest("hex")}\n`;
  if ((await pullText(ctx, m.name, KIT_MANIFEST)) === manifest) return false;

  ctx.out("Installing the reference skills and sub-agents...");
  // Un skill retiré du kit doit disparaître du container.
  await mustSucceed("remove the old skills and sub-agents",
    execAsAgentArgv(ctx, m.name, ["rm", "-rf", SKILLS_DIR, AGENTS_DIR]));
  // Les dossiers d'abord, en aiuser : si Incus les créait en root en poussant, la
  // suppression en aiuser du prochain changement du kit échouerait.
  const dirs = [...new Set([SKILLS_DIR, AGENTS_DIR, ...files.map((f) => dirname(f.dest))])];
  await mustSucceed("create the skills and sub-agents directories",
    execAsAgentArgv(ctx, m.name, ["mkdir", "-p", ...dirs]));
  for (const f of files) {
    await mustSucceed(`push ${f.dest}`, pushText(ctx, m.name, f.dest, f.content, { uid: 1001, gid: 1001, mode: "644" }));
  }
  await mustSucceed("push the kit manifest", pushText(ctx, m.name, KIT_MANIFEST, manifest, { uid: 1001, gid: 1001, mode: "644" }));
  return true;
}
