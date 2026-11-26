// forge-memory-watchdog: kills the biggest process of an agent container that
// is stuck at its memory limit (#126).
//
// A cgroup at memory.max reclaims its file pages, the code of its own
// programs, which are read back from disk at once: reclaim always "makes
// progress", so the kernel never OOM-kills and the container thrashes for
// hours. The signal that it does is memory.pressure: `full` is the share of
// time in which every task of the cgroup waited for memory.
//
// This runs on the host, as the forge user, and only reads the cgroup tree
// and /proc and sends SIGKILL: it configures nothing in Incus. With forge's
// raw.idmap, the processes of the container's aiuser are the forge user's own
// on the host, so no privilege is needed to kill them. It watches the team
// containers (agent-*) only, never forge-proxy. After a kill it has `forge
// notify` tell the agent's session; that command, which only the host can run,
// writes the line and cleans the process name, which comes from the container.
//
// Settings come from the environment (the unit sets them from the Ansible
// role's variables). What it does goes to stdout, which is the journal.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  // cgroup v2 root, and the start of the names it watches: Incus names the
  // cgroup of container <c> in project <p> "lxc.payload.<p>_<c>".
  cgroupRoot: string;
  prefix: string;
  // The start of the container names in that project: the project's containers
  // are all named agent-… (agent-control, agent-executor-<n>); forge-proxy is not one.
  containerPrefix: string;
  procRoot: string;
  // `full avg10`, in percent, to reach and hold for `seconds`.
  threshold: number;
  seconds: number;
  intervalMs: number;
  // The user whose processes can be killed: this one.
  uid: number;
};

// `name` is the kernel's comm; `label` is what the agent is told, from the command line.
export type Proc = { pid: number; name: string; label: string; rssKib: number; uid: number; args: string[]; containerInit: boolean };

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// `full avg10=51.87 avg60=…` → 51.87; null when the file is unreadable (a
// kernel without PSI, or a container that just went away).
export function fullAvg10(pressure: string | null): number | null {
  const line = pressure?.split("\n").find((l) => l.startsWith("full "));
  const m = line?.match(/\bavg10=(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// The pids of a cgroup and of every cgroup under it: cgroup.procs lists only
// the processes that sit in that very cgroup, and a container's are spread
// over init.scope, system.slice, user.slice…
function cgroupPids(dir: string): number[] {
  const pids = (read(join(dir, "cgroup.procs")) ?? "").split("\n").filter(Boolean).map(Number);
  let children: string[] = [];
  try {
    children = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // The cgroup is gone.
  }
  for (const child of children) pids.push(...cgroupPids(join(dir, child)));
  return pids;
}

// The command's name from its command line: the base name of argv[0] and, for
// an interpreter, that of its script (`node grow.js`). The comm is not that:
// Node renames its main thread `MainThread`. Null for an empty command line.
const INTERPRETERS = /^(node|python[0-9.]*|bash|sh)$/;
// The options that take the code itself, which is no script's name.
const CODE_OPTIONS = new Set(["-e", "-p", "-c", "--eval", "--print"]);
export function commandName(args: string[]): string | null {
  if (args.length === 0) return null;
  const command = basename(args[0]);
  if (!INTERPRETERS.test(command)) return command;
  for (const a of args.slice(1)) {
    if (CODE_OPTIONS.has(a)) break;
    if (!a.startsWith("-")) return `${command} ${basename(a)}`;
  }
  return command;
}

// null for a process that has exited since, or a kernel thread (no VmRSS).
export function readProc(procRoot: string, pid: number): Proc | null {
  const status = read(join(procRoot, String(pid), "status"));
  if (status === null) return null;
  const field = (key: string) => status.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1];
  const rss = field("VmRSS")?.match(/^(\d+)/)?.[1];
  const uid = field("Uid")?.match(/^(\d+)/)?.[1];
  if (rss === undefined || uid === undefined) return null;
  // NSpid lists the pid in each namespace, the reader's first: the second is
  // the one inside the Incus container. A process of a nested namespace (a
  // rootless Docker container) has a third, so "1" there is not the
  // container's init.
  const nspid = (field("NSpid") ?? "").split(/\s+/);
  const args = (read(join(procRoot, String(pid), "cmdline")) ?? "").split("\0").filter(Boolean);
  const name = field("Name") ?? "?";
  return {
    pid, name, label: commandName(args) ?? name, rssKib: Number(rss), uid: Number(uid), args,
    containerInit: nspid[1] === "1",
  };
}

// Claude Code, as a binary or as a script run by node.
const isClaude = (p: Proc): boolean =>
  p.name === "claude" || p.args.slice(0, 2).some((a) => basename(a) === "claude");

// The biggest by RSS among those that may be killed: not the container's PID 1
// (killing it stops the container), not claude (the agent: the point is to
// free it, not to end it), and only the forge user's own processes (the rest,
// root's inside the container, is out of reach without privilege, and not the
// agent's to begin with).
export function pickVictim(procs: Proc[], uid: number): Proc | null {
  const killable = procs.filter((p) => !p.containerInit && !isClaude(p) && p.uid === uid);
  return killable.reduce<Proc | null>((best, p) => (best === null || p.rssKib > best.rssKib ? p : best), null);
}

// The `forge notify` call: the container, the numbers, and the process name,
// which the container wrote, on stdin: no text from an agent goes in the argv
// of a host command. forge notify cleans and cuts the name.
export function notifyCall(container: string, v: Proc): { args: string[]; input: string } {
  return {
    args: ["notify", container, "memory-kill", "--pid", String(v.pid), "--rss-kib", String(v.rssKib)],
    input: v.label,
  };
}

const gib = (kib: number) => kib >= 1048576 ? `${(kib / 1048576).toFixed(1)} GiB` : `${Math.round(kib / 1024)} MiB`;

export type Deps = {
  now: () => number; kill: (pid: number) => void; log: (line: string) => void;
  // Tells the container's session about the kill; it does not wait.
  notify: (container: string, victim: Proc) => void;
};

export function createWatchdog(config: Config, deps: Deps) {
  // Since when each cgroup has been at or above the threshold, without a break.
  const since = new Map<string, number>();
  // A cgroup with nothing killable is said once per episode, not every tick.
  const unkillable = new Set<string>();

  function tick(): void {
    let names: string[] = [];
    try {
      names = readdirSync(config.cgroupRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(config.prefix + config.containerPrefix)).map((e) => e.name);
    } catch (e) {
      deps.log(`cannot list ${config.cgroupRoot}: ${(e as Error).message}`);
    }
    for (const gone of [...since.keys()].filter((n) => !names.includes(n))) since.delete(gone);
    for (const name of names) check(name);
  }

  function check(name: string): void {
    const dir = join(config.cgroupRoot, name);
    const full = fullAvg10(read(join(dir, "memory.pressure")));
    if (full === null || full < config.threshold) {
      since.delete(name);
      unkillable.delete(name);
      return;
    }
    const start = since.get(name) ?? deps.now();
    since.set(name, start);
    const held = (deps.now() - start) / 1000;
    if (held < config.seconds) return;

    const container = name.slice(config.prefix.length);
    const procs = cgroupPids(dir).map((pid) => readProc(config.procRoot, pid)).filter((p): p is Proc => p !== null);
    const victim = pickVictim(procs, config.uid);
    const why = `memory.pressure full avg10=${full} has been ${config.threshold} or above for ${Math.round(held)} s`;
    if (victim === null) {
      if (!unkillable.has(name)) {
        unkillable.add(name);
        deps.log(`${container}: ${why}, and no process can be killed (not PID 1, not claude, only ${config.uid}'s)`);
      }
      return;
    }
    try {
      deps.kill(victim.pid);
      deps.log(`${container}: killed pid ${victim.pid} (${victim.label}, ${gib(victim.rssKib)} RSS), the biggest of its processes: ${why}`);
      deps.notify(container, victim);
    } catch (e) {
      deps.log(`${container}: could not kill pid ${victim.pid} (${victim.label}): ${(e as Error).message}`);
    }
    // The pressure average takes about 10 s to fall: wait for the threshold
    // to hold again before killing a second process.
    since.delete(name);
  }

  return { tick };
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number, got: ${raw}`);
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv, uid: number): Config {
  return {
    cgroupRoot: env.FORGE_WATCHDOG_CGROUP_ROOT || "/sys/fs/cgroup",
    prefix: env.FORGE_WATCHDOG_PREFIX || "lxc.payload.agent-forge_",
    containerPrefix: env.FORGE_WATCHDOG_CONTAINER_PREFIX || "agent-",
    procRoot: env.FORGE_WATCHDOG_PROC_ROOT || "/proc",
    threshold: number(env, "FORGE_WATCHDOG_THRESHOLD", 20),
    seconds: number(env, "FORGE_WATCHDOG_SECONDS", 15),
    intervalMs: number(env, "FORGE_WATCHDOG_INTERVAL", 1) * 1000,
    uid,
  };
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env, process.getuid!());
  const log = (line: string) => console.log(line);
  const forge = process.env.FORGE_WATCHDOG_FORGE || "forge";
  // argv, never a shell, and the process name on stdin. Its failure is only logged.
  const notify = (container: string, v: Proc) => {
    const { args, input } = notifyCall(container, v);
    const child = execFile(forge, args, { timeout: 60_000 },
      (err, _out, stderr) => { if (err) log(`${container}: could not tell its session: ${(stderr || err.message).trim().split("\n")[0]}`); });
    // A command that exits before reading its input is not an error of ours.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  };
  const dog = createWatchdog(config, { now: Date.now, kill: (pid) => process.kill(pid, "SIGKILL"), log, notify });
  log(`watching ${config.cgroupRoot}/${config.prefix}${config.containerPrefix}*: kills the biggest process when memory.pressure full avg10 ` +
    `stays at ${config.threshold} or above for ${config.seconds} s`);
  for (;;) {
    dog.tick();
    await new Promise((r) => setTimeout(r, config.intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
