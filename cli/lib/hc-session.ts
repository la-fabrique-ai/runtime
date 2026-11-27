// La session d'un exécuteur tourne dans le core hc de son container
// (DX 5, §5.8) : forge les pilote par `incus exec` avec un argv, jamais par un
// shell. Le texte d'une consigne arrive comme fichier, jamais dans un argv.
import type { Context, ExecResult } from "./context.ts";
import { ForgeError, inTime, mustSucceed } from "./context.ts";
import { execAsAgentArgv, incus, writeAsAgent } from "./incus.ts";
import { egressAfterStart, egressBeforeStart } from "./strict.ts";

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
// n'est pas une session, rien n'y est livré. `blocked` : l'agent attend une
// réponse à son écran (l'écran de confiance de Claude Code, une question) ;
// il vit, mais n'avance plus sans l'humain.
export type SessionState = "none" | "idle" | "working" | "done" | "blocked" | "exited" | "lost" | "unknown";

// Une session vivante est un terminal `agent` dont le programme est forge-agent
// et qui a un statut d'agent.
export const isLive = (s: SessionState) => s === "idle" || s === "working" || s === "done";

// `hc get agent` : un code non nul veut dire qu'il n'y a pas de terminal. Un
// terminal dont le programme est sorti reste listé par hc (`"state":"finished"`,
// sans statut) : c'est une session morte, `exited`, pas un état inconnu.
// `timeoutMs` : un `hc get` qui ne répond pas à temps vaut `unknown`, jamais
// `none` (l'API de projet, dont le statut ne doit pas se figer).
export async function sessionState(ctx: Context, container: string, opts: { timeoutMs?: number } = {}): Promise<SessionState> {
  return (await sessionInfo(ctx, container, opts.timeoutMs)).state;
}

// Avec ou sans délai : un appel sans `timeoutMs` garde la forme d'avant.
const execMaybeTimed = (ctx: Context, argv: string[], timeoutMs: number | undefined): Promise<ExecResult> =>
  timeoutMs === undefined ? ctx.exec(argv) : ctx.exec(argv, { timeoutMs });

async function sessionInfo(
  ctx: Context, container: string, timeoutMs?: number,
): Promise<{ state: SessionState; exitCode: unknown; timedOut?: boolean }> {
  const r = await execMaybeTimed(ctx, hcArgv(container, ["get", SESSION]), timeoutMs);
  if (r.timedOut) return { state: "unknown", exitCode: null, timedOut: true };
  if (r.code !== 0) return { state: "none", exitCode: null };
  try {
    const t = JSON.parse(r.stdout) as { state?: unknown; exit_code?: unknown; argv?: unknown; status?: { state?: unknown } | null };
    if (t.state === "finished") return { state: "exited", exitCode: t.exit_code };
    // Sans programme lisible, rien ne prouve que c'est forge-agent.
    const program = Array.isArray(t.argv) && typeof t.argv[0] === "string" ? t.argv[0].split("/").pop() : undefined;
    if (program !== "forge-agent") return { state: "lost", exitCode: null };
    const state = t.status?.state;
    const known = state === "idle" || state === "working" || state === "done" || state === "blocked";
    return { state: known ? state : "unknown", exitCode: null };
  } catch {
    return { state: "unknown", exitCode: null };
  }
}

// Un agent qui meurt au démarrage (une option refusée, un token absent) se dit
// tout de suite, plutôt qu'un « Assigned » trompeur : quelques regards pendant
// environ 3 s. Un statut (OSC 7501) montre que l'agent a démarré ; sans statut
// ni sortie au bout du délai, rien ne prouve un échec.
const STARTUP_LOOKS = 6;
const STARTUP_STEP_MS = 500;

async function requireStarted(ctx: Context, container: string, timeoutMs?: number): Promise<void> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < STARTUP_LOOKS; i++) {
    await sleep(STARTUP_STEP_MS);
    const s = await sessionInfo(ctx, container, timeoutMs);
    if (s.timedOut) throw new ForgeError(`hc get in ${container} timed out after ${(timeoutMs ?? 0) / 1000} s`);
    if (s.state === "exited") {
      const code = typeof s.exitCode === "number" ? String(s.exitCode) : "unknown";
      throw new ForgeError(`${container}'s agent stopped as soon as it started (exit code ${code}). ` +
        "Read its screen in the forge space of its Herdr App machine, or with hc read <machine>/agent from your machine.");
    }
    // `blocked` : l'agent a démarré et attend à son écran ; l'orchestrateur et
    // `forge team status` le signalent.
    if (s.state === "idle" || s.state === "working" || s.state === "done" || s.state === "blocked") return;
  }
}

// Une session neuve : l'ancienne (s'il y en a une) est tuée et retirée, la
// consigne est poussée comme fichier, puis `hc run` lance forge-agent, qui la
// lit et la donne à claude comme premier message. `task` est le nom de la
// branche, ou null pour une tâche sans branche ; le marqueur `--forge-task` suit
// la forme `<container>-<tâche>` que `forge list` et `forge stop` lisent.
// `cwd` : le dossier où l'agent travaille, le clone d'un dépôt
// (/workspace/<nom>) pour un exécuteur, /workspace par défaut.
// `timeoutMs` : chaque appel hc ou incus qui suit l'egress a ce délai (l'API,
// dans sa file) ; dépassé, c'est un refus qui nomme l'étape.
export async function startSession(
  ctx: Context, m: { name: string }, task: string | null, instruction: string, opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const t = opts.timeoutMs;
  const hc = (step: string, args: string[]) => inTime(`${step} in ${m.name}`, t, execMaybeTimed(ctx, hcArgv(m.name, args), t));
  const mode = await egressBeforeStart(ctx, m.name);
  await egressAfterStart(ctx, m.name, mode);
  // Leur échec est sans importance : il n'y avait peut-être pas de session.
  await hc("hc kill", ["kill", SESSION]);
  await hc("hc rm", ["rm", SESSION]);
  await clearMessages(ctx, m.name, { timeoutMs: t });
  // En aiuser, le texte sur stdin : root n'écrit pas dans le home de l'agent.
  await mustSucceed("write the instruction", inTime(`write the instruction in ${m.name}`, t,
    writeAsAgent(ctx, m.name, INSTRUCTION_PATH, instruction, { timeoutMs: t })));
  const marker = `${m.name}-${task ?? "session"}`;
  await mustSucceed("hc run", hc("hc run", [
    "run", "--bg", "--name", SESSION, "--cwd", opts.cwd ?? "/workspace",
    // Herdr App ne montre que les terminaux étiquetés par un espace et un
    // onglet ; des ids qu'il ne connaît pas deviennent un espace et un onglet
    // neufs. Les mêmes ids à chaque tâche : la session suivante retombe au
    // même endroit.
    "--label", `${HERDR_SPACE_LABEL}=forge`, "--label", `${HERDR_TAB_LABEL}=agent`,
    // L'ordre que forge-agent lit : --forge-task, puis --instruction-file, puis
    // les arguments de claude.
    "forge-agent", "--forge-task", marker, "--instruction-file", INSTRUCTION_PATH, "--permission-mode", "auto",
  ]));
  await requireStarted(ctx, m.name, t);
}

export const MESSAGES_DIR = "/home/aiuser/.forge/messages";
// hc refuse un envoi tant que la sortie du terminal n'a pas fini de bouger :
// une dizaine de regards d'une seconde, puis un refus clair.
const SEND_ATTEMPTS = 10;
const SEND_WAIT_MS = 1000;

// Les messages ne valent que pour la session qui les a reçus : `assign` et
// `release` vident le dossier. Un échec est sans importance (il peut ne pas
// exister) : il ne doit pas arrêter une assignation.
export async function clearMessages(ctx: Context, container: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await inTime(`clearing the messages of ${container}`, opts.timeoutMs,
    execAsAgentArgv(ctx, container, ["find", MESSAGES_DIR, "-mindepth", "1", "-delete"], opts));
}

// Vrai d'un exécuteur jamais assigné comme d'un exécuteur libéré (`release`
// arrête sa session).
export const NO_SESSION = "has no live session: an executor has one from the moment it is given a mission until it is released";

// Arrête la session sans retirer le terminal : l'humain peut relire la session
// terminée dans Herdr App, et le prochain `assign` la remplace (startSession).
// `timeoutMs` : dépassé, un refus qui nomme l'étape (l'appelant décide s'il le
// tient pour un simple avertissement).
export async function stopSession(ctx: Context, container: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const r = await inTime(`hc kill in ${container}`, opts.timeoutMs, execMaybeTimed(ctx, hcArgv(container, ["kill", SESSION]), opts.timeoutMs));
  return r.code === 0;
}

// Tape une ligne que forge a écrite dans la session `agent` du container : un
// seul élément d'argv, jamais un shell. Rend le numéro de tour de hc.
export async function typeNotice(ctx: Context, container: string, notice: string): Promise<number> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    const r = await ctx.exec(hcArgv(container, ["send", "--json", SESSION, notice]));
    if (r.code === 0) return sentTurn(container, r.stdout);
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
