import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv, readEnvFile } from "../cli/lib/dotenv.ts";

test("parseDotenv: the strict subset, values taken literally, never run", () => {
  const text = "A=1\nexport B=\"x y\"\nC='$(touch z)'\n# note\n\n";
  assert.deepEqual(parseDotenv("/e", text), [["A", "1"], ["B", "x y"], ["C", "$(touch z)"]]);
});

test("parseDotenv: a bad key or one of forge's own is refused with the line, never the value", () => {
  assert.throws(() => parseDotenv("/e", "1A=x"), /line 1/);
  assert.throws(() => parseDotenv("/e", "A=1\nFORGE_X=1"), /line 2.*forge's own/);
  assert.throws(() => parseDotenv("/e", "CLAUDE_CODE_OAUTH_TOKEN=x"), /forge's own/);
  assert.throws(() => parseDotenv("/e", "bad key=top-secret"), (e: Error) => /line 1/.test(e.message) && !e.message.includes("top-secret"));
});

test("readEnvFile refuses a file others can read, and a missing one, with the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-dotenv-"));
  try {
    const path = join(dir, "env");
    writeFileSync(path, "A=1\n");
    chmodSync(path, 0o644);
    assert.throws(() => readEnvFile(path), (e: Error) => e.message.includes(path) && /group or others/.test(e.message));
    chmodSync(path, 0o600);
    assert.equal(readEnvFile(path), "A=1\n");
    assert.throws(() => readEnvFile(join(dir, "absent")), /absent/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
