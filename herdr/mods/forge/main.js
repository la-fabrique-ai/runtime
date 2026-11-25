// The forge mod for Herdr App: a one-line bar, docked at the bottom (a mod runs
// only where it is shown). It polls `forge team summary --json` (one call at a
// time, at most every 30 s) and names each agent's space. Everything that
// decides something is in logic.js; this file only calls it and the app's API
// (`herdr.d.ts`, `gpui-kit.d.ts`).
import { View, div } from "gpui-kit";
import { exec, run, spaces, theme } from "herdr";
import { barText, shouldPoll, spaceRenames } from "./logic.js";

const TICK_MS = 5000;

export default class Forge extends View {
  init(_props, cx) {
    this.report = null;
    this.inFlight = false;
    this.lastStart = null;
    this.renamed = new Set();
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
      const r = await exec("forge", ["team", "summary", "--json"], { timeout: 25000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `exit code ${r.code}`);
      this.report = JSON.parse(r.stdout.trim().split("\n").at(-1));
    } catch (e) {
      this.report = { hosts: [{ host: "forge", executors: { working: 0, idle: 0, free: 0 }, orchestrator: null, error: String(e?.message ?? e) }] };
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
      .child(div().truncate().child(text));
  }
}
