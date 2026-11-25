// Starting a project container: make sure it runs, with the egress
// rules honoured.
import type { Context } from "./context.ts";
import { inTime, mustSucceed } from "./context.ts";
import { isRunning } from "./containers.ts";
import { instanceStatus, startInstance } from "./incus.ts";
import { egressBeforeStart } from "./strict.ts";

// Every path that starts a container goes through here (assign and converge). The egress check comes first, even on a
// running container (sub-project 3's contract): a too-old Incus or a
// marker/NIC disagreement is refused before any `incus start`, and a strict
// container gets its proxy started.
// `timeoutMs` : l'`incus start` a un délai (l'API, dans sa file) ; dépassé,
// c'est un refus qui nomme l'étape.
export async function ensureRunning(ctx: Context, container: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await egressBeforeStart(ctx, container);
  if (await isRunning(ctx, container)) return;
  const started = await inTime(`incus start ${container}`, opts.timeoutMs, startInstance(ctx, container, opts));
  if (started.code === 0) return;
  // Another forge may have started it between our check and our start: only a
  // container that is still not Running makes this a failure.
  if ((await instanceStatus(ctx, container)) === "Running") return;
  await mustSucceed("incus start", Promise.resolve(started));
}
