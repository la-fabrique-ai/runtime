import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { installReferenceKit, KIT_MANIFEST } from "../cli/lib/reference-kit.ts";
import type { Member } from "../cli/lib/team.ts";

const realRoot = process.env.FORGE_REPO_DIR;
afterEach(() => {
  if (realRoot === undefined) delete process.env.FORGE_REPO_DIR;
  else process.env.FORGE_REPO_DIR = realRoot;
});

const FILES: Record<string, string> = {
  "skills/tdd/SKILL.md": "tdd text",
  "skills/diagnose/SKILL.md": "diagnose text",
  "agents/scout.md": "scout text",
};

function kitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-kit-"));
  const dir = join(root, "teams", "reference");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roles.json"),
    JSON.stringify({ dev: { skills: ["tdd", "diagnose"], agents: ["scout"], memory: true } }));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  process.env.FORGE_REPO_DIR = root;
  return root;
}

const DEV: Member = {
  name: "agent-x", team: "t", role: "dev", index: null, repo: "o/x", capabilities: ["repo"], talkTo: [],
  strict: false, memory: null, cpu: null, plugins: [], prompt: null, env: null, lfs: false,
  reference: { skills: ["tdd", "diagnose"], agents: ["scout"], memory: true },
};

const lines = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));
const removal = (l: string) => l.includes("--user 1001") && l.includes("rm -rf");

test("a reference developer gets its skills and sub-agents, after the old ones are removed", async () => {
  const root = kitRoot();
  try {
    const c = fakeContext();
    assert.equal(await installReferenceKit(c, DEV), true);
    const l = lines(c);
    const rm = l.findIndex((x) => removal(x) && x.endsWith("rm -rf /home/aiuser/.claude/skills /home/aiuser/.claude/agents"));
    assert.ok(rm >= 0, l.join("\n"));
    // Les dossiers sont créés en aiuser, après le retrait et avant le premier push.
    const mk = l.findIndex((x) => x.includes("--user 1001") && x.includes("mkdir -p /home/aiuser/.claude/skills ") &&
      x.includes("/home/aiuser/.claude/skills/tdd") && x.includes("/home/aiuser/.claude/agents"));
    assert.ok(mk > rm && mk < l.findIndex((x) => x.includes("file push")), l.join("\n"));
    const dests = ["/home/aiuser/.claude/skills/tdd/SKILL.md", "/home/aiuser/.claude/skills/diagnose/SKILL.md",
      "/home/aiuser/.claude/agents/scout.md", KIT_MANIFEST];
    let last = rm;
    for (const d of dests) {
      const i = l.findIndex((x) => x.includes("file push") && x.includes(`agent-x${d}`));
      assert.ok(i > last, `${d}\n${l.join("\n")}`);
      assert.ok(l[i]!.includes("--uid 1001 --gid 1001 --mode 644"), l[i]);
      last = i;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged kit is left alone", async () => {
  const root = kitRoot();
  try {
    const hash = createHash("sha256");
    for (const rel of Object.keys(FILES).sort()) hash.update(`${rel}\0${FILES[rel]}\0`);
    const rules: ExecRule[] = [{ match: `file pull agent-x${KIT_MANIFEST}`, stdout: `${hash.digest("hex")}\n` }];
    const c = fakeContext({ rules });
    assert.equal(await installReferenceKit(c, DEV), false);
    assert.ok(!lines(c).some((x) => removal(x) || x.includes("file push")), lines(c).join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a custom team's member gets nothing", async () => {
  const c = fakeContext();
  assert.equal(await installReferenceKit(c, { ...DEV, reference: null }), false);
  assert.equal(c.calls.length, 0);
});

test("a kit file missing from the repository stops before any push", async () => {
  const root = kitRoot();
  try {
    rmSync(join(root, "teams", "reference", "skills", "diagnose", "SKILL.md"));
    const c = fakeContext();
    await assert.rejects(() => installReferenceKit(c, DEV),
      (e: unknown) => e instanceof ForgeError && e.message.includes("teams/reference/skills/diagnose/SKILL.md"));
    assert.ok(!lines(c).some(removal), lines(c).join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
