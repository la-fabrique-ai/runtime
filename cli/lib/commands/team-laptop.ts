// forge team up | assign | release | status | sync, on the Mac (DX 5, §5.6):
// each runs the host's own `forge team …` over SSH; `up` then registers every
// container of the teams as a machine in Herdr App.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError } from "../context.ts";
import { BODY_MAX } from "../api/protocol.ts";
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

// forge answer <question id> "<summary>" [--host <name>] : the human's answer to
// an agent's question. The text never goes into the host's argv: the host's
// `forge team answer` reads {"summary", "body"?} on stdin, like assign does.
// The body is read from stdin when it is not a terminal.
export async function cmdAnswer(
  ctx: Context, id: string | undefined, summary: string | undefined,
  opts: { host?: string; body?: () => Promise<string | null> } = {},
): Promise<number> {
  if (id === undefined || !/^[0-9]{1,15}$/.test(id) || summary === undefined) {
    throw new ForgeError('Usage: forge answer <question id> "<summary>" [--host <name>]   (the body is read from stdin when it is piped)');
  }
  const body = await (opts.body ?? readBody)();
  const host = await selectHost(ctx, opts.host);
  const payload = JSON.stringify(body === null ? { summary } : { summary, body });
  return relayed(ctx, await remoteExec(ctx, host, ["forge", "team", "answer", id], payload));
}

async function readBody(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new ForgeError(`the body is longer than ${BODY_MAX} bytes: put it in a file of the agent's branch and send its path`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() === "" ? null : text;
}

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
