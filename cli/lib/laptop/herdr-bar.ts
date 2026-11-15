// The forge bar in Herdr App's displayed layout (DX 5, §5.6). The app anchors a
// mod's block in the displayed layout the first time it sees the mod's directory,
// but a layout it ships takes only click and look fields: the bar never enters it.
// A copy of that layout is the person's own, and the app anchors the bar there.
// Every file read and every command is Herdr App's own (`herdr-app status`,
// `herdr-app do layout.clone`, layouts/<name>.json, installed.json), as the
// maintainer found them on Herdr App 0.1.16.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { herdrAppDir } from "../paths.ts";

const MOD = "forge";
const LAYOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const layoutsDir = (): string => join(herdrAppDir(), "layouts");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// A mod's block is `{ "type": "block", "content": { "mod": "<name>" }, … }`, at any depth.
export function hasModBlock(node: unknown, mod: string): boolean {
  if (Array.isArray(node)) return node.some((n) => hasModBlock(n, mod));
  if (typeof node !== "object" || node === null) return false;
  const o = node as Record<string, unknown>;
  const content = o.content as Record<string, unknown> | null | undefined;
  if (o.type === "block" && typeof content === "object" && content !== null && content.mod === mod) return true;
  return Object.values(o).some((v) => hasModBlock(v, mod));
}

// The layouts the app ships are the `layout:<name>` keys of installed.json.
function shipped(name: string): boolean {
  const installed = readJson(join(herdrAppDir(), "installed.json"));
  return typeof installed === "object" && installed !== null && `layout:${name}` in installed;
}

const taken = (name: string): boolean => existsSync(join(layoutsDir(), `${name}.json`)) || shipped(name);

function copyName(): string {
  if (!taken(MOD)) return MOD;
  for (let n = 2; ; n++) if (!taken(`${MOD}-${n}`)) return `${MOD}-${n}`;
}

const cloneArgs = (name: string, as: string): string => JSON.stringify({ name, as });

// What the install does about the bar, as a line for its summary. Nothing is
// written unless the displayed layout is one the app ships, without the bar, and
// the person agrees: in every other case, the command or the block to add is shown.
export async function anchorForgeBar(ctx: Context): Promise<string> {
  const status = await ctx.exec(["herdr-app", "status"], { timeoutMs: 10_000 });
  let layout: unknown;
  try {
    layout = (JSON.parse(status.stdout) as { layout?: unknown }).layout;
  } catch {
    layout = undefined;
  }
  if (status.code !== 0 || typeof layout !== "string" || !LAYOUT_NAME.test(layout)) {
    ctx.out("Herdr App is not running: to show the forge bar, start it and run forge install again.");
    return "Herdr App is not running";
  }
  const tree = readJson(join(layoutsDir(), `${layout}.json`));
  if (tree === undefined) {
    ctx.out(`The forge bar: forge could not read the layout ${layout} Herdr App shows; add a block with "content": { "mod": "${MOD}" } to it.`);
    return "left as it is";
  }
  if (hasModBlock(tree, MOD)) return `in the layout ${layout}`;
  if (!shipped(layout)) {
    ctx.out(`The layout ${layout} is yours and has no forge bar: add to ${join(layoutsDir(), `${layout}.json`)} a block with "content": { "mod": "${MOD}" }.`);
    return "left as it is";
  }
  const as = copyName();
  const command = `herdr-app do layout.clone '${cloneArgs(layout, as)}'`;
  const question = `Herdr App shows the layout ${layout}, which it ships and which cannot take the forge bar. Copy it as ${as} and show the copy? The app never updates a copy again.`;
  if ((await ctx.prompt.pick(question, ["yes", "no"])) !== 1) {
    ctx.out(`The forge bar stays out: to show it, run ${command}`);
    return "declined";
  }
  const r = await ctx.exec(["herdr-app", "do", "layout.clone", cloneArgs(layout, as)], { timeoutMs: 10_000 });
  let ok = false;
  try {
    ok = r.code === 0 && (JSON.parse(r.stdout) as { ok?: unknown }).ok === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    ctx.out(`herdr-app could not copy the layout ${layout}: ${r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`}`);
    return "not copied";
  }
  ctx.out(`Herdr App now shows the layout ${as}. If the forge bar does not appear by itself, restart Herdr App.`);
  return `layout ${layout} copied as ${as}`;
}
