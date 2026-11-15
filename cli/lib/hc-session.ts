// Les sessions d'un membre d'équipe tournent dans le core hc de son container
// (DX 5, §5.8) : forge les pilote par `incus exec` avec un argv, jamais par un
// shell. Le texte d'une consigne arrive comme fichier, jamais dans un argv.
import type { Context, ExecResult } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { execAsAgentArgv, incus, pushText } from "./incus.ts";
import { egressAfterStart, egressBeforeStart } from "./strict.ts";
import type { Member } from "./team.ts";

// Le nom du terminal hc de l'agent, le même dans chaque container.
export const SESSION = "agent";
export const INSTRUCTION_PATH = "/home/aiuser/.forge/instruction.md";
// Les étiquettes par lesquelles Herdr App range un terminal (guide de l'app,
// `~/.config/herdr-app/AGENTS.md`, « The model »).
const HERDR_SPACE_LABEL = "herdr.space";
const HERDR_TAB_LABEL = "herdr.tab";

// Où hc cherche son core : le dossier d'exécution de l'utilisateur, que
// systemd crée au démarrage (lingering). Les deux chemins qui mènent à hc, le
// nôtre (hcArgv) et celui de Herdr App (`forge hc-exec`), donnent les mêmes
// variables : sans elles, hc se replie sur `~/.local/state` et démarre un second
// core, que l'autre chemin ne voit pas.
export const HC_RUNTIME_DIR = "/run/user/1001";
export const HC_ENV: Record<string, string> = {
  XDG_RUNTIME_DIR: HC_RUNTIME_DIR,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${HC_RUNTIME_DIR}/bus`,
};

// `hc` en tant qu'aiuser, dans /workspace, avec ce qu'il faut pour joindre son
// core (le bus de session de l'utilisateur) sans passer par un shell de login.
export function hcArgv(container: string, args: string[]): string[] {
  return incus("exec", container,
    "--user", "1001", "--group", "1001", "--cwd", "/workspace",
    "--env", "HOME=/home/aiuser",
    ...Object.entries(HC_ENV).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--", "hc", ...args);
}

// `lost` : un terminal `agent` vivant dont le programme n'est pas forge-agent
// (hc en garde un et le relance en shell après un redémarrage de la VM) : ce
// n'est pas une session, rien n'y est livré.
export type SessionState = "none" | "idle" | "working" | "done" | "exited" | "lost" | "unknown";

// Une session vivante est un terminal `agent` dont le programme est forge-agent
// et qui a un statut d'agent.
export const isLive = (s: SessionState) => s === "idle" || s === "working" || s === "done";

// `hc get agent` : un code non nul veut dire qu'il n'y a pas de terminal. Un
// terminal dont le programme est sorti reste listé par hc (`"state":"finished"`,
// sans statut) : c'est une session morte, `exited`, pas un état inconnu.
export async function sessionState(ctx: Context, container: string): Promise<SessionState> {
  return (await sessionInfo(ctx, container)).state;
}

async function sessionInfo(ctx: Context, container: string): Promise<{ state: SessionState; exitCode: unknown }> {
  const r = await ctx.exec(hcArgv(container, ["get", SESSION]));
  if (r.code !== 0) return { state: "none", exitCode: null };
  try {
    const t = JSON.parse(r.stdout) as { state?: unknown; exit_code?: unknown; argv?: unknown; status?: { state?: unknown } | null };
    if (t.state === "finished") return { state: "exited", exitCode: t.exit_code };
    // Sans programme lisible, rien ne prouve que c'est forge-agent.
    const program = Array.isArray(t.argv) && typeof t.argv[0] === "string" ? t.argv[0].split("/").pop() : undefined;
    if (program !== "forge-agent") return { state: "lost", exitCode: null };
    const state = t.status?.state;
    return { state: state === "idle" || state === "working" || state === "done" ? state : "unknown", exitCode: null };
  } catch {
    return { state: "unknown", exitCode: null };
  }
}

// Un forge-agent qui vient de démarrer n'a pas encore annoncé de statut
// (`unknown`) : on attend qu'il en annonce un, une dizaine de regards d'une
// seconde, comme `deliverMessage` attend un hc qui démarre. Les autres états
// non vivants (`none`, `exited`, `lost`) se tranchent tout de suite.
const LIVE_LOOKS = 10;
const LIVE_STEP_MS = 1000;

export async function awaitLiveSession(ctx: Context, container: string): Promise<boolean> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let look = 1; ; look++) {
    const state = await sessionState(ctx, container);
    if (isLive(state)) return true;
    if (state !== "unknown" || look === LIVE_LOOKS) return false;
    await sleep(LIVE_STEP_MS);
  }
}

// Un agent qui meurt au démarrage (une option refusée, un token absent) se dit
// tout de suite, plutôt qu'un « Assigned » trompeur : quelques regards pendant
// environ 3 s. Un statut (OSC 7501) montre que l'agent a démarré ; sans statut
// ni sortie au bout du délai, rien ne prouve un échec.
const STARTUP_LOOKS = 6;
const STARTUP_STEP_MS = 500;

async function requireStarted(ctx: Context, container: string): Promise<void> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < STARTUP_LOOKS; i++) {
    await sleep(STARTUP_STEP_MS);
    const s = await sessionInfo(ctx, container);
    if (s.state === "exited") {
      const code = typeof s.exitCode === "number" ? String(s.exitCode) : "unknown";
      throw new ForgeError(`${container}'s agent stopped as soon as it started (exit code ${code}). ` +
        "Read its screen in the forge space of its Herdr App machine, or with hc read <machine>/agent from your machine.");
    }
    if (s.state === "idle" || s.state === "working" || s.state === "done") return;
  }
}

// Une session neuve : l'ancienne (s'il y en a une) est tuée et retirée, la
// consigne est poussée comme fichier, puis `hc run` lance forge-agent, qui la
// lit et la donne à claude comme premier message. `task` est le nom de la
// branche, ou null pour une tâche sans branche ; le marqueur `--forge-task` suit
// la forme `<container>-<tâche>` que `forge list` et `forge stop` lisent.
export async function startSession(ctx: Context, m: Member, task: string | null, instruction: string): Promise<void> {
  const mode = await egressBeforeStart(ctx, m.name);
  await egressAfterStart(ctx, m.name, mode);
  // Leur échec est sans importance : il n'y avait peut-être pas de session.
  await ctx.exec(hcArgv(m.name, ["kill", SESSION]));
  await ctx.exec(hcArgv(m.name, ["rm", SESSION]));
  await clearMessages(ctx, m.name);
  await mustSucceed("push the instruction",
    pushText(ctx, m.name, INSTRUCTION_PATH, instruction, { uid: 1001, gid: 1001, mode: "600" }));
  const marker = `${m.name}-${task ?? "session"}`;
  await mustSucceed("hc run", ctx.exec(hcArgv(m.name, [
    "run", "--bg", "--name", SESSION, "--cwd", "/workspace",
    // Herdr App ne montre que les terminaux étiquetés par un espace et un
    // onglet ; des ids qu'il ne connaît pas deviennent un espace et un onglet
    // neufs. Les mêmes ids à chaque tâche : la session suivante retombe au
    // même endroit.
    "--label", `${HERDR_SPACE_LABEL}=forge`, "--label", `${HERDR_TAB_LABEL}=agent`,
    // L'ordre que forge-agent lit : --forge-task, puis --instruction-file, puis
    // les arguments de claude.
    "forge-agent", "--forge-task", marker, "--instruction-file", INSTRUCTION_PATH, "--permission-mode", "auto",
  ])));
  await requireStarted(ctx, m.name);
}

export const MESSAGES_DIR = "/home/aiuser/.forge/messages";
// hc refuse un envoi tant que la sortie du terminal n'a pas fini de bouger :
// une dizaine de regards d'une seconde, puis un refus clair.
const SEND_ATTEMPTS = 10;
const SEND_WAIT_MS = 1000;

// Les messages ne valent que pour la session qui les a reçus : `assign` et
// `release` vident le dossier. Un échec est sans importance (il peut ne pas
// exister) : il ne doit pas arrêter une assignation.
export async function clearMessages(ctx: Context, container: string): Promise<void> {
  await execAsAgentArgv(ctx, container, ["find", MESSAGES_DIR, "-mindepth", "1", "-delete"]);
}

// Vrai d'un membre jamais assigné comme d'un membre libéré (`release` arrête sa
// session).
export const NO_SESSION = "has no live session: a member has one from the moment someone assigns it a task until it is released (forge-team assign, with that capability)";

// Arrête la session sans retirer le terminal : l'humain peut relire la session
// terminée dans Herdr App, et le prochain `assign` la remplace (startSession).
export async function stopSession(ctx: Context, container: string): Promise<boolean> {
  return (await ctx.exec(hcArgv(container, ["kill", SESSION]))).code === 0;
}

// Un message de l'API (DX 5, §5.4) : le corps, s'il y en a un, devient un
// fichier du container du destinataire ; la session ne reçoit qu'une ligne, que
// forge seul écrit : son préfixe, un identifiant de journal, le nom de
// l'expéditeur (tiré de la socket) et le résumé, que le protocole a vérifié
// contre sa liste de caractères. Aucun corps ne passe par un argv ni par un
// terminal. L'avis est tapé tout de suite, même pendant un tour : Claude Code
// le reçoit à sa prochaine frontière d'outil, dans le tour en cours.
// Quand l'expéditeur est un agent que le destinataire a lui-même assigné,
// l'avis le dit (`retained` : sa tâche) et nomme qui libérer : un rappel écrit
// par forge, au moment où l'agent doit agir. Ce ne sont que des noms de
// container et de tâche que forge a déjà validés, jamais un texte d'agent
// avant le résumé.
export async function deliverMessage(
  ctx: Context, container: string, from: string, id: number, summary: string, body: string | null,
  retained: { task: string | null } | null = null,
): Promise<{ turn: number }> {
  const path = `${MESSAGES_DIR}/${id}.md`;
  if (body !== null) {
    const pushed = await pushText(ctx, container, path, body, { uid: 1001, gid: 1001, mode: "600" });
    if (pushed.code !== 0) {
      throw new ForgeError(`delivery to ${container} failed: ${firstLine(pushed.stderr) || `exit code ${pushed.code}`}`);
    }
  }
  const onTask = retained === null ? "" :
    `, on the task you assigned it (${retained.task ?? "without a branch"}; forge-team release ${from} once it is finished)`;
  const notice = `[forge] message ${id} from ${from}${onTask}: ${summary}${body === null ? "" : ` (detail: ${path})`}`;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    const r = await ctx.exec(hcArgv(container, ["send", "--json", SESSION, notice]));
    if (r.code === 0) return { turn: sentTurn(container, r.stdout) };
    const why = hcError(r);
    if (why.includes("has finished")) throw new ForgeError(`${container} ${NO_SESSION}`);
    if (why.includes("is still starting") && attempt < SEND_ATTEMPTS) {
      await sleep(SEND_WAIT_MS);
      continue;
    }
    throw new ForgeError(`delivery to ${container} failed: ${why || `exit code ${r.code}`}`);
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0];

// Avec --json, hc écrit son erreur sur stdout, en JSON
// (`{"error":{"kind":"finished","message":"t2 has finished"}}`, code 11) ; sans,
// c'est une ligne sur stderr. Le message se lit des deux façons.
function hcError(r: ExecResult): string {
  try {
    const message = (JSON.parse(r.stdout) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return firstLine(message);
  } catch {
    // Pas du JSON : la ligne de stderr.
  }
  return firstLine(r.stderr);
}

// La réponse de `hc send --json` (`hc schema`, SendResult) : le numéro de tour.
function sentTurn(container: string, stdout: string): number {
  try {
    const turn = (JSON.parse(stdout) as { turn?: unknown }).turn;
    if (typeof turn === "number") return turn;
  } catch {
    // Traité comme une réponse illisible, plus bas.
  }
  throw new ForgeError(`delivery to ${container} failed: hc send answered something forge cannot read`);
}
