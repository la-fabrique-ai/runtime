# Ticket-driven forge, part 1c: the host side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host serves the new model: a `project` in the config, a control container and generic execution containers with a clone of every repository, the branch records, and the mission verbs of the API (`assign`, `release`, `events`, `status` for the control container; `done`, `status` for an executor), with `forge fetch` and `forge ship` still working on the new branches.

**Architecture:** New modules beside the team model, which part 1d removes: `project-config.ts` (the `project` key), `project.ts` (names, mirrors per repository), `branch-records.ts`, `project-provision.ts`, `api/missions.ts` (parse and handle of the mission verbs). The API server picks the mission handler when the config has a `project`. Host git runs only in the mirrors; git in a clone runs inside the container as `aiuser`, as today.

**Tech Stack:** TypeScript run by Node 24, the fake `incus` (`tests/lib/fake-incus.ts`), `node:test`; integration tests on a real Incus with `FORGE_INTEGRATION=1`.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§6.1, §6.2, §6.4, §6.5, §6.6, §6.7, §9). Plan 1b's `cli/lib/orchestrator/host.ts` is the wire contract of the control container's verbs: implement it verbatim. A map of the current code is in `.superpowers/sdd/team-model-map.md` of the worktree (git-ignored); read the part you touch.

## Global Constraints

- Same branch (`agent/ticket-driven-part-1`); conventional commit messages in French; code comments in French.
- Boundary rule: `forge` never touches the host OS beyond its data folders; Ansible never configures the inside of Incus. Every Incus call goes through `incus()` (project `agent-forge`).
- Container names, verbatim: `agent-control`, `agent-executor-<n>` (n from 1).
- In an executor, the clone of repository `<name>` is `/workspace/<name>`; its origin mirror is mounted read-only at `/forge/origins/<name>.git` (device `origin-<name>`), the team mirror at `/forge/teams/<name>.git` (device `team-<name>`, read-only), remotes `origin` and `team` in the clone.
- Host mirrors, verbatim: origin `<mirrorsDir()>/repo-<name>.git`, team `<mirrorsDir()>/repo-<name>.agents.git` (same creation as `ensureMirror` / `ensureTeamMirror` today).
- The control container's API socket: the same in-container path as today (`/var/lib/forge/api.sock`) but owned by the orchestrator's user, uid **1002**, gid 1002, mode 0600. An executor's socket stays owned by `aiuser` (1001).
- The orchestrator's user in the container is `forge-orch`, uid/gid 1002, member of group 1001; it is created in the image by part 1d. Until then, provisioning only checks for it (`getent passwd forge-orch`) and refuses with a clear message.
- The ticket base: host folder `project.tickets.base` (default `~/.local/share/agent-forge/tickets`), mounted read-write in the control container at `/var/lib/forge-orch/tickets`, under `/var/lib/forge-orch` (owner `forge-orch`, mode 0700, so `aiuser` cannot reach it); the base folder itself gets group 1001, mode 2770, and a default ACL (`setfacl -R -m g:1001:rwX -m d:g:1001:rwX`, run as root inside the container at each converge), so files and folders created by either side — the human on the host (seen as 1001 inside), whatever their umask, or `forge-orch` — stay writable by the other. `setfacl` comes from the `acl` package, added to the image by 1d Task 1; until then the control provisioning refuses with the same message as for a missing `forge-orch`.
- A mission's branch is `agent/<sub-task id>`; its base is `origin/<branch>` or `agent/<sub-task id>` (1b). The API validates both with `validateGitRef` and the `agent/` part with `isSubtaskId`.
- The API's existing rules stay: caller identified by its socket, hand validation with an exact field set per verb, refusal of a text carrying a handed-out secret, journal of every call, instruction under 64 KiB.

## Review Focus

1. **An executor asking for the control container's verbs** (`assign`, `events`…) or the control container calling `done`: refused by the socket the request came from (Task 5).
2. **A branch that exists in the team mirror**: an assign takes it from there instead of creating it again, so a resumed sub-task keeps its work (Task 5, and integration Task 7).
3. **An executor that is not free**: `assign` refuses unless the mission is the same sub-task, which restarts its session (the orchestrator's recovery) (Task 5).
4. **`done` from an executor whose branch has no commit beyond its base**: refused, so an empty branch is never reported done (Task 5).
5. **A config holding both `project` and `teams`/`pilot`**: refused with one message (Task 1).

---

### Task 1: The `project` key

**Files:** Create `cli/lib/project-config.ts`; modify `cli/lib/config.ts` (add `project: ProjectConfig | null` to `ForgeConfig`, `DEFAULT_CONFIG.project = null`, the key in the allowed list); test `tests/project-config.test.ts`.

**Interfaces — Produces:** `type ProjectConfig = { repositories: Record<string, { repo: string; lfs: boolean }>; executors: { count: number; memory: string | null; cpu: number | null; strict: boolean; plugins: string[]; env: string | null }; tickets: { base: string; prefix: string }; gitIdentity: { name: string; email: string } | null }`; `parseProject(path: string, raw: unknown): ProjectConfig | null`, in the style of `parseTeams` (`configHelpers`, exact keys, first error throws `ForgeError`). Rules: repository names `/^[a-z][a-z0-9-]*$/`, `repo` through `validateRepo`, at least one repository; `count` 1 to 16; `memory` as `SIZE`; `tickets.base` absolute or `~/`, default above; `prefix` passing `isTicketId(prefix + "-1")`, default `T`. `parseConfig` refuses `project` together with `teams` (non-empty) or `pilot`: `"<path>: project replaces teams and pilot: keep only project"`.

- [ ] Write the failing tests (a full valid project round-trips; each rule refused naming the key; `project` with `teams` refused), run, implement, run `node --test tests/project-config.test.ts tests/config.test.ts` (PASS), commit `feat: la clé project de la configuration`.

### Task 2: Names and mirrors

**Files:** Create `cli/lib/project.ts`; test `tests/project.test.ts`.

**Interfaces — Produces:** `CONTROL = "agent-control"`; `executorName(n: number): string`; `type ProjectMember = { name: string; kind: "control" | "executor"; index: number | null }`; `projectMembers(p: ProjectConfig): ProjectMember[]` (control first, then executors 1..count); `repoOriginMirror(name: string): string`, `repoTeamMirror(name: string): string` (paths above); `ensureRepoMirrors(ctx: Context, p: ProjectConfig): Promise<void>` (for each repository: `ensureMirror` of the origin from GitHub through the forwarded agent, LFS when `lfs`, `ensureTeamMirror` equivalent for the team mirror path — reuse `mirror.ts` functions, extending them to take a path where they take a team).

- [ ] Write the failing tests (names; mirror paths; `ensureRepoMirrors` issues the `git clone --bare` once per repository and nothing when the mirror exists, with the fake context), run, implement, run, commit `feat: les noms et les miroirs d'un projet`.

### Task 3: The branch records

**Files:** Create `cli/lib/branch-records.ts`; test `tests/branch-records.test.ts`.

**Interfaces — Produces:** `type BranchRecord = { branch: string; repository: string; ticket: string; subtask: string; base: string; executor: string | null }`; `branchRecordsPath(): string` (`<apiDataDir()>/branches.json`); `readBranchRecords(path?): BranchRecord[]` (missing → `[]`; a bad file throws `ForgeError` naming it); `recordBranch(r: BranchRecord, path?): void` (one record per `repository` + `branch`, replaced; written through a temporary file and rename, mode 0600); `branchRecord(repository, branch, path?): BranchRecord | null`. They replace the `user.forge.base.<task>` keys for the project model (§6.7).

- [ ] Write the failing tests (record, replace, read back; two repositories keep separate records; a corrupt file throws naming the path), run, implement, run, commit `feat: les enregistrements de branches de l'hôte`.

### Task 4: Provisioning the control and the executors

**Files:** Create `cli/lib/project-provision.ts`; modify `cli/lib/hc-session.ts` (`startSession` takes an optional `cwd`, default `/workspace`, used for `hc run --cwd`), `cli/lib/api/access.ts` (`ensureApiAccess` takes the socket owner uid/gid, default 1001); test `tests/project-provision.test.ts`.

**Interfaces — Produces:** `provisionExecutor(ctx, cfg, m: ProjectMember): Promise<void>` and `provisionControl(ctx, cfg, m: ProjectMember): Promise<void>`, plus `convergeExecutor`/`convergeControl` for an existing container (files and devices only; the clones are made once). Follow `provisionMember`'s order and helpers (preconditions, `incus launch agent-base … -c user.forge.role=executor|control`, `waitReady`, token, onboarding, git identity with `commit.gpgsign=false`, settings, hooks, `forge-agent`, `forge-mode` = `supervised`, image commit stamp, provisioning markers). Executor specifics: per repository the `origin-<name>` and `team-<name>` devices and the clone `/workspace/<name>` (`git clone --no-local`, then remote `team`), the API access (uid 1001) with `forge-team`, the `dev` reference kit plus the `branch-reviewer` sub-agent, `limits.memory`/`limits.cpu` from `executors`. Control specifics: `getent passwd forge-orch` must succeed (else `ForgeError("the image has no forge-orch user: run forge image build")`), `/var/lib/forge-orch` (forge-orch, 0700), the ticket base device (host folder created mode 0770 if missing; inside, as root: `chgrp -R 1001`, `chmod 2770` on the base, the default ACL of Global Constraints; `which setfacl` and `getent passwd forge-orch` checked first), the API access with uid/gid 1002, no clone and no agent session in part 1.

- [ ] Write the failing tests with `FakeIncus.withRuntime()`: an executor of a two-repository project gets both device pairs, both clones (as uid 1001), the `team` remote, the kit with `branch-reviewer`, the socket proxy with `uid=1001`; the control container gets the base device at `/var/lib/forge-orch/tickets`, the `chmod 2770`, the socket proxy with `uid=1002 gid=1002 mode=0600`, no `/workspace` clone; a missing `forge-orch` refuses before `incus launch`; `startSession` with `cwd: "/workspace/web"` passes `--cwd /workspace/web`. Run, implement, run `npm run test:unit` (PASS), commit `feat: le conteneur de contrôle et les conteneurs d'exécution`.

### Task 5: The mission verbs

**Files:** Create `cli/lib/api/missions.ts`; modify `cli/lib/api/server.ts` (with `cfg.project`, one socket per project member, each connection handled by `handleMission(d, member, line)`; the team path unchanged otherwise), `container/forge-team` (subcommands `done` and `status` when the server answers with the mission shape; keep the old subcommands until 1d); test `tests/api-missions.test.ts`.

**Interfaces — Produces:** `parseMissionRequest(line: string, from: "control" | "executor", secrets: readonly string[]): MissionRequest` (exact field sets; control: `status`, `assign` with `to` an executor name and `mission` = `MissionSpec` of 1b, `release`, `events` with `after` a non-negative integer; executor: `done`, `status`; any other op refused `"<op> is not a verb of the <kind> container"`); `handleMission(d: ApiDeps, caller: ProjectMember, line: string): Promise<ApiReply>`, journaling every call as today, with `exclusive()` around `assign`, `release` and `done`. Behaviour:
- `assign`: executor free (`user.forge.mission` empty) or holding the same sub-task; repository declared; then inside the executor, in `/workspace/<repo>`, as aiuser: refuse a dirty clone; `git fetch team` then `git fetch origin`; branch in the team mirror → `git switch -C <branch> team/<branch>`; else base `origin/<b>` → `git switch -c <branch> origin/<b>`, base `agent/<x>` → `git switch -c <branch> team/agent/<x>` (missing → refused `"base <x> is not in the team mirror"`); `recordBranch` with the executor; `incus config set user.forge.mission=<JSON of HeldMission>`; `startSession(ctx, member, subtask, instruction, { cwd: /workspace/<repo> })`; on failure unset the key and rethrow.
- `release`: unset `user.forge.mission`, `stopSession` (warning on failure).
- `status` (control): `ExecutorStatus[]` for every executor (`mission` parsed from the key, `session` from `sessionState`); (executor): `{ ok: true, mission: HeldMission | null }`.
- `done` (executor): a mission is held; `git rev-list --count <base>..<branch>` in the clone > 0, else refused `"nothing committed on <branch> beyond <base>"`; fetch `+refs/heads/<branch>:refs/heads/<branch>` from the container into the repository's team mirror (the upload-pack path of `refreshTeamMirror`); journal an entry with op `done`; reply `{ ok: true, id }`.
- `events`: journal entries with op `done`, accepted, id > `after`, as `HostEvent` (executor, ticket, subtask, branch from the entry's recorded mission), **in increasing id order**, and the reply carries `last`, the highest journal id (`{ ok: true, events, last }`), so the orchestrator detects a journal that restarted from 1. A `done` entry's id is taken **at append time, inside `exclusive()`** (never reserved earlier, unlike today's `message`), so an event with a lower id never appears after a higher one was served.
- `assign` also refuses a sub-task that **another** executor holds: `"<sub-task> is held by <executor>"`.
- `status` session values: `none` only when the container runs, `hc` answers and there is no terminal; a stopped container or a failed `incus exec`/`hc get` is reported `unknown` (today's `sessionState` returns `none` for a failed `hc get`: map it here, do not change its other callers). An executor that **holds a mission** but has no terminal is reported `lost` (never `none`), so the orchestrator re-issues it; `none` is only for an executor without a mission.
Extend `Entry`/`JournalOp` with `"done"` and the mission fields the event needs (a `mission` JSON field on the entry).

- [ ] Write the failing tests (fake incus, a temporary journal and records file): the review focus cases 1, 3, 4; an assign of a new first sub-task runs `git switch -c agent/T-1.1 origin/main` in `/workspace/web` as uid 1001 and records the branch; an assign whose branch exists in the team mirror runs `git switch -C agent/T-1.1 team/agent/T-1.1`; a second sub-task's assign uses `team/agent/T-1.1` as base; `done` fetches into `repo-web.agents.git` and `events(0)` returns it with `last`; two `done` calls racing produce events whose ids follow their append order; an assign of a sub-task held by another executor is refused; a stopped executor reports session `unknown`; `release` unsets the key; an instruction of 70 000 bytes refused. Run, implement, run `npm run test:unit`, commit `feat: les verbes de mission de l'API`.

### Task 6: Converge, status, fetch and ship

**Files:** Modify `cli/lib/commands/team.ts` (with `cfg.project`: `converge` provisions or converges `projectMembers` after `ensureRepoMirrors`, restarts the API service, prints NAME KIND STATUS MISSION; `status --json` returns `{ members: [{ name, kind, present, mission, session }] }`; `for-repo <owner/repo>` prints the repository name; `upload-pack <name>` serves `repoTeamMirror(name)`; `task-base <name>` prints `<sub-task>\t<base>` from the branch records, with bases `origin/<b>` and `agent/<x>` as today); `cli/lib/commands/team-laptop.ts` and `cli/lib/laptop/machines.ts` only if `up` needs the new status rows (machines for every member); tests in `tests/team-command.test.ts`, `tests/fetch.test.ts`.

- [ ] Write the failing tests (converge of a fresh project creates three containers and both mirrors; `for-repo` and `task-base` outputs; `forge fetch` against a project lists `agent/T-1.1` with its base), run, implement, run `npm run test:unit && npm run test:contract && npm run check`, commit `feat: converge, statut, fetch et ship pour un projet`.

### Task 7: Integration

**Files:** Create `tests/integration/project.test.ts` (style of `tests/integration/team.test.ts`, `PREFIX` names, teardown).

- [ ] Write it: on a real Incus with the image of part 1d's Task 1 built (skip with a clear message if `forge-orch` is absent from the image), a project of one local repository (bare repository on the host as GitHub stand-in, as `team.test.ts` does) and one executor: `aiuser` in the control container cannot connect to `/var/lib/forge/api.sock` nor list `/var/lib/forge-orch`; `forge-orch` can; an `assign` of sub-task 1 then a commit then `done`, then an `assign` of sub-task 2 creates its branch from sub-task 1's commit; a re-assign of sub-task 1 on another executor takes the branch from the team mirror with its commit.
- [ ] Run `FORGE_INTEGRATION=1 node --test --test-concurrency=1 tests/integration/project.test.ts` on the VM (after `forge setup` and `forge image build`). Expected: PASS. Commit `test: intégration du modèle de projet`.

## Calls made while writing (to check)

- The orchestrator's uid is fixed at 1002 in the image, like `aiuser`'s 1001: an image constant, not a personal value.
- The human writes the ticket base on the host directly in part 1 (Markdown files); the setgid group 1001 is what lets both sides write it.
- No Pilot session and no clone in the control container in part 1: they come with part 2.
