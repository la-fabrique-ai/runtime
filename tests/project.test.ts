import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { validateContainerName } from "../cli/lib/validate.ts";
import {
  CONTROL, ensureRepoMirrors, executorName, projectMembers, repoOriginMirror, repoTeamMirror,
} from "../cli/lib/project.ts";
import type { ProjectConfig } from "../cli/lib/project-config.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-project-"));
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_MIRRORS;
});

const project = (lfs = false): ProjectConfig => ({
  repositories: { web: { repo: "o/web", lfs, specDir: null } },
  executors: { count: 2, memory: null, cpu: null, strict: false, plugins: [], env: null },
  tickets: { base: "/t", prefix: "T" },
  gitIdentity: null,
});

test("names: control first, then executors, all valid container names", () => {
  assert.equal(CONTROL, "agent-control");
  assert.equal(executorName(3), "agent-executor-3");
  const members = projectMembers(project());
  assert.deepEqual(members, [
    { name: "agent-control", kind: "control", index: null },
    { name: "agent-executor-1", kind: "executor", index: 1 },
    { name: "agent-executor-2", kind: "executor", index: 2 },
  ]);
  for (const m of members) validateContainerName(m.name);
});

test("mirror paths", () => {
  assert.equal(repoOriginMirror("web"), join(home, "mirrors", "repo-web.git"));
  assert.equal(repoTeamMirror("web"), join(home, "mirrors", "repo-web.agents.git"));
});

test("ensureRepoMirrors clones once and initialises the team mirror", async () => {
  const ctx = fakeContext();
  await ensureRepoMirrors(ctx, project());
  const clones = ctx.calls.filter((c) => c.includes("clone"));
  assert.equal(clones.length, 1);
  assert.equal(clones[0].at(-1), repoOriginMirror("web"));
  assert.ok(ctx.calls.some((c) => c.includes("init") && c.at(-1) === repoTeamMirror("web")));
  assert.ok(!ctx.calls.some((c) => c.includes("lfs")));
});

test("ensureRepoMirrors fetches LFS only when asked, and never clones an existing mirror", async () => {
  mkdirSync(repoOriginMirror("web"), { recursive: true });
  mkdirSync(repoTeamMirror("web"), { recursive: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", stdout: "git@github.com:o/web.git\n" }] });
  await ensureRepoMirrors(ctx, project(true));
  assert.ok(!ctx.calls.some((c) => c.includes("clone") || c.includes("init")));
  assert.ok(ctx.calls.some((c) => c.includes("lfs")));
});

test("a failed LFS fetch is fatal", async () => {
  const ctx = fakeContext({ rules: [{ match: "lfs fetch", code: 1, stderr: "boom" }] });
  await assert.rejects(ensureRepoMirrors(ctx, project(true)), /LFS.*boom/);
});
