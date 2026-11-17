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

// The LFS objects of the mirror's default branch, for the containers that read
// them (`lfs: true`). Both URLs are on the command line: in a bare repository
// git-lfs reads `HEAD:.lfsconfig`, so a repository could otherwise name the
// endpoint the host sends its credentials to (checked on 2026-11-17: the fetch
// went to the .lfsconfig's host until `lfs.url` was given). `HEAD`, never
// `--all`: a LFS file has one version per commit that changes it.
export async function fetchMirrorLfs(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<ExecResult> {
  validateRepo(ownerRepo);
  const url = remote.url(ownerRepo);
  return ctx.exec([
    "git", `--git-dir=${mirror}`, ...remote.protocol,
    "-c", `lfs.url=${remote.lfsUrl ? remote.lfsUrl(ownerRepo) : url}`,
    "lfs", "fetch", url, "HEAD",
  ], GIT_OPTS);
}

// In the container, as aiuser. LFS smudge is skipped: the mirror holds no
// LFS objects and the container has no network path to fetch them.
export function cloneWorkspace(ctx: Context, container: string): Promise<ExecResult> {
  return execAsAgentArgv(ctx, container,
    ["env", "GIT_LFS_SKIP_SMUDGE=1", "git", "clone", "--no-local", MIRROR_MOUNT, "/workspace"]);
}

// A reused workspace may still point at GitHub (or anywhere): re-aim origin.
export function pointOriginAtMirror(ctx: Context, container: string): Promise<ExecResult> {
  return execAsAgentArgv(ctx, container, ["git", "-C", "/workspace", "remote", "set-url", "origin", MIRROR_MOUNT]);
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
export async function ensureTeamMirror(ctx: Context, team: string): Promise<"created" | "kept"> {
  const mirror = teamMirrorPath(team);
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
