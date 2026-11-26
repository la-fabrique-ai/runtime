import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";

// herdr-core (hc). The image pins an exact version, its sum checked,
// `forge_image_hc_version` in ansible/roles/forge_image/defaults/main.yml.
// The Mac's hc is not forge's to pin: Herdr App updates it by itself. forge
// accepts on the Mac any version of the 0.x line from this minimum on, and
// tests/hc.test.ts keeps the minimum at or below the image's version (#166).
export const HC_MIN_VERSION = "0.1.21";

type Version = [number, number, number];

// The first `x.y.z` (or `vx.y.z`) word of a `hc --version` output, or null.
export function parseHcVersion(text: string): Version | null {
  for (const word of text.split(/\s+/)) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(word);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const INSTALL = "https://herdr.dev: read its installer before running it";

// Herdr App's machines go through the Mac's own hc: checked before a machine
// is added, against the 0.x line and the minimum.
export async function checkLocalHc(ctx: Context): Promise<void> {
  const r = await ctx.exec(["hc", "--version"]);
  if (r.code !== 0) {
    throw new ForgeError(
      `forge needs hc ${HC_MIN_VERSION} or a later 0.x on this machine, and found no hc. ` +
      `Install herdr-core (${INSTALL}), then run the command again.`);
  }
  const found = r.stdout.trim();
  const v = parseHcVersion(found);
  if (!v) {
    throw new ForgeError(
      `forge cannot read the version in \`hc --version\` (${found ? `it printed: ${found}` : "it printed nothing"}). ` +
      `Check that \`hc\` on your PATH is herdr-core's, or reinstall it (${INSTALL}), then run the command again.`);
  }
  const min = parseHcVersion(HC_MIN_VERSION)!;
  if (v[0] !== 0) {
    throw new ForgeError(
      `forge supports hc 0.x only, and found ${v.join(".")}: this forge does not know that line yet. ` +
      `Update forge (a newer checkout may support it), or install a 0.x herdr-core from ${HC_MIN_VERSION} on (${INSTALL}).`);
  }
  if (compareVersions(v, min) < 0) {
    throw new ForgeError(
      `forge needs hc ${HC_MIN_VERSION} or a later 0.x on this machine, and found ${v.join(".")}. ` +
      `Update herdr-core (Herdr App updates it, or ${INSTALL}), then run the command again.`);
  }
}
