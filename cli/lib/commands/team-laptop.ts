// forge team up | assign | release | status | sync, on the Mac (DX 5, §5.6):
// each runs the host's own `forge team …` over SSH; `up` then registers every
// container of the teams as a machine in Herdr App.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError } from "../context.ts";
import { checkLocalHc } from "../hc.ts";
import { syncMachines } from "../laptop/machines.ts";
import { remoteAttachForwarding, remoteExec } from "../laptop/remote.ts";
import { selectHost, type LaptopHost } from "../laptop/state.ts";

const USAGE = `Usage: forge team up [<team>] [--host <name>]
       forge team assign <container> [<task>] [--host <name>]   (the instruction is read from stdin)
       forge team release <container> [--host <name>]
       forge team status [--json] [--quick] [--host <name>]
       forge team sync <team> [--host <name>]`;

const MAX_INSTRUCTION = 64 * 1024;

export type TeamLaptopOptions = { host?: string; json?: boolean; quick?: boolean; stdin?: () => Promise<string> };

async function readStdin(): Promise<string> {
  // Un terminal ne donne pas de consigne : le dire plutôt qu'attendre sans rien afficher.
  if (process.stdin.isTTY) throw new ForgeError("the instruction is read from stdin: forge team assign <container> <task> < instruction.md");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_INSTRUCTION) throw new ForgeError(`the instruction is longer than ${MAX_INSTRUCTION} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The host command's own output and status, as they are.
function relayed(ctx: Context, r: ExecResult): number {
  if (r.stdout !== "") ctx.out(r.stdout.replace(/\n$/, ""));
  if (r.stderr !== "") ctx.err(r.stderr.replace(/\n$/, ""));
  return r.code;
}

export async function cmdTeamLaptop(ctx: Context, args: string[], opts: TeamLaptopOptions = {}): Promise<number> {
  const [sub, a, b] = args;
  if (opts.json && sub !== "status") throw new ForgeError(`--json only goes with status: forge team status --json\n${USAGE}`);
  if (opts.quick && sub !== "status") throw new ForgeError(`--quick only goes with status: forge team status --quick\n${USAGE}`);
  switch (sub) {
    case "up": return up(ctx, await selectHost(ctx, opts.host), a);
    case "assign": {
      if (a === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
      const text = await (opts.stdin ?? readStdin)();
      const host = await selectHost(ctx, opts.host);
      return relayed(ctx, await remoteExec(ctx, host, ["forge", "team", "assign", a, ...(b ? [b] : [])], text));
    }
    case "release":
      if (a === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "release", a]));
    case "status":
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "status", ...(opts.json ? ["--json"] : []), ...(opts.quick ? ["--quick"] : [])]));
    case "sync":
      if (a === undefined) throw new ForgeError(`a team name is required.\n${USAGE}`);
      return remoteAttachForwarding(ctx, await selectHost(ctx, opts.host), ["forge", "team", "sync", a]);
    default: throw new ForgeError(USAGE);
  }
}

const STATUS = ["forge", "team", "status", "--json", "--quick"];

type StatusRow = { name: string; present?: boolean };

// The host's status API is an object with `members`; an older host printed the
// members as a bare array, which still gives the names (and no `present`).
function parseMembers(stdout: string): StatusRow[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { members?: unknown }).members;
    return Array.isArray(rows) ? (rows as StatusRow[]) : null;
  } catch {
    return null;
  }
}

// hc first: a Mac whose hc is not the pinned version converges nothing, so that
// the host is never changed for machines that cannot be added.
async function up(ctx: Context, host: LaptopHost, team: string | undefined): Promise<number> {
  await checkLocalHc(ctx);
  // Which containers exist before the host converges: the ones that appear were
  // created by this `team up`, and their machines (if any) hold an old core.
  const before = await presentContainers(ctx, host);
  const converged = await remoteAttachForwarding(ctx, host, ["forge", "team", "converge", ...(team ? [team] : [])]);
  if (converged !== 0) return converged;
  // `converge` vient de rafraîchir le miroir d'équipe : `--quick`.
  const status = await remoteExec(ctx, host, STATUS);
  if (status.code !== 0) {
    throw new ForgeError(`forge team status failed on ${host.name}: ${status.stderr.trim() || `exit code ${status.code}`}`);
  }
  const rows = parseMembers(status.stdout);
  if (rows === null) throw new ForgeError(`forge team status on ${host.name} printed something unreadable`);
  const recreated = before === null ? [] : rows.filter((r) => r.present === true && !before.has(r.name)).map((r) => r.name);
  const { added, removed, replaced, stale } = await syncMachines(ctx, host, rows.map((m) => m.name), recreated);
  for (const name of added) ctx.out(`Added Herdr App machine ${name}.`);
  for (const name of replaced) ctx.out(`Replaced Herdr App machine ${name}: its container was recreated.`);
  for (const name of removed) ctx.out(`Removed Herdr App machine ${name}.`);
  for (const name of stale) {
    ctx.err(`NOTE: Herdr App's machine ${name} still points at the container's previous core: click "Connect" on it in Herdr App.`);
  }
  if (added.length + replaced.length + removed.length + stale.length === 0) ctx.out("Herdr App's machines are up to date.");
  return 0;
}

// The containers that exist on the host, or null when it cannot say (nothing is
// then assumed about what `converge` creates).
async function presentContainers(ctx: Context, host: LaptopHost): Promise<Set<string> | null> {
  const r = await remoteExec(ctx, host, STATUS);
  if (r.code !== 0) return null;
  const rows = parseMembers(r.stdout);
  return rows === null || rows.some((x) => x.present === undefined) ? null : new Set(rows.filter((x) => x.present).map((x) => x.name));
}
