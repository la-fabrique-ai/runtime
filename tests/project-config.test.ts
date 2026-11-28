import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../cli/lib/config.ts";

const PATH = "/home/u/.config/agent-forge/config.json";
const parse = (raw: unknown) => parseConfig(PATH, raw);

function rejects(raw: unknown, pattern: RegExp) {
  assert.throws(() => parse(raw), (e: Error) => {
    assert.ok(e.message.startsWith(`${PATH}: `), e.message);
    assert.match(e.message, pattern);
    return true;
  });
}

const proj = (over: Record<string, unknown> = {}) => ({
  project: { repositories: { web: { repo: "o/web" } }, executors: { count: 2 }, ...over },
});

test("no project by default", () => {
  assert.equal(DEFAULT_CONFIG.project, null);
  assert.equal(parse({}).project, null);
});

test("a minimal project gets its defaults", () => {
  assert.deepEqual(parse(proj()).project, {
    repositories: { web: { repo: "o/web", lfs: false, specDir: null } },
    executors: { count: 2, memory: null, cpu: null, strict: false, plugins: [], env: null },
    tickets: { base: "~/.local/share/agent-forge/tickets", prefix: "T" },
    gitIdentity: null,
  });
});

test("a full project round-trips", () => {
  const project = {
    repositories: { web: { repo: "o/web", lfs: true, specDir: "docs/specs" }, "api-2": { repo: "o/api", lfs: false, specDir: null } },
    executors: { count: 16, memory: "8GiB", cpu: 4, strict: true, plugins: ["p@m"], env: "~/x.env" },
    tickets: { base: "/srv/tickets", prefix: "FG" },
    gitIdentity: { name: "N", email: "n@example.com" },
  };
  assert.deepEqual(parse({ project }).project, project);
});

test("each rule is refused naming its key", () => {
  rejects({ project: { executors: { count: 1 } } }, /project\.repositories/);
  rejects(proj({ repositories: {} }), /project\.repositories/);
  rejects(proj({ repositories: { Web: { repo: "o/web" } } }), /project\.repositories\.Web/);
  // Ni tiret final ni double tiret : un seul motif de nom pour la config, l'API et upload-pack.
  rejects(proj({ repositories: { "web-": { repo: "o/web" } } }), /project\.repositories\.web-/);
  rejects(proj({ repositories: { "a--b": { repo: "o/web" } } }), /project\.repositories\.a--b/);
  rejects(proj({ repositories: { web: { repo: "nope" } } }), /project\.repositories\.web\.repo/);
  rejects(proj({ repositories: { web: { repo: "o/w", lfs: 1 } } }), /project\.repositories\.web\.lfs/);
  // Le dossier où le ship copie la spec : relatif, sans « .. » ni segment vide.
  for (const specDir of ["../x", "/abs", "a//b", "a/../b", "", "a/", "a b", "x".repeat(201)]) {
    rejects(proj({ repositories: { web: { repo: "o/w", specDir } } }), /project\.repositories\.web\.specDir/);
  }
  rejects(proj({ executors: {} }), /project\.executors\.count/);
  rejects(proj({ executors: { count: 0 } }), /project\.executors\.count/);
  rejects(proj({ executors: { count: 17 } }), /project\.executors\.count/);
  rejects(proj({ executors: { count: 1, memory: "lots" } }), /project\.executors\.memory/);
  rejects(proj({ executors: { count: 1, cpu: 0 } }), /project\.executors\.cpu/);
  rejects(proj({ executors: { count: 1, strict: "y" } }), /project\.executors\.strict/);
  rejects(proj({ executors: { count: 1, plugins: ["a b"] } }), /project\.executors\.plugins/);
  rejects(proj({ executors: { count: 1, env: "rel.env" } }), /project\.executors\.env/);
  rejects(proj({ tickets: { base: "rel" } }), /project\.tickets\.base/);
  rejects(proj({ tickets: { prefix: "bad prefix" } }), /project\.tickets\.prefix/);
  rejects(proj({ gitIdentity: { name: "N" } }), /project\.gitIdentity\.email/);
  rejects(proj({ extra: 1 }), /unknown key project\.extra/);
});

test("a config that still holds teams or pilot is refused, with or without a project", () => {
  const msg = `${PATH}: teams and pilot are gone (the ticket-driven model): declare a project, see the release notes`;
  assert.throws(() => parse({ ...proj(), teams: { web: { repo: "o/web" } } }), { message: msg });
  assert.throws(() => parse({ pilot: {} }), { message: msg });
  assert.throws(() => parse({ teams: {} }), { message: msg });
});
