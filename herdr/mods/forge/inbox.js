// The inbox (#170): a window of the forge mod where the person reads the agents'
// questions and answers them in place, like mail. The bar is the only poller:
// this window reads the report it shares, loads a question's body when it is
// shown, and asks the bar for a poll after an answer. Every decision is in
// logic.js; this file draws and calls forge.
import { div } from "gpui-kit";
import { h_flex, Textarea, TextareaState, v_flex } from "gpui-base";
import { closeOverlay, exec, props, run, setShared, shared, spaces, theme } from "herdr";
import {
  ageLabel, answerArgs, answerOutcome, inboxItems, keepSelection, POLL_KEY, questionArgs, questionOutcome, REPORT_KEY,
  watchSpace,
} from "./logic.js";

const BODY_LINES_MAX = 2000;

export class Inbox {
  constructor(p, cx) {
    this.selected = typeof p?.focus === "string" ? p.focus : null;
    this.answered = new Set(); // keys answered from here, hidden until the next poll
    this.bodies = new Map(); // key -> { loading } | { question } | { error }
    this.sending = false;
    this.note = null; // { ok, text }: what the last answer did
    this.handle = cx.focus_handle();
    this.reply = TextareaState.new({ placeholder: "Your answer", rows: 3 });
    this.reply.set_auto_grow(3, 8);
    // ⌘↩ sends; a plain ↩ is a new line of the answer.
    this.reply.on("submit", (e, cx) => {
      if (e.secondary) this.send(cx);
    });
    this.reply.focus();
    // A fresh report on open; the body of the shown question once it is known.
    setShared(POLL_KEY, Date.now());
    cx.timer.every(1000, (cx) => this.loadBody(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  items() {
    return inboxItems(shared(REPORT_KEY) ?? null, this.answered);
  }

  current(items) {
    this.selected = keepSelection(items, this.selected);
    return items.find((i) => i.key === this.selected) ?? null;
  }

  select(key, cx) {
    if (key === this.selected) return;
    this.selected = key;
    this.note = null;
    this.loadBody(cx);
    cx.notify();
  }

  // One call for the shown question's body, when it has one and it is not loaded.
  loadBody(cx) {
    const item = this.current(this.items());
    if (item === null || !item.hasBody || this.bodies.has(item.key)) return;
    this.bodies.set(item.key, { loading: true });
    cx.spawn(async (cx) => {
      const r = await exec("forge", questionArgs(item.host, item.id), { timeout: 25000 });
      const o = questionOutcome(r);
      this.bodies.set(item.key, o.ok ? { question: o.question } : { error: o.error });
      cx.notify();
    });
    cx.notify();
  }

  send(cx) {
    const item = this.current(this.items());
    const text = this.reply.value().trim();
    if (item === null || this.sending) return;
    if (text === "") {
      this.note = { ok: false, text: "Write an answer first." };
      cx.notify();
      return;
    }
    this.sending = true;
    this.note = null;
    cx.spawn(async (cx) => {
      const o = answerOutcome(await exec("forge", answerArgs(item.host, item.id, text), { timeout: 30000 }));
      this.sending = false;
      if (o.ok) {
        this.answered.add(item.key);
        this.reply.set_value("");
        this.note = { ok: true, text: o.delivered
          ? `Answer to #${item.id} delivered to ${o.to}.`
          : `Answer to #${item.id} recorded: ${o.to} has no live session, it will not see it.` };
        setShared(POLL_KEY, Date.now());
      } else {
        this.note = { ok: false, text: o.error };
      }
      cx.notify();
    });
    cx.notify();
  }

  // The team's watch, in its own space on this machine (as the bar opens it).
  watch(host) {
    const args = watchSpace(host);
    const open = spaces().find((s) => s.name === args.name);
    if (open !== undefined) run("space.select", { id: open.id });
    else run("space.new", args);
  }

  close() {
    closeOverlay(props().overlay);
  }

  render(_cx) {
    const t = theme();
    const items = this.items();
    const item = this.current(items);
    const hosts = new Set(items.map((i) => i.host));
    const down = ((shared(REPORT_KEY) ?? { hosts: [] }).hosts ?? []).filter((h) => h.error !== null).map((h) => h.host);
    const now = Date.now();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, primary, enabled, onClick) =>
      h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(7).text_size(12)
        .bg(primary && enabled ? t.solid : t.raised).text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
        .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { if (enabled) onClick(cx); })
        .child(label);

    const header = h_flex().h(44).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(14).font_semibold().child("Questions"))
      .child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(String(items.length)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(down.length > 0 ? `${down.join(", ")} not answering` : ""))
      .when(item !== null, (e) => e.child(button("inbox-team", "Team", false, true, () => this.watch(item.host))))
      .child(button("inbox-close", "Close", false, true, () => this.close()));

    const row = (i) => v_flex().id(`inbox-${i.key}`).px(12).py(8).gap(2).flex_none().cursor_pointer().border_b(1).border_color(t.border)
      .when(i.key === this.selected, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(i.key, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(i.from))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ageLabel(i.time, now))))
      .child(div().truncate().text_color(t.muted).child(i.summary))
      .when(hosts.size > 1, (e) => e.child(div().text_size(11).text_color(t.dim).child(i.host)));

    const list = v_flex().id("inbox-list").w(300).flex_none().h_full().overflow_y_scrollbar().border_r(1).border_color(t.border)
      .children(items.map(row))
      .when(items.length === 0, (e) => e.child(div().p(14).text_color(t.dim).child(shared(REPORT_KEY) ? "No open question." : "Waiting for the forge bar…")));

    const loaded = item === null ? undefined : this.bodies.get(item.key);
    const bodyLines = loaded?.question?.body?.split("\n") ?? [];
    const body = item === null || !item.hasBody ? null
      : loaded === undefined || loaded.loading ? div().text_color(t.dim).child("Loading the detail…")
      : loaded.error !== undefined ? div().text_color(t.ansi1).child(`The detail could not be read: ${loaded.error}`)
      : v_flex().gap(2).children(bodyLines.slice(0, BODY_LINES_MAX).map((l) => div().min_h(16).child(l)))
        .when(bodyLines.length > BODY_LINES_MAX, (e) => e.child(div().text_color(t.dim).child(`… ${bodyLines.length - BODY_LINES_MAX} more lines: forge team question ${item.id}`)));

    const detail = item === null
      ? v_flex().flex_1().h_full().items_center().justify_center().text_color(t.dim).child(this.note?.text ?? "Nothing to answer.")
      : v_flex().flex_1().min_w(0).h_full()
        .child(v_flex().id("inbox-detail").flex_1().min_h(0).overflow_y_scrollbar()
          .child(v_flex().w_full().flex_none().p(16).gap(10)
            .child(div().text_size(11).text_color(t.dim).child(`#${item.id} · ${item.from} · ${item.host} · ${ageLabel(item.time, now)}`))
            .child(div().w_full().text_size(15).font_semibold().child(item.summary))
            .when(body !== null, (e) => e.child(div().w_full().h(1).bg(t.border)).child(body))))
        .child(v_flex().flex_none().p(12).gap(8).border_t(1).border_color(t.border)
          .when(this.note !== null, (e) => e.child(div().text_size(12).text_color(this.note.ok ? t.ansi2 : t.ansi1).child(this.note.text)))
          .child(h_flex().gap(8).items_end()
            .child(div().id("inbox-reply").flex_1().min_w(0).px(10).py(6).rounded(8).border_1().border_color(t.border).cursor_text()
              .on_mouse_down("left", stop)
              .child(Textarea.new(this.reply).w_full().text_size(13).text_color(t.foreground)))
            .child(button("inbox-send", this.sending ? "Sending…" : "Send", true, !this.sending, (cx) => this.send(cx))))
          .child(div().text_size(11).text_color(t.dim).child("⌘↩ sends · Esc closes")));

    return v_flex().id("forge-inbox").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.close();
      })
      .child(header)
      // A row centres its columns: items_stretch gives both the row's height.
      .child(h_flex().flex_1().min_h(0).items_stretch().on_mouse_down("left", stop).child(list).child(detail));
  }
}
