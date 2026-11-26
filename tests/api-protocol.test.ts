import { test } from "node:test";
import assert from "node:assert/strict";
import { checkText, INSTRUCTION_MAX, SUMMARY_ALLOWED } from "../cli/lib/api/protocol.ts";

const TOKEN = "tok-123";

test("an instruction is taken as it is, control characters included, up to its cap", () => {
  checkText("Esc \u001b, Ctrl-C \u0003, fin de collage \u001b[201~", INSTRUCTION_MAX, "instruction", [TOKEN]);
  checkText("x".repeat(INSTRUCTION_MAX), INSTRUCTION_MAX, "instruction", [TOKEN]);
  assert.throws(() => checkText("x".repeat(INSTRUCTION_MAX + 1), INSTRUCTION_MAX, "instruction", []), /instruction is longer.*put it in a file of your branch/);
  assert.throws(() => checkText("  ", INSTRUCTION_MAX, "instruction", []), /instruction is empty/);
});

test("a secret forge handed out is refused without being echoed", () => {
  assert.throws(() => checkText("use tok-123", INSTRUCTION_MAX, "instruction", [TOKEN]),
    (e: Error) => /secret/.test(e.message) && !e.message.includes(TOKEN));
});

test("the characters of a typed notice cannot fake forge's prefix, attach a file or press a key", () => {
  assert.ok(SUMMARY_ALLOWED.test("L’export garde l’ancien séparateur ? « oui » (50 %)"));
  for (const bad of ["[forge]", "@src/app.ts", "`rm`", "a\nb", "\u001b", "$x", "<a>"]) assert.ok(!SUMMARY_ALLOWED.test(bad), bad);
});
