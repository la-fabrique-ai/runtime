// forge team watch (DX 5, §5.4) : la vue de l'équipe dans un terminal de la
// machine de dev. Elle interroge l'hôte avec `forge team status --json --quick`,
// un appel à la fois, avec un délai : un hôte lent ou injoignable n'empile pas de
// sessions SSH (la recette de la partie 2 a saturé un hôte de 3,7 Gio) et ne
// bloque pas l'affichage.
import type { Context } from "../context.ts";
import { ageLabel, mirrorLine } from "../age.ts";
import type { TeamStatus } from "../commands/team.ts";
import { columnWidths, formatRow } from "../table.ts";
import { printableText } from "../printable.ts";
import { remoteExec } from "./remote.ts";
import type { LaptopHost } from "./state.ts";

export const WATCH_INTERVAL_MS = 5000; // aussi le minimum : jamais plus vite
export const WATCH_TIMEOUT_MS = 20000;
const CLEAR = "\u001b[H\u001b[2J";

const clock = (d: Date) => d.toTimeString().slice(0, 8);

// Ce qui vient de l'hôte (un résumé, un nom, une erreur) passe par printableText :
// un agent ne peut pas écrire une séquence d'échappement dans le terminal de
// l'humain. Un corps n'est jamais affiché ; une ligne est coupée à la largeur.
export function renderWatch(
  host: string, status: TeamStatus | null, error: string | null, lastGood: Date | null, now: Date, width: number,
): string {
  const lines: string[] = [`forge team ${printableText(host)}  ${clock(now)}`];
  if (status !== null) {
    const head = ["MEMBER", "ROLE", "TASK", "SESSION", "WAITING"];
    const rows = status.members.map((m) => [
      m.name, m.role, m.task ?? "free", m.present ? m.session : "absent", m.waitingOn ?? "-",
    ].map(printableText));
    const widths = columnWidths([head, ...rows]);
    lines.push(formatRow(head, widths), ...rows.map((r) => formatRow(r, widths)));
    lines.push("INBOX" + (status.inbox.length === 0 ? "  (empty)" : ""));
    for (const q of status.inbox) {
      const detail = q.hasBody ? `  (+ detail: forge team question ${q.id})` : "";
      lines.push(`  #${q.id} ${printableText(q.from)} ${ageLabel(now.getTime() - Date.parse(q.time))}: ${printableText(q.summary)}${detail}`);
    }
    for (const m of status.mirrors) lines.push(printableText(mirrorLine(m.team, m.originAgeSeconds)));
  }
  if (error !== null) {
    lines.push(lastGood === null
      ? `unreachable: ${printableText(error)}`
      : `unreachable since ${clock(lastGood)}: ${printableText(error)}`);
  }
  const cut = (line: string) => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line);
  return lines.map(cut).join("\n");
}

type Poll = { status: TeamStatus } | { error: string };

// Un seul appel de statut, sans jamais lever : une erreur est un état à afficher.
async function poll(ctx: Context, host: LaptopHost, timeoutMs: number): Promise<Poll> {
  try {
    const r = await remoteExec(ctx, host, ["forge", "team", "status", "--json", "--quick"], undefined, timeoutMs);
    if (r.timedOut) return { error: `no answer from ${host.name} in ${Math.round(timeoutMs / 1000)} s` };
    if (r.code !== 0) return { error: r.stderr.trim().split("\n")[0] || `forge team status exited with code ${r.code}` };
    const parsed = JSON.parse(r.stdout) as Partial<TeamStatus>;
    if (!Array.isArray(parsed.members) || !Array.isArray(parsed.inbox) || !Array.isArray(parsed.mirrors)) {
      return { error: `forge team status on ${host.name} printed something this forge does not read: is the host's forge up to date?` };
    }
    return { status: parsed as TeamStatus };
  } catch (e) {
    return { error: e instanceof SyntaxError ? `forge team status on ${host.name} printed something unreadable` : e instanceof Error ? e.message : String(e) };
  }
}

// Une boucle séquentielle : le prochain appel ne part qu'une fois le précédent
// rendu, puis une attente d'au moins `intervalMs`. Ctrl-C la termine (code 0).
export async function watchLoop(
  ctx: Context, host: LaptopHost, opts: { intervalMs?: number; timeoutMs?: number; once?: boolean },
): Promise<number> {
  const interval = Math.max(WATCH_INTERVAL_MS, opts.intervalMs ?? WATCH_INTERVAL_MS);
  const timeoutMs = opts.timeoutMs ?? WATCH_TIMEOUT_MS;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let interrupted = false;
  let wake: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { wake = resolve; });
  const onSigint = () => { interrupted = true; wake(); };
  process.once("SIGINT", onSigint);
  try {
    let good: { status: TeamStatus; at: Date } | null = null;
    while (!interrupted) {
      const result = await Promise.race([poll(ctx, host, timeoutMs), stopped.then(() => null)]);
      if (result === null) break;
      const now = new Date();
      if ("status" in result) good = { status: result.status, at: now };
      ctx.out(CLEAR + renderWatch(host.name, good?.status ?? null, "error" in result ? result.error : null,
        good?.at ?? null, now, process.stdout.columns ?? 100));
      if (opts.once) break;
      await Promise.race([sleep(interval), stopped]);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return 0;
}
