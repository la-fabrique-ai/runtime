import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { memberNamed } from "../cli/lib/team.ts";
import { originMirrorPath, provisionMember } from "../cli/lib/team-provision.ts";
import { ensurePilotRepos } from "../cli/lib/pilot-repos.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-pilot-repos-"));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
});

const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
];
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" }];

const config = (caps: string[]) => parseConfig("/c.json", {
  pilot: { capabilities: caps, talkTo: ["web", "data"] },
  teams: {
    web: { repo: "o/web", roles: { lead: { capabilities: ["repo", "assign"] } } },
    data: { repo: "o/data", roles: { lead: { capabilities: ["repo", "assign"] } } },
  },
});

const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));

test("a Pilot with read-repos gets each team's mirror read-only and a clone of it, the mirror fetched first", async () => {
  const cfg = config(["assign", "read-repos"]);
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  // A fresh Pilot has no clone yet: the probe fails (the default answer, 0, means "present").
  const ctx = fakeContext({ incus: fake, rules: [{ match: "test -d /workspace/depots/", code: 1 }, ...IDENTITY, ...HOOK_BLOCKS] });
  await provisionMember(ctx, cfg, memberNamed(cfg, "agent-pilot"));
  const devices = fake.expandedDevices("agent-forge", "agent-pilot");
  for (const team of ["web", "data"]) {
    assert.deepEqual(devices[`origin-${team}`],
      { type: "disk", source: originMirrorPath(team), path: `/forge/origins/${team}.git`, readonly: "true" });
  }
  const calls = flat(ctx);
  const workspace = calls.findIndex((c) => c.includes("config device add") && c.includes(" workspace "));
  for (const team of ["web", "data"]) {
    const bare = calls.findIndex((c) => c.includes("clone --bare") && c.includes(`o/${team}`));
    const device = calls.findIndex((c) => c.includes("config device add") && c.includes(`origin-${team}`));
    const clone = calls.findIndex((c) => c.includes("GIT_LFS_SKIP_SMUDGE=1 git clone --no-local " +
      `/forge/origins/${team}.git /workspace/depots/${team}`));
    assert.ok(bare >= 0 && bare < device, calls.join("\n"));
    assert.ok(workspace >= 0 && device > workspace, calls.join("\n"));
    assert.ok(clone > device, calls.join("\n"));
  }
});

test("on a Pilot that already reads web, ensurePilotRepos adds only data", async () => {
  const cfg = config(["assign", "read-repos"]);
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-pilot", {
    devices: { "origin-web": { type: "disk", source: originMirrorPath("web"), path: "/forge/origins/web.git", readonly: "true" } },
  });
  mkdirSync(originMirrorPath("web"), { recursive: true });
  const ctx = fakeContext({
    incus: fake,
    // The data clone is absent; web's is present (the default answer is 0).
    rules: [{ match: "test -d /workspace/depots/data/.git", code: 1 },
      { match: "remote.origin.url", stdout: "git@github.com:o/web.git\n" }],
  });
  await ensurePilotRepos(ctx, cfg, memberNamed(cfg, "agent-pilot"));
  const calls = flat(ctx);
  assert.equal(calls.filter((c) => c.includes("config device add")).length, 1, calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("config device add") && c.includes("origin-data")));
  assert.equal(calls.filter((c) => c.includes("git clone --no-local")).length, 1, calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("git clone --no-local /forge/origins/data.git /workspace/depots/data")));
});

test("a Pilot without read-repos gets no mirror", async () => {
  const cfg = config(["assign"]);
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...IDENTITY, ...HOOK_BLOCKS] });
  await provisionMember(ctx, cfg, memberNamed(cfg, "agent-pilot"));
  const devices = fake.expandedDevices("agent-forge", "agent-pilot");
  assert.deepEqual(Object.keys(devices).filter((d) => d.startsWith("origin-")), []);
});
