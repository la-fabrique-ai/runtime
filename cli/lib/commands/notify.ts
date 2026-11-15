// forge notify <container> memory-kill --pid <n> --rss-kib <n> --name=<name>
//
// Appelée par le surveillant mémoire de l'hôte (#143) quand il tue un processus
// d'un container : elle tape dans la session de l'agent une ligne que forge
// écrit, pour qu'il sache pourquoi son processus a disparu. Ce n'est pas un
// verbe de l'API : seul l'hôte la lance, aucune socket ne mène jusqu'ici.
//
// Le nom du processus vient du container, donc d'un agent : c'est le seul texte
// d'agent de l'avis. Il passe par la liste de caractères du résumé de l'API et
// il est tronqué ; le reste de la ligne est forge (un numéro, une taille).
import { ForgeError } from "../context.ts";
import type { Context } from "../context.ts";
import { loadConfig } from "../config.ts";
import { Journal, journalPath } from "../api/journal.ts";
import { SUMMARY_ALLOWED } from "../api/protocol.ts";
import { isLive, sessionState, typeNotice } from "../hc-session.ts";
import { configPath } from "../paths.ts";
import { memberNamed } from "../team.ts";
import { validateContainerName } from "../validate.ts";

const USAGE = "Usage: forge notify <container> memory-kill --pid <n> --rss-kib <n> --name=<name>";
export const NAME_MAX = 32; // des caractères (points de code)

// Un caractère hors liste devient « ? » : le nom reste lisible, et rien de ce
// qui servirait à imiter le préfixe de forge ou à appuyer sur une touche ne passe.
export function cleanProcessName(name: string): string {
  const clean = [...name].slice(0, NAME_MAX).map((ch) => (SUMMARY_ALLOWED.test(ch) ? ch : "?")).join("");
  return clean === "" ? "?" : clean;
}

function size(kib: number): string {
  return kib >= 1048576 ? `${(kib / 1048576).toFixed(1)} GiB` : `${Math.round(kib / 1024)} MiB`;
}

export function memoryKillNotice(pid: number, name: string, rssKib: number): string {
  return `[forge] memory: killed pid ${pid} (${cleanProcessName(name)}, ${size(rssKib)}): the container was stuck at its memory limit`;
}

const count = (what: string, raw: string | undefined): number => {
  if (raw === undefined || !/^[0-9]{1,15}$/.test(raw)) throw new ForgeError(`${what} must be a whole number\n${USAGE}`);
  return Number(raw);
};

export async function cmdNotify(
  ctx: Context, container: string | undefined, kind: string | undefined,
  opts: { pid?: string; rssKib?: string; name?: string },
): Promise<number> {
  if (container === undefined || kind !== "memory-kill") throw new ForgeError(USAGE);
  validateContainerName(container);
  const pid = count("--pid", opts.pid);
  const rssKib = count("--rss-kib", opts.rssKib);
  if (opts.name === undefined) throw new ForgeError(USAGE);
  // Seuls les membres d'équipe déclarés : jamais forge-proxy ni un autre container.
  memberNamed(loadConfig(configPath()), container);
  // Comme `message` : seulement une session forge-agent vivante. Sans, rien n'est
  // tapé ni journalisé, et ce n'est pas une erreur : le surveillant ne l'attend pas.
  if (!isLive(await sessionState(ctx, container))) return 0;
  const notice = memoryKillNotice(pid, opts.name, rssKib);
  await typeNotice(ctx, container, notice);
  Journal.open(journalPath()).append({
    caller: "forge", op: "notify", to: container, task: null, outcome: "ok", error: null, summary: notice, text: null,
  }, new Date(), 0);
  return 0;
}
