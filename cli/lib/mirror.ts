// The forge-owned bare mirror of a container's GitHub repository.
//
// Host-side git must never run inside ~/workspaces/<container>: the agent
// writes that repository (.git/config, hooks), so any git command there would
// run the agent's commands on the host. Instead forge keeps its own bare
// mirror, outside the workspaces directory, and only ever runs git on it.
// The mirror is mounted read-only in the container, which clones from it.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context, ExecResult } from "./context.ts";
import { ForgeError } from "./context.ts";
import { deviceNames, execAsAgentArgv } from "./incus.ts";
import { mirrorPath, mirrorsDir } from "./paths.ts";
import { validateRepo } from "./validate.ts";

export const MIRROR_MOUNT = "/forge/origin.git";
export const ORIGIN_DEVICE = "origin";

// Where the repository comes from, and which transports git may use for it.
// `lfsUrl` is the Git LFS endpoint of the same repository, when it is not the
// URL itself (an https endpoint ends in /info/lfs); a remote that has none
// uses `url`, which git-lfs reads as an SSH endpoint.
export type GitRemote = { url(ownerRepo: string): string; protocol: string[]; lfsUrl?(ownerRepo: string): string };

// SSH only: every other transport (file, ext, https...) is refused, so a
// hostile URL or redirect cannot reach a local path or run a helper.
export const GITHUB: GitRemote = {
  url: (ownerRepo) => `git@github.com:${ownerRepo}.git`,
  protocol: ["-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always"],
};

// Every host git call runs from "/", not from forge's own working directory:
// forge started from inside ~/workspaces/<c> would otherwise let git discover
// the agent's repository there (its .git/config), even for a --global query.
export const HOST_GIT_CWD = "/";

// Never let git ask a question on a terminal forge does not control.
const GIT_OPTS = { env: { GIT_TERMINAL_PROMPT: "0" }, cwd: HOST_GIT_CWD };

// Reduces a remote URL to its `owner/repo`, whatever its form:
// git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git
// including through an SSH alias (~/.ssh/config), hence the comparison on the
// path alone and not on the host.
export function remoteRepo(url: string): string {
  const match = url.trim().replace(/\.git$/, "").match(/([^/:]+\/[^/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

// The lowercased owner/repo the mirror was cloned from, or null when there is
// no mirror (no exec at all) or git cannot tell. A probe: never fatal.
export async function mirrorRepo(ctx: Context, mirror: string): Promise<string | null> {
  if (!existsSync(mirror)) return null;
  const r = await ctx.exec(["git", `--git-dir=${mirror}`, "config", "--get", "remote.origin.url"], GIT_OPTS);
  if (r.code !== 0) return null;
  return remoteRepo(r.stdout) || null;
}

// Refuses an existing mirror whose repository (mirrorRepo's answer) is not
// ownerRepo: two repos whose names give the same container.
export function requireMirrorOf(mirror: string, ownerRepo: string, found: string | null): void {
  if (found === ownerRepo.toLowerCase()) return;
  throw new ForgeError(
    `${mirror} is a mirror of ${found ?? "an unknown repository"}, not ${ownerRepo}: ` +
    "two repos share the container name. Move it aside and run the command again.");
}

export async function ensureMirror(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<"created" | "kept"> {
  validateRepo(ownerRepo);
  if (existsSync(mirror)) {
    requireMirrorOf(mirror, ownerRepo, await mirrorRepo(ctx, mirror));
    return "kept";
  }
  mkdirSync(dirname(mirror), { recursive: true });
  const r = await ctx.exec(
    ["git", ...remote.protocol, "clone", "--bare", remote.url(ownerRepo), mirror], GIT_OPTS);
  if (r.code !== 0) {
    throw new ForgeError(
      `create mirror failed: ${r.stderr.trim() || `exit code ${r.code}`}\n` +
      "Did your SSH agent reach the host? Run forge team up from your machine: it forwards the agent.");
  }
  return "created";
}

// The URL is on the command line, not read back from the mirror's config, so
// a mirror whose config was altered cannot redirect the fetch. The caller
// decides what a failure means; an invalid repo rejects, like a failed fetch
// would, instead of throwing before the promise exists.
export async function refreshMirror(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<ExecResult> {
  validateRepo(ownerRepo);
  return ctx.exec([
    "git", `--git-dir=${mirror}`, ...remote.protocol,
    "fetch", "--prune", "--no-recurse-submodules", remote.url(ownerRepo),
    "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
  ], GIT_OPTS);
}

// The LFS objects the containers that read them (`lfs: true`) may need: first
// those of the mirror's default branch, then those of the tip of every other
// branch, so a checkout of any branch finds its files. The first fetch is the
// result, and a failure there is fatal for the caller; a failure of the second
// (a branch that points to an object nobody pushed) only comes back as a
// `warning`, or it would fail every sync. Never `--all` nor the tags: a LFS
// file has one version per commit that changes it. Both URLs are on the command
// line: in a bare repository git-lfs reads `HEAD:.lfsconfig`, so a repository
// could otherwise name the endpoint the host sends its credentials to (checked
// on 2026-11-17: the fetch went to the .lfsconfig's host until `lfs.url` was given).
export async function fetchMirrorLfs(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<ExecResult & { warning?: string }> {
  validateRepo(ownerRepo);
  const url = remote.url(ownerRepo);
  const lfs = (refs: string[]) => ctx.exec([
    "git", `--git-dir=${mirror}`, ...remote.protocol,
    "-c", `lfs.url=${remote.lfsUrl ? remote.lfsUrl(ownerRepo) : url}`,
    "lfs", "fetch", url, ...refs,
  ], GIT_OPTS);
  const head = await lfs(["HEAD"]);
  if (head.code !== 0) return head;
  const listed = await ctx.exec(
    ["git", `--git-dir=${mirror}`, "for-each-ref", "--format=%(refname)", "refs/heads"], GIT_OPTS);
  const branches = listed.stdout.split("\n").filter((r) => r !== "");
  if (listed.code !== 0 || branches.length === 0) return head;
  const others = await lfs(branches);
  return others.code === 0 ? head
    : { ...head, warning: `could not fetch the LFS objects of every branch of ${ownerRepo}: ${others.stderr.trim() || `exit code ${others.code}`}` };
}

// What makes git-lfs read its objects from the mirror, a file of the
// container, and not from the network: its own standalone transfer, aimed at
// the mirror. They end up in the workspace's `.git/config` (`git clone -c`
// writes them before the checkout; a reused workspace gets them from
// pinLfsMirror): a `.lfsconfig` of the repository can name any `lfs.url`, but
// a repository's config file wins over it, so a later checkout, rebase or
// `git lfs pull` keeps reading the mirror (spike, 2026-11-17). An object the
// mirror lacks (an old commit, a tag) gives a pointer, not a failed checkout.
export function lfsMirrorConfig(mirror: string = MIRROR_MOUNT): [string, string][] {
  return [
    ["lfs.url", `file://${mirror}`], ["lfs.standalonetransferagent", "lfs-standalone-file"],
    ["lfs.skipdownloaderrors", "true"],
  ];
}

async function pinLfsMirror(ctx: Context, container: string): Promise<ExecResult> {
  let last: ExecResult = { code: 0, stdout: "", stderr: "" };
  for (const [key, value] of lfsMirrorConfig()) {
    last = await execAsAgentArgv(ctx, container, ["git", "-C", "/workspace", "config", key, value]);
    if (last.code !== 0) return last;
  }
  return last;
}

// In the container, as aiuser. Without `lfs`, the LFS smudge is skipped: the
// mirror holds no LFS object and the container has no network path to fetch
// them. With it, the objects are read from the mirror (fetchMirrorLfs put them
// there) and the new clone's config is pinned to it, in the same call.
export function cloneWorkspace(ctx: Context, container: string, lfs = false): Promise<ExecResult> {
  if (!lfs) {
    return execAsAgentArgv(ctx, container,
      ["env", "GIT_LFS_SKIP_SMUDGE=1", "git", "clone", "--no-local", MIRROR_MOUNT, "/workspace"]);
  }
  const config = lfsMirrorConfig().flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  return execAsAgentArgv(ctx, container, ["git", "clone", ...config, "--no-local", MIRROR_MOUNT, "/workspace"]);
}

// A reused workspace may still point at GitHub (or anywhere): re-aim origin.
// A workspace made before `lfs` was turned on keeps its pointers until
// `git lfs pull`: the caller says so.
export async function pointOriginAtMirror(ctx: Context, container: string, lfs = false): Promise<ExecResult> {
  const r = await execAsAgentArgv(ctx, container, ["git", "-C", "/workspace", "remote", "set-url", "origin", MIRROR_MOUNT]);
  return r.code !== 0 || !lfs ? r : pinLfsMirror(ctx, container);
}

export async function hasOriginDevice(ctx: Context, container: string): Promise<boolean> {
  return (await deviceNames(ctx, container)).includes(ORIGIN_DEVICE);
}

// The team mirror (DX 5, §5.5): a bare repository forge fills with the agent
// branches of a team's developers, and that read-team members mount read-only.
// It is not a mirror of GitHub: nothing here comes from the network.
export const TEAM_MOUNT = "/forge/team.git";
export const TEAM_DEVICE = "team";

export function teamMirrorPath(team: string): string {
  return join(mirrorsDir(), `team-${team}.agents.git`);
}

// The hooks are off and received objects are checked: what an agent pushes
// into this repository is data, and nothing in it may run on the host.
export function ensureTeamMirror(ctx: Context, team: string): Promise<"created" | "kept"> {
  return ensureBareTeamMirror(ctx, teamMirrorPath(team));
}

// Le même miroir, à un chemin donné : celui d'une équipe, ou celui d'un dépôt
// d'un projet (forge à tickets).
export async function ensureBareTeamMirror(ctx: Context, mirror: string): Promise<"created" | "kept"> {
  if (existsSync(mirror)) return "kept";
  mkdirSync(dirname(mirror), { recursive: true });
  const init = await ctx.exec(["git", "init", "--bare", "--quiet", mirror], GIT_OPTS);
  if (init.code !== 0) throw new ForgeError(`create team mirror failed: ${init.stderr.trim() || `exit code ${init.code}`}`);
  for (const [key, value] of [["core.hooksPath", "/dev/null"], ["fetch.fsckObjects", "true"]]) {
    const r = await ctx.exec(["git", `--git-dir=${mirror}`, "config", key, value], GIT_OPTS);
    if (r.code !== 0) throw new ForgeError(`configure team mirror failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  return "created";
}

// Le miroir d'origine d'une équipe : une copie du dépôt de l'équipe, que
// `forge team sync` rafraîchit depuis GitHub.
export const originMirrorPath = (team: string) => mirrorPath(`team-${team}`);

// Son âge, en secondes : celui de son FETCH_HEAD, que chaque fetch réécrit,
// même quand il n'apporte rien. Null quand le miroir n'a jamais été rafraîchi.
export function originMirrorAge(team: string, now: Date): number | null {
  try {
    const fetched = statSync(join(originMirrorPath(team), "FETCH_HEAD")).mtimeMs;
    return Math.max(0, Math.round((now.getTime() - fetched) / 1000));
  } catch {
    return null;
  }
}
