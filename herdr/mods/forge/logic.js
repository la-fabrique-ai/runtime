// The forge mod's logic: plain functions, no import of the app's view library,
// so that `node --test` runs them. main.js only calls these and the app's own API.

export const POLL_EVERY_MS = 30000;

// Control characters (C0, DEL, C1): a text from a host must not move the
// cursor or ring a bell in the bar.
const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// "forge: 2 working · 1 idle · 1 free", an orchestrator that is not active and
// an unreachable host named.
export function barText(report) {
  const ok = report.hosts.filter((h) => h.error === null);
  const down = report.hosts.filter((h) => h.error !== null).map((h) => clean(h.host));
  const sum = (key) => ok.reduce((n, h) => n + (h.executors?.[key] ?? 0), 0);
  const parts = [];
  for (const key of ["working", "idle", "free"]) {
    const n = sum(key);
    if (n > 0) parts.push(`${n} ${key}`);
  }
  for (const h of ok) {
    if (h.orchestrator !== null && h.orchestrator !== "active") parts.push(`${clean(h.host)}: orchestrator ${clean(h.orchestrator)}`);
  }
  if (down.length > 0) parts.push(`${down.join(", ")} unreachable`);
  if (report.hosts.length === 0) parts.push("no host");
  return `forge: ${parts.length === 0 ? "quiet" : parts.join(" · ")}`;
}

// The two "workspace" spaces a machine shows become one named after the agent:
// a space on the Herdr machine `<host>-<member>` that nobody named is renamed
// `<member>`. Only the machine and `named` are read, never the space's id.
export function spaceRenames(spaces, hosts) {
  const byLength = [...hosts].sort((a, b) => b.length - a.length);
  const renames = [];
  for (const space of spaces) {
    if (space.named || typeof space.machine !== "string") continue;
    const host = byLength.find((h) => space.machine.startsWith(`${h}-`) && space.machine.length > h.length + 1);
    if (host !== undefined) renames.push({ id: space.id, name: space.machine.slice(host.length + 1) });
  }
  return renames;
}

// Never while a call is running, and at most every 30 s: a slow host must not
// pile up SSH sessions.
export function shouldPoll(inFlight, lastStartMs, nowMs) {
  if (inFlight) return false;
  if (lastStartMs === null) return true;
  return nowMs - lastStartMs >= POLL_EVERY_MS;
}
