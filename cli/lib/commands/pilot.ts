// forge pilot <ticket> [--fresh] : l'humain ouvre un ticket avec le Pilote
// (spec §6.8). Depuis la machine de dev, la commande passe à l'hôte avec
// l'agent SSH transmis ; sur l'hôte, elle rafraîchit les miroirs d'origine
// (décision 12), s'assure que la session du Pilote tourne, puis y tape une
// ligne qui nomme le ticket. C'est le geste de l'humain : la seule ligne, avec
// `forge notify`, que forge tape dans la session du Pilote (décision 31).
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { loadConfig } from "../config.ts";
import { typeNotice } from "../hc-session.ts";
import { execAsAgentArgv } from "../incus.ts";
import { remoteAttachForwarding } from "../laptop/remote.ts";
import { selectHost } from "../laptop/state.ts";
import { configPath } from "../paths.ts";
import { ensurePilot } from "../pilot.ts";
import { CONTROL } from "../project.ts";
import { isTicketId } from "../tickets/model.ts";
import { refreshOriginMirror } from "./team.ts";

const USAGE = "usage: forge pilot <ticket> [--fresh] [--host <name>]";
const TICKET_MS = 15_000;

function ticketArg(args: string[]): string {
  const [id, ...rest] = args;
  if (!isTicketId(id) || rest.length > 0) throw new ForgeError(`a ticket id is required (such as T-3).\n${USAGE}`);
  return id;
}

// Sur la machine de dev : la même commande sur l'hôte, l'agent SSH transmis
// (les miroirs se rafraîchissent avec la clé de l'humain).
export async function cmdPilotLaptop(ctx: Context, args: string[], opts: { host?: string; fresh?: boolean }): Promise<number> {
  const id = ticketArg(args);
  return remoteAttachForwarding(ctx, await selectHost(ctx, opts.host), ["forge", "pilot", id, ...(opts.fresh ? ["--fresh"] : [])]);
}

// Sur l'hôte, dans cet ordre : le ticket existe (demandé au canal, en aiuser
// dans le contrôle), les miroirs, la session du Pilote, la ligne.
export async function cmdPilot(ctx: Context, args: string[], opts: { fresh?: boolean }): Promise<number> {
  const id = ticketArg(args);
  const p = loadConfig(configPath()).project;
  if (p === null) throw new ForgeError(`no project in ${configPath()}: declare "project" there first (see the README).`);
  const r = await execAsAgentArgv(ctx, CONTROL, ["forge-team", "ticket", id], { timeoutMs: TICKET_MS });
  if (r.timedOut || r.code !== 0) {
    const why = r.timedOut ? `no answer from the control container in ${TICKET_MS / 1000} s` : r.stderr.trim().split("\n")[0] || `exit code ${r.code}`;
    throw new ForgeError(`ticket ${id}: ${why}`);
  }
  for (const repo of Object.keys(p.repositories)) await refreshOriginMirror(ctx, p, repo);
  await ensurePilot(ctx, { fresh: opts.fresh });
  await typeNotice(ctx, CONTROL, `[forge] ticket ${id}: the human opens it with you`);
  ctx.out(`The Pilot is on ${id}: talk to it in its terminal (forge open, or its Herdr App machine).`);
  return 0;
}
