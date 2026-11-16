import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorForgeBar } from "../cli/lib/laptop/herdr-bar.ts";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";

// Herdr App's files live in a temporary home, never the real one.
let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-bar-"));
  saved = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  mkdirSync(join(home, ".config/herdr-app/layouts"), { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const app = (...p: string[]) => join(home, ".config/herdr-app", ...p);
const layout = (name: string, tree: unknown) => writeFileSync(app("layouts", `${name}.json`), JSON.stringify(tree));
const shippedLayouts = (...names: string[]) => writeFileSync(app("installed.json"), JSON.stringify(Object.fromEntries(names.map((n) => [`layout:${n}`, "1"]))));
const SHOWS = (name: string): ExecRule => ({ match: "herdr-app status", stdout: JSON.stringify({ layout: name }) });
const CLONE_OK: ExecRule = { match: "herdr-app do layout.clone", stdout: '{"ok": true}' };
const clones = (calls: string[][]) => calls.filter((c) => c[2] === "layout.clone").map((c) => c[3]);
const BAR = { type: "block", content: { mod: "forge" }, size: 28 };

test("a shipped layout without the bar is copied as forge after a yes, and the copy is named for what is taken", async () => {
  shippedLayouts("main");
  layout("main", { type: "split", children: [{ type: "block", content: { mod: "tabs" } }] });
  const ctx = fakeContext({ rules: [SHOWS("main"), CLONE_OK], answers: [1] });
  assert.equal(await anchorForgeBar(ctx), "layout main copied as forge");
  assert.deepEqual(clones(ctx.calls), ['{"name":"main","as":"forge"}']);
  assert.match(ctx.out_lines.join("\n"), /restart Herdr App/);

  layout("forge", { type: "split", children: [] });
  const again = fakeContext({ rules: [SHOWS("main"), CLONE_OK], answers: [1] });
  await anchorForgeBar(again);
  assert.deepEqual(clones(again.calls), ['{"name":"main","as":"forge-2"}']);
});

test("a refusal, or a copy the app refuses, leaves things as they are and says the command", async () => {
  shippedLayouts("main");
  layout("main", { type: "split", children: [] });
  const no = fakeContext({ rules: [SHOWS("main"), CLONE_OK], answers: [2] });
  assert.equal(await anchorForgeBar(no), "declined");
  assert.deepEqual(clones(no.calls), []);
  assert.match(no.out_lines.join("\n"), /herdr-app do layout.clone '\{"name":"main","as":"forge"\}'/);
  const refused = fakeContext({ rules: [SHOWS("main"), { match: "layout.clone", code: 1, stderr: "name taken" }], answers: [1] });
  assert.equal(await anchorForgeBar(refused), "not copied");
  assert.match(refused.out_lines.join("\n"), /name taken/);
});

test("no question and no change: the app is not running, the layout has the bar at any depth, or it is the person's own", async () => {
  shippedLayouts("main");
  const down = fakeContext({ rules: [{ match: "herdr-app status", code: 1 }] });
  assert.equal(await anchorForgeBar(down), "Herdr App is not running");

  layout("forge", { type: "column", children: [{ type: "row", children: [BAR] }] });
  const has = fakeContext({ rules: [SHOWS("forge")] });
  assert.equal(await anchorForgeBar(has), "in the layout forge");

  layout("mine", { type: "split", children: [] });
  const own = fakeContext({ rules: [SHOWS("mine")] });
  assert.equal(await anchorForgeBar(own), "left as it is");
  assert.match(own.out_lines.join("\n"), /"mod": "forge"/);

  for (const ctx of [down, has, own]) {
    assert.deepEqual(ctx.err_lines, [], "no question asked");
    assert.deepEqual(clones(ctx.calls), []);
  }
});
