import { test } from "node:test";
import assert from "node:assert/strict";
// logic.js is a plain ES module with no import of the app's view library.
// @ts-expect-error: a JavaScript module, not typed
import { barText, newQuestions, notificationFor, shouldPoll, spaceRenames, syncSpace, watchSpace } from "../herdr/mods/forge/logic.js";

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

test("shouldPoll: never while one runs, at most every 30 s", () => {
  assert.equal(shouldPoll(true, null, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 10_000, 1_000_000), false);
  assert.equal(shouldPoll(false, 1_000_000 - 31_000, 1_000_000), true);
  assert.equal(shouldPoll(false, null, 1_000_000), true);
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
