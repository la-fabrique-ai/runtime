// Layer 2: real git. `done` copies the mission's branch from the executor's
// clone into the repository's agents' mirror (copyToTeamMirror): only that
// branch arrives, no hook of the mirror runs on the host, and a rewritten
// branch replaces the old one (forced update). No Incus: a stand-in for forge
// answers `upload-pack` with the "executor's clone".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import { copyToTeamMirror } from "../../cli/lib/api/missions.ts";
import { repoTeamMirror } from "../../cli/lib/project.ts";

let root: string;
const git = (args: string[], cwd: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8" }).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), "forge-agents-mirror-"));
  process.env.FORGE_MIRRORS = join(root, "mirrors");
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FORGE_MIRRORS;
  delete process.env.FORGE_INVOKED_AS;
});

test("only the mission's branch arrives, no hook of the mirror runs, a rewritten branch replaces the old one", async () => {
  // The executor's clone, with the mission's branch and another one.
  const clone = join(root, "clone");
  mkdirSync(clone);
  git(["init", "-q", "-b", "main", "."], clone);
  git(["commit", "-q", "--allow-empty", "-m", "base"], clone);
  for (const b of ["agent/T-1.1", "agent/T-9.9"]) {
    git(["checkout", "-q", "-b", b, "main"], clone);
    git(["commit", "-q", "--allow-empty", "-m", b], clone);
  }

  // Stand-in for forge: whatever it is asked, it serves the executor's clone.
  const stub = join(root, "forge");
  writeFileSync(stub, `#!/bin/sh\nexec git-upload-pack '${clone}'\n`);
  chmodSync(stub, 0o755);
  process.env.FORGE_INVOKED_AS = stub;

  // A mirror that already exists, with a planted hook and no hooksPath of its
  // own: only the fetch's own core.hooksPath keeps the hook from running.
  const mirror = repoTeamMirror("web");
  mkdirSync(mirror, { recursive: true });
  git(["init", "--bare", "-q", mirror], root);
  const marker = join(root, "hook-ran");
  mkdirSync(join(mirror, "hooks"), { recursive: true });
  const hook = join(mirror, "hooks", "reference-transaction");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);

  const ctx = createContext();
  await copyToTeamMirror(ctx, "agent-executor-1", "web", "agent/T-1.1");
  assert.deepEqual(git(["for-each-ref", "--format=%(refname)", "refs/heads"], mirror).split("\n"), ["refs/heads/agent/T-1.1"]);
  assert.equal(git(["rev-parse", "refs/heads/agent/T-1.1"], mirror), git(["rev-parse", "agent/T-1.1"], clone));
  assert.equal(existsSync(marker), false, "a hook of the mirror ran on the host");

  // The executor rewrites the branch: the mirror follows.
  git(["checkout", "-q", "agent/T-1.1"], clone);
  git(["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"], clone);
  await copyToTeamMirror(ctx, "agent-executor-1", "web", "agent/T-1.1");
  assert.equal(git(["rev-parse", "refs/heads/agent/T-1.1"], mirror), git(["rev-parse", "agent/T-1.1"], clone));
  assert.equal(existsSync(marker), false);
});
