// La session du Pilote : le terminal `agent` du container de contrôle, où
// l'humain prépare ses tickets (spec §6.8). Seul l'humain y écrit (décision
// 31) : `forge pilot` (son geste) et `forge notify` (le surveillant de mémoire),
// rien d'autre ; aucune question de développeur, aucun message de l'orchestrateur.
import type { Context } from "./context.ts";
import { sessionState, startSession } from "./hc-session.ts";
import { CONTROL } from "./project.ts";

export const PILOT_INSTRUCTION = "[forge] You are the Pilot of this project. Read /workspace/notes.md if it exists, then wait for the human.";

// Ces sessions vivent (blocked : elle attend l'humain à son écran) : on ne
// les touche pas, sauf `fresh`, qui en lance une neuve.
const RUNNING: readonly string[] = ["idle", "working", "done", "blocked"];

// La session du Pilote, lancée si elle ne tourne pas (jamais lancée, sortie,
// perdue après un redémarrage de l'hôte) ou si `fresh` le demande (un contexte
// vidé entre deux tickets, décision 9).
export async function ensurePilot(ctx: Context, opts: { fresh?: boolean } = {}): Promise<"started" | "running"> {
  if (!opts.fresh && RUNNING.includes(await sessionState(ctx, CONTROL))) return "running";
  await startSession(ctx, { name: CONTROL }, null, PILOT_INSTRUCTION, { cwd: "/workspace" });
  return "started";
}
