// Layer 2: real git and git-lfs, in a temporary HOME. The container's
// workspace is cloned from a mirror that holds no LFS object; the two
// `git lfs install` commands forge runs must leave LFS files as pointers, so
// that `git worktree add` (what a task's worktree needs) succeeds.
// Skipped when git-lfs is absent, except under CI where it fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LFS_FILTERS_INSTALL, LFS_FILTERS_READ, LFS_HOOKS_INSTALL, LFS_HOOKS_READ } from "../../cli/lib/commands/provision.ts";
import { lfsMirrorConfig } from "../../cli/lib/mirror.ts";

const present = spawnSync("git", ["lfs", "version"], { stdio: "ignore" }).status === 0;
const skip = !present && process.env.CI !== "true";

let root = "";
let mirror = "";
// A mirror that holds the LFS object and a branch whose .lfsconfig names another endpoint.
let lfsMirror = "";

// Every call runs with the temporary HOME and global config: `git lfs install`
// writes there, never in the developer's own config. No inherited GIT_*
// variable survives (GIT_CONFIG_GLOBAL, GIT_LFS_SKIP_SMUDGE...), the identity
// is a dummy one and the locale is fixed for the expected error message.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
  const home = join(root, "home");
  return execFileSync(cmd, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), LC_ALL: "C",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "forge test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "forge test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
  });
};
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  run("git", ["-c", "commit.gpgsign=false", ...args], cwd, env);
const sh = (command: string, cwd: string) => run("sh", ["-c", command], cwd);

// A workspace provisioned in forge's order (provision.ts): clone with the
// smudge skipped (mirror.ts), then the global filters, then the repository's
// hooks.
function workspace(name: string, filters: string, hooks: string): string {
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(join(root, "home"));
  const ws = join(root, name);
  git(["clone", "-q", "--no-local", mirror, ws], root, { GIT_LFS_SKIP_SMUDGE: "1" });
  sh(filters, root);
  sh(hooks, ws);
  return ws;
}

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "forge-lfs-"));
  mkdirSync(join(root, "home"));
  run("git", ["lfs", "install", "--skip-repo"], root);

  // A source repository with one LFS file, then a bare mirror of it: the
  // mirror gets the pointer, never the LFS object, as on the forge host.
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main", "."], source);
  git(["lfs", "track", "*.bin"], source);
  writeFileSync(join(source, "seed.bin"), "binary content\n");
  git(["add", ".gitattributes", "seed.bin"], source);
  git(["commit", "-q", "-m", "seed"], source);
  mirror = join(root, "mirror.git");
  git(["clone", "-q", "--bare", "--no-local", source, mirror], root, { GIT_LFS_SKIP_SMUDGE: "1" });
  // The same repository as the forge host mirrors it with `lfs: true`: the LFS
  // objects sit in the mirror's lfs/objects (what fetchMirrorLfs puts there),
  // and a second branch carries a .lfsconfig that names another endpoint.
  git(["checkout", "-q", "-b", "hostile"], source);
  writeFileSync(join(source, ".lfsconfig"), "[lfs]\n\turl = https://evil.invalid/x\n");
  git(["add", ".lfsconfig"], source);
  git(["commit", "-q", "-m", "hostile lfsconfig"], source);
  lfsMirror = join(root, "lfs-mirror.git");
  git(["clone", "-q", "--bare", "--no-local", source, lfsMirror], root, { GIT_LFS_SKIP_SMUDGE: "1" });
  cpSync(join(source, ".git", "lfs", "objects"), join(lfsMirror, "lfs", "objects"), { recursive: true });
  rmSync(source, { recursive: true, force: true });
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1/;
const addTask = (ws: string) => git(["worktree", "add", "-q", ".trees/t", "-b", "agent/t", "origin/main"], ws);

test("git worktree add succeeds on an LFS repository, the file stays a pointer", { skip }, () => {
  const ws = workspace("ws", LFS_FILTERS_INSTALL, LFS_HOOKS_INSTALL);
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

// Each command alone keeps the pointers: the second rewrites the global
// filters, so testing them only together would hide a first one without
// --skip-smudge.
test("the filters install alone keeps LFS files as pointers", { skip }, () => {
  const ws = workspace("ws-filters", LFS_FILTERS_INSTALL, "true");
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

test("the hooks install alone, after plain filters, keeps LFS files as pointers", { skip }, () => {
  const ws = workspace("ws-hooks", "git lfs install --skip-repo", LFS_HOOKS_INSTALL);
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

test("without --skip-smudge, the same worktree add fails (control)", { skip }, () => {
  const ws = workspace("ws-control", "git lfs install --skip-repo", "git lfs install");
  assert.throws(() => addTask(ws), /smudge filter lfs failed/);
});

// The read mode, in forge's order for `lfs: true` (team-provision.ts): the
// filters without the skip, the clone with the mirror's LFS settings, the same
// settings pinned in the workspace, then the hooks. The mirror's path stands in
// for /forge/origin.git.
function readWorkspace(name: string, filters: string): string {
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(join(root, "home"));
  sh(filters, root);
  const config = lfsMirrorConfig(lfsMirror);
  const ws = join(root, name);
  git([...config.flatMap(([k, v]) => ["-c", `${k}=${v}`]), "clone", "-q", "--no-local", lfsMirror, ws], root);
  for (const [k, v] of config) git(["config", k, v], ws);
  sh(LFS_HOOKS_READ, ws);
  return ws;
}

test("read mode: the clone holds the LFS content, read from the mirror", { skip }, () => {
  const ws = readWorkspace("ws-read", LFS_FILTERS_READ);
  assert.equal(readFileSync(join(ws, "seed.bin"), "utf8"), "binary content\n");
});

test("read mode: a later checkout of a branch whose .lfsconfig names another endpoint still reads the mirror", { skip }, () => {
  const ws = readWorkspace("ws-read-hostile", LFS_FILTERS_READ);
  git(["checkout", "-q", "hostile"], ws);
  assert.equal(readFileSync(join(ws, "seed.bin"), "utf8"), "binary content\n");
});

// Why the read mode has its own install: the skip-smudge one writes `smudge
// --skip` in the global config, and the clone then leaves pointers.
test("with the skip-smudge filters, even the mirror's settings leave a pointer (control)", { skip }, () => {
  const ws = readWorkspace("ws-read-skip", LFS_FILTERS_INSTALL);
  assert.match(readFileSync(join(ws, "seed.bin"), "utf8"), POINTER);
});
