// forge team up | assign | release | status | sync | summary, on the Mac: each
// runs the host's own `forge team …` over SSH; `up` then registers every
// container of the project as a machine in Herdr App.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError } from "../context.ts";
import { INSTRUCTION_MAX } from "../api/protocol.ts";
import { checkLocalHc } from "../hc.ts";
import { syncMachines } from "../laptop/machines.ts";
import { remoteAttachForwarding, remoteExec } from "../laptop/remote.ts";
import { loadHosts, selectHost, type LaptopHost } from "../laptop/state.ts";
import { printableText } from "../printable.ts";
import type { ProjectStatus } from "./team.ts";

const USAGE = `Usage: forge team up [--host <name>]
       forge team assign <executor> <sub-task> [--repository <name>] [--base <ref>] [--host <name>]   (the instruction is read from stdin)
       forge team release <executor> [--host <name>]
       forge team status [--json] [--host <name>]
       forge team sync <repository> [--host <name>]
       forge team summary --json   (every installed host's executors, one line of JSON: read by the Herdr App bar)`;

export type TeamLaptopOptions = {
  host?: string; json?: boolean; quick?: boolean; repository?: string; base?: string; stdin?: () => Promise<string>;
};

async function readStdin(): Promise<string> {
  // Un terminal ne donne pas de consigne : le dire plutôt qu'attendre sans rien afficher.
  if (process.stdin.isTTY) throw new ForgeError("the instruction is read from stdin: forge team assign <executor> <sub-task> < instruction.md");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > INSTRUCTION_MAX) throw new ForgeError(`the instruction is longer than ${INSTRUCTION_MAX} bytes.`);
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
  if (opts.json && !["status", "summary"].includes(sub ?? "")) {
    throw new ForgeError(`--json only goes with status and summary: forge team status --json\n${USAGE}`);
  }
  if (opts.quick && sub !== "status") throw new ForgeError(`--quick only goes with status: forge team status --quick\n${USAGE}`);
  if ((opts.repository !== undefined || opts.base !== undefined) && sub !== "assign") {
    throw new ForgeError(`--repository and --base only go with assign\n${USAGE}`);
  }
  switch (sub) {
    case "up":
      if (a !== undefined) throw new ForgeError(`a project converges as a whole: forge team up, without a name.\n${USAGE}`);
      return up(ctx, await selectHost(ctx, opts.host));
    case "assign": {
      if (a === undefined || b === undefined) throw new ForgeError(`an executor and a sub-task are required.\n${USAGE}`);
      const text = await (opts.stdin ?? readStdin)();
      const host = await selectHost(ctx, opts.host);
      return relayed(ctx, await remoteExec(ctx, host, ["forge", "team", "assign", a, b,
        ...(opts.repository !== undefined ? ["--repository", opts.repository] : []),
        ...(opts.base !== undefined ? ["--base", opts.base] : [])], text));
    }
    case "release":
      if (a === undefined) throw new ForgeError(`an executor is required.\n${USAGE}`);
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "release", a]));
    case "status":
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "status", ...(opts.json ? ["--json"] : []), ...(opts.quick ? ["--quick"] : [])]));
    case "summary": return summary(ctx, opts);
    case "sync":
      if (a === undefined) throw new ForgeError(`a repository name is required.\n${USAGE}`);
      return remoteAttachForwarding(ctx, await selectHost(ctx, opts.host), ["forge", "team", "sync", a]);
    default: throw new ForgeError(USAGE);
  }
}

// What the forge bar of Herdr App reads: per installed host, its executors at
// work, idle (a session that waits) and free, the orchestrator's state, or the
// reason the host did not answer.
export type Summary = {
  hosts: {
    host: string; executors: { working: number; idle: number; free: number }; orchestrator: string | null; error: string | null;
  }[];
};

const SUMMARY_TIMEOUT_MS = 20000;

// One host after the other, each with a timeout: the bar polls this, and a slow
// host must not stack SSH sessions. An unreachable host is an entry with
// `error`, never a failed command.
async function summary(ctx: Context, opts: TeamLaptopOptions): Promise<number> {
  if (!opts.json) throw new ForgeError(`forge team summary only has a JSON form: forge team summary --json\n${USAGE}`);
  const report: Summary = { hosts: [] };
  for (const host of loadHosts().filter((h) => h.done.includes("setup"))) {
    try {
      const r = await remoteExec(ctx, host, STATUS, undefined, SUMMARY_TIMEOUT_MS);
      if (r.timedOut) throw new Error(`no answer in ${SUMMARY_TIMEOUT_MS / 1000} s`);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `exit code ${r.code}`);
      const status = JSON.parse(r.stdout) as Partial<ProjectStatus>;
      if (!Array.isArray(status.members) || status.members.some((m) => typeof m?.kind !== "string")) {
        throw new Error("an older forge answered: update the host");
      }
      const executors = status.members.filter((m) => m.kind === "executor" && m.present);
      const control = status.members.find((m) => m.kind === "control");
      report.hosts.push({
        host: host.name,
        executors: {
          working: executors.filter((m) => m.session === "working").length,
          idle: executors.filter((m) => m.mission !== null && (m.session === "idle" || m.session === "done")).length,
          free: executors.filter((m) => m.mission === null).length,
        },
        orchestrator: typeof control?.orchestrator === "string" ? printableText(control.orchestrator) : null,
        error: null,
      });
    } catch (e) {
      const why = e instanceof SyntaxError ? "unreadable answer" : e instanceof Error ? e.message : String(e);
      report.hosts.push({ host: host.name, executors: { working: 0, idle: 0, free: 0 }, orchestrator: null, error: printableText(why) });
    }
  }
  ctx.out(JSON.stringify(report));
  return 0;
}

const STATUS = ["forge", "team", "status", "--json", "--quick"];

type StatusRow = { name: string; present?: boolean };

// The host's status is an object with `members`; an older host printed the
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
async function up(ctx: Context, host: LaptopHost): Promise<number> {
  await checkLocalHc(ctx);
  // Which containers exist before the host converges: the ones that appear were
  // created by this `team up`, and their machines (if any) hold an old core.
  const before = await presentContainers(ctx, host);
  const converged = await remoteAttachForwarding(ctx, host, ["forge", "team", "converge"]);
  if (converged !== 0) return converged;
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
