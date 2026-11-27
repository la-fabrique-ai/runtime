import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { installReferenceKit, KIT_MANIFEST, referenceDir, referenceKit } from "../cli/lib/reference-kit.ts";

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

const DEV = { name: "agent-x", reference: { skills: ["tdd", "diagnose"], agents: ["scout"], memory: true } };

const lines = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));
const removal = (l: string) => l.includes("--user 1001") && l.includes("rm -rf");

test("a container with a reference kit gets its skills and sub-agents, after the old ones are removed", async () => {
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

test("a container without a kit (the control) gets nothing", async () => {
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

test("the repository's kits: the control and the executor, every skill and sub-agent they name exists", () => {
  const roles = JSON.parse(readFileSync(join(referenceDir(), "roles.json"), "utf8")) as Record<string, { skills: string[]; agents: string[] }>;
  assert.deepEqual(Object.keys(roles).sort(), ["control", "executor"]);
  assert.deepEqual(referenceKit("control").skills, ["design", "split", "checkpoint", "review"]);
  assert.ok(readFileSync(join(referenceDir(), "skills", "review", "SKILL.md"), "utf8").startsWith("---\nname: review\n"));
  // Décision 35 : le doute d'un développeur va d'abord à ce sous-agent.
  assert.ok(referenceKit("executor").agents.includes("spec-reader"));
  // Partie 3 : l'exécuteur mène aussi la QA d'un ticket.
  assert.ok(referenceKit("executor").skills.includes("qa"));
  assert.ok(readFileSync(join(referenceDir(), "skills", "qa", "SKILL.md"), "utf8").startsWith("---\nname: qa\n"));
  assert.throws(() => referenceKit("pilot"), /no reference kit for role pilot/);
  for (const kit of Object.values(roles)) {
    for (const s of kit.skills) assert.ok(existsSync(join(referenceDir(), "skills", s, "SKILL.md")), s);
    for (const a of kit.agents) assert.ok(existsSync(join(referenceDir(), "agents", `${a}.md`)), a);
  }
  assert.throws(() => referenceKit("lead"), /no reference kit for role lead \(known: control, executor\)/);
});
