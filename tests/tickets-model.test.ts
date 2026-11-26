import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConnectorError,
  isBranchBase,
  isSubtaskId,
  isTicketId,
  parseSubtask,
  parseTicket,
} from "../cli/lib/tickets/model.ts";

const ticket = {
  id: "T-1",
  title: "a",
  description: "",
  status: "dev",
  priority: 2,
  repositories: [{ name: "web", base: "main" }],
};

test("isTicketId", () => {
  for (const ok of ["T-1", "WEB-120"]) assert.ok(isTicketId(ok), ok);
  for (const bad of ["t-1", "T-0", "T-01", "../T-1", "T-1/x", "T-1 ", ""]) assert.ok(!isTicketId(bad), bad);
});

test("isSubtaskId", () => {
  assert.ok(isSubtaskId("T-1.2"));
  for (const bad of ["T-1.0", "T-1.", "T-1.2.3"]) assert.ok(!isSubtaskId(bad), bad);
});

test("isBranchBase", () => {
  assert.ok(isBranchBase("main"));
  assert.ok(isBranchBase("stack:T-1"));
  assert.ok(!isBranchBase("--upload-pack=x"));
  assert.ok(!isBranchBase("stack:../x"));
  for (const bad of ["a..b", "x.lock", "/x", "x/", "a//b", "x."]) assert.ok(!isBranchBase(bad), bad);
  assert.ok(isBranchBase("release/1.2"));
});

test("parseTicket renvoie un ticket valide tel quel", () => {
  assert.deepEqual(parseTicket(ticket), ticket);
});

test("parseTicket rejette les champs invalides", () => {
  assert.throws(() => parseTicket({ ...ticket, status: "bogus" }), (e) => e instanceof ConnectorError && /status/.test(e.message));
  assert.throws(() => parseTicket({ ...ticket, priority: 5 }), /priority/);
  assert.throws(
    () => parseTicket({ ...ticket, repositories: [{ name: "web", base: "--upload-pack=x" }] }),
    /base/,
  );
});

test("parseSubtask rejette un id invalide", () => {
  assert.throws(() => parseSubtask({ id: "../x" }), (e) => e instanceof ConnectorError && /id/.test(e.message));
});

test("parseSubtask relit fixes et branch avec les mêmes règles", () => {
  const ok = { id: "T-1.1", ticket: "T-1", repository: "api", position: 1, rank: 1, status: "ready", kind: "implementation", fixes: null, reason: null, branch: null, pr: "libre #1", text: "" };
  assert.doesNotThrow(() => parseSubtask({ ...ok, fixes: "T-1.2", branch: "agent/x" }));
  assert.throws(() => parseSubtask({ ...ok, fixes: "../x" }), ConnectorError);
  assert.throws(() => parseSubtask({ ...ok, branch: "stack:T-2" }), ConnectorError);
  assert.throws(() => parseSubtask({ ...ok, branch: "a..b" }), ConnectorError);
});
