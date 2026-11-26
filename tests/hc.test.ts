import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLocalHc, compareVersions, HC_MIN_VERSION, parseHcVersion } from "../cli/lib/hc.ts";
import { fakeContext } from "./lib/fake-context.ts";
import { repoRoot } from "../cli/lib/paths.ts";

const hc = (stdout: string) => fakeContext({ rules: [{ match: "hc --version", stdout }] });

test("the Mac's minimum hc is at or below the image's", () => {
  const defaults = readFileSync(join(repoRoot(), "ansible/roles/forge_image/defaults/main.yml"), "utf8");
  const image = parseHcVersion(/^forge_image_hc_version:\s*"([^"]+)"/m.exec(defaults)?.[1] ?? "");
  assert.ok(image, "forge_image_hc_version is an x.y.z version");
  assert.ok(compareVersions(parseHcVersion(HC_MIN_VERSION)!, image) <= 0);
});

test("checkLocalHc accepts a 0.x version above the minimum", async () => {
  await checkLocalHc(hc("hc 0.1.22\n"));
});

test("checkLocalHc refuses a version below the minimum, naming it", async () => {
  await assert.rejects(checkLocalHc(hc("hc 0.1.20\n")), (e: Error) => e.message.includes(`hc ${HC_MIN_VERSION} or a later 0.x`));
});

test("checkLocalHc refuses a version outside the 0.x line", async () => {
  await assert.rejects(checkLocalHc(hc("hc 1.0.0\n")), /hc 0\.x only, and found 1\.0\.0/);
});

test("checkLocalHc refuses an unreadable `hc --version`", async () => {
  await assert.rejects(checkLocalHc(hc("herdr-core dev build\n")), /cannot read the version/);
});
