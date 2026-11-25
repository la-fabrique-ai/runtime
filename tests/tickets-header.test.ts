import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDocument, parseDocument } from "../cli/lib/tickets/header.ts";

test("aller-retour avec un corps qui ressemble à un en-tête", () => {
  const fields = { id: "T-1", status: "open" };
  const body = "status: done\n\nsuite\n\n\nfin\n";
  assert.deepEqual(parseDocument(formatDocument(fields, body)), { fields, body });
});

test("une valeur vide revient en chaîne vide", () => {
  const { fields } = parseDocument(formatDocument({ branch: "" }, "x"));
  assert.equal(fields.branch, "");
});

test("sans ligne vide, tout est en-tête", () => {
  assert.deepEqual(parseDocument("id: T-1"), { fields: { id: "T-1" }, body: "" });
});

test("une clé répétée est refusée", () => {
  assert.throws(() => parseDocument("id: T-1\nid: T-2\n\nx"), /repeated/);
});

test("une ligne qui n'est pas un champ est refusée", () => {
  assert.throws(() => parseDocument("not a field\n\nx"));
});

test("formatDocument refuse un saut de ligne dans une valeur", () => {
  assert.throws(() => formatDocument({ title: "x\nstatus: done" }, ""), /newline/);
});

test("formatDocument refuse une clé invalide", () => {
  assert.throws(() => formatDocument({ "Bad Key": "x" }, ""), /key/);
});
