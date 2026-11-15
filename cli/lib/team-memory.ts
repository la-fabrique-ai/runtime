// The memory the members' limits promise, against what the host has (#143).
// A container only has to reach its limit for the host to feel it: limits that
// add up to more than the RAM leave the host to the kernel's OOM killer, which
// does not pick containers. Pure arithmetic, plus one read of the reserve.
import { totalmem } from "node:os";
import type { Context } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { members } from "./team.ts";

// The slices Ansible protects with MemoryMin (role forge_memory_watchdog): sshd
// and Incus live in system.slice, the forge user's session and `forge` in user.slice.
export const RESERVED_SLICES = ["system.slice", "user.slice"] as const;

// An Incus size ("12GiB", "512MiB", "4GB") or a percentage of the host's RAM
// ("75%"), in bytes. Config validation already refused anything else.
export function limitBytes(limit: string, ramBytes: number): number {
  const percent = limit.match(/^(\d+)%$/);
  if (percent) return Math.floor((ramBytes * Number(percent[1])) / 100);
  const m = limit.match(/^([0-9]+(?:\.[0-9]+)?)([kKMGTPE]?)(i?)B$/);
  if (!m) return 0;
  // "GiB" is 1024 cubed, "GB" 1000 cubed; no prefix, bytes.
  const power = ("kmgtpe".indexOf(m[2].toLowerCase()) + 1);
  return Math.floor(Number(m[1]) * (m[3] === "i" ? 1024 : 1000) ** power);
}

// What the Ansible role keeps for the host: the sum of the slices' MemoryMin.
// `infinity`, an unreadable value or a missing systemctl count for nothing:
// the warning then compares against the whole RAM, which is the safe side.
export async function hostReserveBytes(ctx: Context): Promise<number> {
  let total = 0;
  for (const slice of RESERVED_SLICES) {
    const r = await ctx.exec(["systemctl", "show", "-p", "MemoryMin", "--value", slice]);
    const value = r.stdout.trim();
    if (r.code === 0 && /^[0-9]+$/.test(value)) total += Number(value);
  }
  return total;
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

// The warning, or null when the limits fit. Every declared member counts: the
// containers share one host whichever team converge was asked for.
export function memoryWarning(cfg: ForgeConfig, reserveBytes: number, ramBytes: number = totalmem()): string | null {
  const all = members(cfg);
  const promised = all.reduce((sum, m) => sum + limitBytes(m.memory ?? cfg.limits.memory, ramBytes), 0);
  const room = Math.max(0, ramBytes - reserveBytes);
  if (promised <= room) return null;
  return `WARNING: the ${all.length} members' memory limits add up to ${gib(promised)}, more than the ${gib(room)} this host ` +
    `has for them (${gib(ramBytes)} of RAM, ${gib(reserveBytes)} kept for the host). Containers that all fill their limit ` +
    `at once leave the host out of memory. A role with no "memory" gets the profile's limit (limits.memory, ${cfg.limits.memory}): ` +
    "lower a role's \"memory\" or the profile's limit, or use a bigger host.";
}
