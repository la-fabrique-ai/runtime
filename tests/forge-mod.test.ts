import { test } from "node:test";
import assert from "node:assert/strict";
// logic.js is a plain ES module with no import of the app's view library.
import {
  ageLabel, answerArgs, answerOutcome, barText, inboxItems, inboxWindow, keepSelection, newQuestions, notificationFor,
  questionArgs, questionOutcome, shouldPoll, spaceRenames, syncSpace, watchSpace,
// @ts-expect-error: a JavaScript module, not typed
} from "../herdr/mods/forge/logic.js";

const q = (id: number, from = "agent-web-lead", summary = "Quel séparateur ?") => ({ id, from, time: "2026-11-15T10:00:00Z", summary, hasBody: false });
const host = (name: string, over: object = {}) => ({ host: name, members: { working: 0, idle: 0, free: 0 }, questions: [], teams: [], error: null, ...over });

test("newQuestions: only the ones not seen, and the same report again gives none", () => {
  const seen = new Set(["h#3"]);
  const report = { hosts: [host("h", { questions: [q(3), q(4)] })] };
  assert.deepEqual(newQuestions(seen, report).map((n: { host: string; question: { id: number } }) => [n.host, n.question.id]), [["h", 4]]);
  assert.deepEqual(newQuestions(seen, report), []);
  assert.equal(newQuestions(new Set(), { hosts: [host("h2", { questions: [q(3)], error: "down" })] }).length, 0, "a host in error has no question");
});

test("barText: counts summed over hosts; an unreachable host is named; a summary is never in the bar", () => {
  const report = { hosts: [
    host("a", { members: { working: 1, idle: 0, free: 0 }, questions: [q(1, "x", "SECRET-SUMMARY")] }),
    host("b", { members: { working: 1, idle: 1, free: 2 } }),
  ] };
  assert.equal(barText(report), "forge: 2 working · 1 question");
  assert.ok(!barText(report).includes("SECRET-SUMMARY"));
  assert.equal(barText({ hosts: [host("down", { error: "no answer" })] }), "forge: down unreachable");
  assert.equal(barText({ hosts: [host("a")] }), "forge: quiet");
});

test("spaceRenames: an unnamed space of an agent's machine takes the agent's name; a named one and This computer are left", () => {
  const space = (machine: string | null, named: boolean, id = "s1") => ({ id, named, machine });
  assert.deepEqual(spaceRenames([space("forge-recette-web-dev-1", false)], ["forge-recette"]), [{ id: "s1", name: "web-dev-1" }]);
  assert.deepEqual(spaceRenames([space("forge-recette-web-dev-1", true), space(null, false), space("elsewhere-x", false)], ["forge-recette"]), []);
  // The longest host name wins.
  assert.deepEqual(spaceRenames([space("forge-recette-pilot", false)], ["forge", "forge-recette"]), [{ id: "s1", name: "pilot" }]);
});

test("shouldPoll: never while one runs, at most every 30 s, unless the inbox asked after the last poll began", () => {
  assert.equal(shouldPoll(true, null, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 10_000, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 31_000, 1_000_000), true);
  assert.equal(shouldPoll(false, null, 1_000_000), true);
  assert.equal(shouldPoll(false, 1_000_000 - 10_000, 1_000_000, 1_000_000 - 5_000), true, "asked after the last poll");
  assert.equal(shouldPoll(false, 1_000_000 - 10_000, 1_000_000, 1_000_000 - 15_000), false, "asked before it");
  assert.equal(shouldPoll(true, 1_000_000 - 10_000, 1_000_000, 1_000_000 - 5_000), false, "still one at a time");
});

test("notificationFor: the title names the asker, the body is the summary cut to 120 characters without control characters", () => {
  const n = notificationFor("h", q(1, "agent-web-lead", "x".repeat(200)));
  assert.equal(n.title, "Question from agent-web-lead");
  assert.equal(n.body.length, 120);
  assert.equal(notificationFor("h", q(1, "a", "a\u0007b")).body, "ab");
});

test("watchSpace and syncSpace: opened on the dev machine (machine \"\"), the tab named like the space", () => {
  assert.deepEqual(watchSpace("h"), { name: "forge team h", tab: "forge team h", machine: "", argv: ["forge", "team", "watch", "--host", "h"] });
  assert.deepEqual(syncSpace("h", "web"), { name: "forge sync web", tab: "forge sync web", machine: "", argv: ["forge", "team", "sync", "web", "--host", "h"] });
});

// The inbox (#170): the questions of every host, read and answered in a window.
test("inboxItems: the questions of every answering host, newest first, keyed by host, without control characters", () => {
  const report = { hosts: [
    host("a", { questions: [{ ...q(6), time: "2026-11-14T10:00:00Z" }, { ...q(77, "agent-web-lead", "Garde\u0007 ?"), time: "2026-11-16T09:00:00Z" }] }),
    host("b", { questions: [{ ...q(3, "agent-api-lead"), time: "2026-11-15T10:00:00Z" }] }),
    host("down", { questions: [q(9)], error: "no answer" }),
  ] };
  const items = inboxItems(report, new Set(["a#6"]));
  assert.deepEqual(items.map((i: { key: string }) => i.key), ["a#77", "b#3"], "newest first; one answered here is left out");
  assert.deepEqual([items[0].host, items[0].id, items[0].from, items[0].summary], ["a", 77, "agent-web-lead", "Garde ?"]);
  assert.deepEqual(inboxItems(null, new Set()), []);
});

test("keepSelection: the selected question while it is there, else the newest, else none", () => {
  const items = [{ key: "a#77" }, { key: "b#3" }];
  assert.equal(keepSelection(items, "b#3"), "b#3");
  assert.equal(keepSelection(items, "a#6"), "a#77");
  assert.equal(keepSelection([], "a#6"), null);
});

test("ageLabel: now, minutes, hours, days", () => {
  const now = Date.parse("2026-11-16T10:00:00Z");
  assert.equal(ageLabel("2026-11-16T09:59:40Z", now), "now");
  assert.equal(ageLabel("2026-11-16T09:55:00Z", now), "5 min");
  assert.equal(ageLabel("2026-11-16T07:00:00Z", now), "3 h");
  assert.equal(ageLabel("2026-11-14T10:00:00Z", now), "2 d");
});

test("questionArgs and answerArgs: JSON forms; the answer's text comes after -- so a leading dash stays text", () => {
  assert.deepEqual(questionArgs("h", 77), ["team", "question", "77", "--json", "--host", "h"]);
  assert.deepEqual(answerArgs("h", 77, "-1 suffit"), ["answer", "--json", "--host", "h", "--", "77", "-1 suffit"]);
});

test("questionOutcome and answerOutcome: the JSON line, or the first line of the error", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  assert.deepEqual(questionOutcome(ok('{"id":7,"from":"x","time":"t","state":"open","summary":"S\\u0007","body":"L1\\nL2"}\n')),
    { ok: true, question: { id: 7, from: "x", time: "t", state: "open", summary: "S", body: "L1\nL2" } });
  assert.deepEqual(answerOutcome(ok('{"id":7,"to":"agent-web-lead","delivered":false}\n')), { ok: true, delivered: false, to: "agent-web-lead" });
  assert.deepEqual(answerOutcome({ code: 1, stdout: "", stderr: "Error: no question 7 in the Inbox\nmore\n" }),
    { ok: false, error: "Error: no question 7 in the Inbox" });
  assert.deepEqual(answerOutcome(ok("Answered #7.\n")), { ok: false, error: "unreadable answer from forge" });
  assert.deepEqual(answerOutcome({ code: 1, stdout: "", stderr: "Error: question 7 is already answered\n" }), { ok: true, already: true },
    "sent again after a timeout: the first one went through");
  assert.deepEqual(answerOutcome({ code: 124, stdout: "", stderr: "no reply from forge in 45 s (timeout)" }),
    { ok: false, error: "no reply from forge in 45 s (timeout)" });
});

test("inboxWindow: one kept-in-place window of the forge mod, opened on a question", () => {
  const w = inboxWindow("a#77");
  assert.deepEqual([w.mod, w.kind, w.key], ["forge", "window", "forge-inbox"]);
  assert.deepEqual(w.props, { view: "inbox", focus: "a#77" });
});
