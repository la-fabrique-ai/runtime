// Herdr App's machines (DX 5, spec §5.6): one per container of the team, named
// after it, reached through `forge hc-via` on the Mac and `forge hc-exec` on the
// host: a byte pipe, no secret. forge owns the machines whose name starts with
// `<host alias>-` and whose command is its own transport for that alias; a
// machine another tool added is never touched.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { forgeCommand } from "../paths.ts";
import { shellQuote } from "../shell.ts";
import type { LaptopHost } from "./state.ts";

// "forge-local", "agent-web-dev-1" -> "forge-local-web-dev-1"
export const machineName = (alias: string, container: string): string => `${alias}-${container.replace(/^agent-/, "")}`;

// The command hc runs, with the remote line appended as its last argument.
export const viaCommand = (alias: string, container: string): string =>
  `${shellQuote(forgeCommand())} hc-via ${alias} ${container}`;

type Machine = { name: string; target: string; state: string; why: string };

// `hc machine ls --json` (hc 0.1.20): {"machines":[{"name","target","via","state",...}]}.
async function listMachines(ctx: Context): Promise<Machine[]> {
  const r = await ctx.exec(["hc", "machine", "ls", "--json"]);
  if (r.code !== 0) throw new ForgeError(`hc machine ls failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { throw new ForgeError("hc machine ls printed something unreadable"); }
  const machines = (parsed as { machines?: unknown })?.machines;
  if (!Array.isArray(machines)) throw new ForgeError("hc machine ls printed something unreadable");
  return machines
    .filter((m): m is { name: string; target?: unknown; state?: unknown; why?: unknown } =>
      typeof m === "object" && m !== null && typeof (m as { name?: unknown }).name === "string")
    .map((m) => ({
      name: m.name, target: typeof m.target === "string" ? m.target : "",
      state: typeof m.state === "string" ? m.state : "", why: typeof m.why === "string" ? m.why : "",
    }));
}

// hc pins the identity of each machine's core: a container that was recreated
// has a new core, and the machine reads "unreachable" (a different core answers).
const isRebuilt = (m: Machine) => m.state === "unreachable" && m.why.includes("a different core answers");

// Makes Herdr App's machines for `host` the declared containers, no more, no less.
// `recreated` are the containers this very `team up` created: their machine, if
// one existed, points at the old core and is replaced. A machine in that state
// for a container forge did not recreate is never re-pinned silently (hc's
// safeguard): it is reported in `stale`, for the human to click "Connect".
export async function syncMachines(
  ctx: Context, host: LaptopHost, containers: string[], recreated: string[] = [],
): Promise<{ added: string[]; removed: string[]; replaced: string[]; stale: string[] }>  {
  const alias = host.name;
  const wanted = new Map(containers.map((c) => [machineName(alias, c), viaCommand(alias, c)]));
  const listed = await listMachines(ctx);
  // Ours: named after this alias, and reached by forge's transport for it.
  const ours = listed.filter((m) => m.name.startsWith(`${alias}-`) && m.target.includes(` hc-via ${alias} `));
  const result = { added: [] as string[], removed: [] as string[], replaced: [] as string[], stale: [] as string[] };
  const fresh = new Set(recreated.map((c) => machineName(alias, c)));
  const remove = async (name: string) => {
    const r = await ctx.exec(["hc", "machine", "rm", name]);
    if (r.code !== 0) throw new ForgeError(`hc machine rm ${name} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  };
  for (const m of ours) {
    if (!wanted.has(m.name)) {
      await remove(m.name);
      result.removed.push(m.name);
    } else if (m.target !== wanted.get(m.name)) {
      // Its command is stale (forge moved): replaced below.
      await remove(m.name);
    } else if (fresh.has(m.name)) {
      // The container is new, its core too: the machine is replaced below.
      await remove(m.name);
      result.replaced.push(m.name);
    } else if (isRebuilt(m)) {
      result.stale.push(m.name);
    }
  }
  const present = new Set(ours
    .filter((m) => wanted.has(m.name) && m.target === wanted.get(m.name) && !fresh.has(m.name)).map((m) => m.name));
  for (const [name, via] of wanted) {
    if (present.has(name)) continue;
    // No --install: forge never copies an hc anywhere (checkLocalHc ran first).
    const r = await ctx.exec(["hc", "machine", "add", "--name", name, "--via", via, "--json"]);
    if (r.code !== 0) throw new ForgeError(`hc machine add ${name} failed: ${r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`}`);
    if (!result.replaced.includes(name)) result.added.push(name);
  }
  return result;
}
