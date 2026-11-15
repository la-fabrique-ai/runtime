// The forge mod's logic (DX 5, §5.6): plain functions, no import of the app's
// view library, so that `node --test` runs them. main.js only calls these and the
// app's own API.

export const POLL_EVERY_MS = 30000;
export const BODY_MAX = 120;

// A question's key across hosts: ids are the journal's, per host.
const keyOf = (host, id) => `${host}#${id}`;

// Control characters (C0, DEL, C1): a text from an agent must not move the
// cursor or ring a bell in a notification or a bar.
const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// The questions of `report` not in `seen`, which this adds them to: the same
// report a second time gives none. A host in error has no question to show.
export function newQuestions(seen, report) {
  const fresh = [];
  for (const h of report.hosts) {
    if (h.error !== null) continue;
    for (const question of h.questions) {
      const key = keyOf(h.host, question.id);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ host: h.host, question });
    }
  }
  return fresh;
}

// "forge: 2 working · 1 question", with an unreachable host named. A summary is
// never in the bar: it is text from an agent, and the bar is one line.
export function barText(report) {
  const ok = report.hosts.filter((h) => h.error === null);
  const down = report.hosts.filter((h) => h.error !== null).map((h) => clean(h.host));
  const working = ok.reduce((n, h) => n + h.members.working, 0);
  const questions = ok.reduce((n, h) => n + h.questions.length, 0);
  const parts = [];
  if (working > 0) parts.push(`${working} working`);
  if (questions > 0) parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
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
// pile up SSH sessions (the part 2 acceptance run saturated one).
export function shouldPoll(inFlight, lastStartMs, nowMs) {
  if (inFlight) return false;
  return lastStartMs === null || nowMs - lastStartMs >= POLL_EVERY_MS;
}

export function notificationFor(host, question) {
  return {
    title: `Question from ${clean(question.from)}`,
    body: [...clean(question.summary)].slice(0, BODY_MAX).join(""),
  };
}
