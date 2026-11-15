// The forge mod for Herdr App (DX 5, §5.6): a one-line bar, docked at the bottom
// (a mod runs only where it is shown). It polls `forge team inbox --json` (one
// call at a time, at most every 30 s), notifies each new question, and opens
// `forge team watch`. Everything that decides something is in logic.js; this
// file only calls it and the app's API (`herdr.d.ts`, `gpui-kit.d.ts`).
import { View, div } from "gpui-kit";
import { exec, nextCommand, notify, run, spaces, theme } from "herdr";
import { barText, newQuestions, notificationFor, shouldPoll, spaceRenames } from "./logic.js";

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

export default class ForgeBar extends View {
  init(_props, cx) {
    this.report = null;
    this.seen = loadSeen();
    this.inFlight = false;
    this.lastStart = null;
    this.renamed = new Set();
    // Key commands ("forge.watch", "forge.sync" in keys.json, or a toast's
    // action) arrive as the bare command name. Their own loop: it waits.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
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
    if (!shouldPoll(this.inFlight, this.lastStart, Date.now())) return;
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
      for (const { host, question } of newQuestions(this.seen, this.report)) {
        notify({ ...notificationFor(host, question), level: "info", action: { name: "forge.watch" } });
      }
      saveSeen(this.seen);
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
    const name = `forge team ${host}`;
    const open = spaces().find((s) => s.name === name);
    if (open !== undefined) run("space.select", { id: open.id });
    else run("space.new", { name, argv: ["forge", "team", "watch", "--host", host] });
  }

  // `forge team sync <team>` needs the forwarded SSH agent: a terminal, one space per team.
  sync() {
    for (const h of this.report?.hosts ?? []) {
      for (const team of h.teams ?? []) {
        run("space.new", { name: `forge sync ${team}`, argv: ["forge", "team", "sync", team, "--host", h.host] });
      }
    }
  }

  render(_cx) {
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
      .on_click(() => this.watch())
      .child(div().truncate().child(text));
  }
}
