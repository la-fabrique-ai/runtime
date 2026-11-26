// Ce que partagent les suites du modèle à tickets (project.test.ts,
// orchestrator.test.ts) : un projet Incus jetable dont les containers portent
// les noms fixes du projet (agent-control, agent-executor-<n>), un hôte dont
// les dossiers et la config sont jetables, un miroir d'origine tiré d'un dépôt
// local (rien ne parle à GitHub), l'API servie dans le process de la suite.
// Rien ne tourne sans FORGE_INTEGRATION=1.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../cli/lib/api/journal.ts";
import { hostSocketPath, serveApi } from "../../cli/lib/api/server.ts";
import { parseConfig, type ForgeConfig } from "../../cli/lib/config.ts";
import { createContext } from "../../cli/lib/context.ts";
import { CONTROL, executorName } from "../../cli/lib/project.ts";
import { ORCH_HOME, ORCH_USER } from "../../cli/lib/project-provision.ts";
import { FORGE, SENTINEL, copyImage, incus, must, raw, run, teardownProject, type Run } from "./lib.ts";

export const REPO = "web";

const VARS = ["FORGE_INCUS_PROJECT", "FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_MIRRORS",
  "FORGE_WORKSPACES", "FORGE_API_RUNTIME", "FORGE_PROXY_SLOT", "INCUS_CONF", "FORGE_INVOKED_AS"] as const;

export const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// L'API tourne dans le process de la suite : un appel qui l'attend ne doit pas
// bloquer la boucle d'évènements (`run` de lib.ts est synchrone).
export function runAsync(cmd: string, args: string[], input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

export type ProjectHarness = ReturnType<typeof projectHarness>;

// Le même environnement pour le process de la suite (serveApi, et le `forge
// upload-pack` que lance un `done`) et pour le `forge` qu'il lance : un projet
// Incus, des dossiers et une config jetables. Le client incus garde sa
// configuration (INCUS_CONF), puisque XDG_CONFIG_HOME change. À appeler au
// chargement du module de la suite, seulement si ENABLED.
export function projectHarness(project: string, slot: string, executors: number) {
  assert.ok(project.startsWith("forge-selftest"), `refusing to use ${project}`);
  const root = mkdtempSync(join(tmpdir(), `${project}-`));
  const names = [CONTROL, ...Array.from({ length: executors }, (_, i) => executorName(i + 1))];
  const saved: Record<string, string | undefined> = {};
  for (const k of VARS) saved[k] = process.env[k];
  Object.assign(process.env, {
    FORGE_INCUS_PROJECT: project,
    FORGE_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    FORGE_MIRRORS: join(root, "mirrors"),
    FORGE_WORKSPACES: join(root, "workspaces"),
    FORGE_API_RUNTIME: join(root, "run"),
    FORGE_PROXY_SLOT: slot,
    INCUS_CONF: process.env.INCUS_CONF ?? join(homedir(), ".config", "incus"),
    // Le `forge upload-pack` que lance un `done` (forgeCommand) : celui de ce
    // checkout, comme le service lancé par le shim, jamais un forge installé.
    FORGE_INVOKED_AS: FORGE,
  });
  const stop = new AbortController();
  let served: Promise<void> | null = null;

  // `forge` en hôte. Un XDG_RUNTIME_DIR jetable : le `systemctl --user
  // try-restart forge-api` de converge n'atteint pas le service de l'utilisateur
  // (il avertit, et le service de la suite tourne dans son process).
  const forge = (args: string[]) => run(FORGE, args, {
    env: { FORGE_SIDE: "host", XDG_RUNTIME_DIR: join(root, "xdg-runtime") }, timeout: 1_800_000,
  });
  // `runuser` plutôt que `incus exec --user --group` : il garde les groupes
  // supplémentaires (forge-orch est du groupe 1001, qui lui ouvre la base des tickets).
  const execAs = (name: string, user: string, home: string, argv: string[], input = "") =>
    runAsync("incus", ["--project", project, "exec", name, "--env", `HOME=${home}`, "--", "runuser", "-u", user, "--", ...argv], input);
  const asAiuser = (name: string, argv: string[], input = "") => execAs(name, "aiuser", "/home/aiuser", argv, input);
  const asOrch = (argv: string[], input = "") => execAs(CONTROL, ORCH_USER, ORCH_HOME, argv, input);
  const inControl = (argv: string[]) => incus(project, ["exec", CONTROL, "--", ...argv]);

  // Dans ce projet Incus jetable, tout est à nous ; la garde est le nom du projet.
  const removeOurs = () => {
    for (const name of names) incus(project, ["delete", name, "--force"]);
  };

  return {
    root, names, forge, execAs, asAiuser, asOrch, inControl,
    origin: join(root, "mirrors", `repo-${REPO}.git`),
    teamMirror: join(root, "mirrors", `repo-${REPO}.agents.git`),
    ticketBase: join(root, "tickets"),

    // Avant la suite : les restes d'un passage précédent s'en vont.
    before() {
      must("no usable incus client", run("incus", ["--version"]));
      removeOurs();
      teardownProject(project);
    },

    // Après la suite, même en échec : le service, les containers, le projet, les dossiers, l'environnement.
    async after() {
      stop.abort();
      await served;
      removeOurs();
      teardownProject(project);
      rmSync(root, { recursive: true, force: true });
      for (const k of VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },

    // Le projet Incus : forge setup, puis une copie d'agent-base, dont on
    // reporte le commit. Rend faux (la suite saute) sans agent-base.
    prepareImage(): boolean {
      if (incus("agent-forge", ["image", "info", "agent-base"]).status !== 0) return false;
      must("forge setup", forge(["setup"]));
      must("copy agent-base", copyImage("agent-forge", project));
      const commit = incus("agent-forge", ["image", "get-property", "agent-base", "user.forge.commit"]).stdout.trim();
      if (commit) must("stamp the copy", incus(project, ["image", "set-property", "agent-base", "user.forge.commit", commit]));
      return true;
    },

    // La config (un projet d'un dépôt), un token jetable, et le miroir
    // d'origine tiré d'un dépôt local d'un commit sur `main`.
    seed(): ForgeConfig {
      const rawCfg = {
        project: {
          repositories: { [REPO]: { repo: SENTINEL } },
          executors: { count: executors },
          tickets: { base: join(root, "tickets") },
          gitIdentity: { name: "Selftest", email: "selftest@example.com" },
        },
      };
      mkdirSync(join(root, "config", "agent-forge"), { recursive: true });
      writeFileSync(join(root, "config", "agent-forge", "config.json"), JSON.stringify(rawCfg));
      mkdirSync(join(root, "home", ".config", "agent-forge"), { recursive: true });
      writeFileSync(join(root, "home", ".config", "agent-forge", "claude-token"), "throwaway-token\n", { mode: 0o600 });
      const seed = join(root, "seed");
      mkdirSync(seed);
      git(["init", "-q", "-b", "main", "."], seed);
      writeFileSync(join(seed, "README.md"), "seed\n");
      git(["add", "."], seed);
      git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"], seed);
      const origin = join(root, "mirrors", `repo-${REPO}.git`);
      mkdirSync(join(root, "mirrors"), { recursive: true });
      git(["clone", "-q", "--bare", seed, origin], root);
      git(["--git-dir", origin, "remote", "set-url", "origin", `git@github.com:${SENTINEL}.git`], root);
      return parseConfig("/c.json", rawCfg);
    },

    // Attend (10 s au plus) que le service de l'orchestrateur soit actif ; le
    // journal du service dans le message d'échec.
    async waitOrchestratorActive() {
      let state = "";
      for (let i = 0; i < 50 && state !== "active"; i++) {
        state = inControl(["systemctl", "is-active", "forge-orchestrator"]).stdout.trim();
        if (state !== "active") await pause(200);
      }
      assert.equal(state, "active", raw("the orchestrator's journal", inControl(["journalctl", "-u", "forge-orchestrator", "--no-pager", "-n", "30"])));
    },

    // Une session sans modèle : le forge-agent de l'exécuteur devient `script`.
    stubAgent(name: string, script: string) {
      must(`a stub forge-agent in ${name}`, incus(project, ["file", "push", "-", `${name}/usr/local/bin/forge-agent`, "--uid", "0", "--gid", "0", "--mode", "755"], script));
    },

    // L'API dans ce process, avec le même environnement que le service forge-api ;
    // rend la main quand la socket de chaque container existe.
    async serve(cfg: ForgeConfig) {
      served = serveApi({
        ctx: createContext(), cfg, journal: Journal.open(join(root, "data", "agent-forge", "api", "journal.jsonl")), secrets: [], now: () => new Date(),
      }, stop.signal);
      for (let i = 0; i < 100 && !names.every((n) => existsSync(hostSocketPath(n))); i++) await pause(50);
    },
  };
}
