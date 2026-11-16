// The forge mod for Herdr App (DX 5, §5.6): a one-line bar, docked at the bottom
// (a mod runs only where it is shown). It polls `forge team inbox --json` (one
// call at a time, at most every 30 s), shares the report, notifies each new
// question, and opens the inbox (#170): the same mod, in a window, with props
// {view: "inbox"} (inbox.js). Everything that decides something is in logic.js;
// these files only call it and the app's API (`herdr.d.ts`, `gpui-kit.d.ts`).
import { View, div } from "gpui-kit";
import { exec, nextCommand, notify, openOverlay, props, run, setShared, shared, spaces, theme } from "herdr";
import { Inbox } from "./inbox.js";
import {
  barText, inboxWindow, newQuestions, notificationFor, POLL_KEY, REPORT_KEY, shouldPoll, spaceRenames, syncSpace, watchSpace,
} from "./logic.js";

const SEEN_KEY = "forge.seen";
const TICK_MS = 5000;

function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    // Without storage, a question is notified again after a restart: harmless.
  }
}

export default class Forge extends View {
  init(_props, cx) {
    // A window opened with props {view: "inbox"} is the inbox; the layout's block is the bar.
    const p = props() ?? {};
    if (p.view === "inbox") {
      this.inbox = new Inbox(p, cx);
      return;
    }
    this.inbox = null;
    this.report = null;
    this.lastNotified = null;
    this.seen = loadSeen();
    this.inFlight = false;
    this.lastStart = null;
    this.renamed = new Set();
    // Key commands ("forge.inbox", "forge.watch", "forge.sync" in keys.json, or
    // a toast's action) arrive as the bare command name. Their own loop: it waits.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "inbox") this.openInbox(this.lastNotified);
        if (command === "watch") this.watch();
        if (command === "sync") this.sync();
        cx.notify();
      }
    });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    this.rename();
    const asked = shared(POLL_KEY);
    if (!shouldPoll(this.inFlight, this.lastStart, Date.now(), typeof asked === "number" ? asked : null)) return;
    cx.spawn(async (cx) => {
      await this.poll();
      this.rename();
      cx.notify();
    });
  }

  // One call at a time, with a timeout a little above the Mac command's own.
  async poll() {
    this.inFlight = true;
    this.lastStart = Date.now();
    try {
      const r = await exec("forge", ["team", "inbox", "--json"], { timeout: 25000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `exit code ${r.code}`);
      this.report = JSON.parse(r.stdout.trim().split("\n").at(-1));
      // A click on a notification opens the inbox on the newest notified question.
      for (const { host, question } of newQuestions(this.seen, this.report)) {
        notify({ ...notificationFor(host, question), level: "info", action: { name: "forge.inbox" } });
        this.lastNotified = `${host}#${question.id}`;
      }
      saveSeen(this.seen);
      setShared(REPORT_KEY, this.report);
    } catch (e) {
      this.report = { hosts: [{ host: "forge", members: { working: 0, idle: 0, free: 0 }, questions: [], teams: [], error: String(e?.message ?? e) }] };
    } finally {
      this.inFlight = false;
    }
  }

  // Each unnamed space of an agent's machine is named after the agent, once.
  rename() {
    const hosts = (this.report?.hosts ?? []).filter((h) => h.error === null).map((h) => h.host);
    for (const { id, name } of spaceRenames(spaces(), hosts)) {
      if (this.renamed.has(id)) continue;
      this.renamed.add(id);
      run("space.rename", { id, name });
    }
  }

  firstHost() {
    return this.report?.hosts.find((h) => h.error === null)?.host;
  }

  // Select the space that already shows the watch, or open it.
  watch(host = this.firstHost()) {
    if (host === undefined) return;
    const args = watchSpace(host);
    const open = spaces().find((s) => s.name === args.name);
    if (open !== undefined) run("space.select", { id: open.id });
    else run("space.new", args);
  }

  // The inbox window, on a question (`<host>#<id>`) or on the newest one.
  openInbox(focus = null) {
    openOverlay(inboxWindow(focus));
  }

  // `forge team sync <team>` needs the forwarded SSH agent: a terminal, one space per team.
  sync() {
    for (const h of this.report?.hosts ?? []) {
      for (const team of h.teams ?? []) {
        run("space.new", syncSpace(h.host, team));
      }
    }
  }

  render(cx) {
    if (this.inbox !== null) return this.inbox.render(cx);
    const t = theme();
    const text = this.report === null ? "forge: …" : barText(this.report);
    return div()
      .id("forge-bar")
      .size_full()
      .px(10)
      .flex()
      .items_center()
      .bg(t.chrome)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.openInbox())
      .child(div().truncate().child(text));
  }
}
