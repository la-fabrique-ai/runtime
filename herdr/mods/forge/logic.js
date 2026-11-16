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
// pile up SSH sessions (the part 2 acceptance run saturated one). The inbox asks
// for a poll after an answer (`requestedMs`): granted once, when it came after
// the last poll began, still one call at a time.
export function shouldPoll(inFlight, lastStartMs, nowMs, requestedMs = null) {
  if (inFlight) return false;
  if (lastStartMs === null) return true;
  if (typeof requestedMs === "number" && requestedMs > lastStartMs) return true;
  return nowMs - lastStartMs >= POLL_EVERY_MS;
}

export function notificationFor(host, question) {
  return {
    title: `Question from ${clean(question.from)}`,
    body: [...clean(question.summary)].slice(0, BODY_MAX).join(""),
  };
}

// The arguments of `space.new` for the watch of `host` and for the sync of `team`
// on `host`. `machine: ""` is the dev machine: without it a click would open the
// space on the machine of the space being looked at, an agent's container. `tab`
// names the tab, which would otherwise take the name of the process.
export function watchSpace(host) {
  const name = `forge team ${host}`;
  return { name, tab: name, machine: "", argv: ["forge", "team", "watch", "--host", host] };
}

export function syncSpace(host, team) {
  const name = `forge sync ${team}`;
  return { name, tab: name, machine: "", argv: ["forge", "team", "sync", team, "--host", host] };
}

// The inbox (#170): every host's open questions in a window of this mod, where
// the person reads one and answers it in place. The bar is the only poller: it
// shares its report, the window reads it, and asks for a poll after an answer.

// The shared values (`shared`/`setShared`, seen by every copy of the mod): the
// bar's last report, and the time the inbox last asked for a poll.
export const REPORT_KEY = "forge.report";
export const POLL_KEY = "forge.pollNow";

// Newest first, keyed `<host>#<id>` (ids are per host). A host in error has none
// to show; a question answered from this window is left out until the next poll.
export function inboxItems(report, answered) {
  const items = [];
  for (const h of report?.hosts ?? []) {
    if (h.error !== null) continue;
    for (const question of h.questions) {
      const key = keyOf(h.host, question.id);
      if (answered.has(key)) continue;
      items.push({
        key, host: h.host, id: question.id, from: clean(question.from), time: question.time,
        summary: clean(question.summary), hasBody: question.hasBody === true,
      });
    }
  }
  return items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

// The selected question while it is still there, else the newest one.
export function keepSelection(items, selected) {
  if (items.some((i) => i.key === selected)) return selected;
  return items[0]?.key ?? null;
}

export function ageLabel(time, nowMs) {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(time)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export const questionArgs = (host, id) => ["team", "question", String(id), "--json", "--host", host];

// The text is the person's own, typed on this machine; `--` keeps a leading dash
// a word of the answer rather than an option. forge splits a long text into a
// summary and a body itself, and sends it to the host on stdin, never in argv.
export const answerArgs = (host, id, text) => ["answer", "--json", "--host", host, "--", String(id), text];

// A command's one line of JSON, or the first line of its error.
function outcome(r, read) {
  if (r.code !== 0) return { ok: false, error: clean(r.stderr.trim().split("\n")[0] || `exit code ${r.code}`) };
  try {
    const value = read(JSON.parse(r.stdout.trim().split("\n").at(-1)));
    if (value !== null) return { ok: true, ...value };
  } catch {
    // Falls through: what forge printed is not the JSON line.
  }
  return { ok: false, error: "unreadable answer from forge" };
}

// The body keeps its line breaks; every other control character goes.
const cleanText = (text) => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export function questionOutcome(r) {
  return outcome(r, (q) => typeof q?.id !== "number" ? null : { question: {
    id: q.id, from: clean(q.from), time: String(q.time), state: q.state === "answered" ? "answered" : "open",
    summary: clean(q.summary), body: typeof q.body === "string" ? cleanText(q.body) : null,
  } });
}

export function answerOutcome(r) {
  return outcome(r, (a) => typeof a?.delivered !== "boolean" ? null : { delivered: a.delivered, to: clean(a.to) });
}

// One window, kept where the person drops it; opening it again (a notification,
// the bar) replaces it in place, on the question asked for.
export function inboxWindow(focus) {
  return { mod: "forge", kind: "window", key: "forge-inbox", width: 0.9, height: 0.8, props: { view: "inbox", focus } };
}
