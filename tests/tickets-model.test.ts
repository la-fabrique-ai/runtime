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
