# Ticket-driven forge, part 1d: the orchestrator in place, and the old team model gone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close part 1: the image has the orchestrator's user, the control container runs the orchestrator as a service, the executors have their mission prompt, and the team model (teams, Pilot container, Lead, Reviewer, `message`, `ask-human`, Inbox, `forge team watch`, `forge answer`) is removed. End state (§8, part 1): tickets written as Markdown files are implemented sub-task after sub-task by several containers in parallel.

**Architecture:** Ansible's image role adds `forge-orch`; `project-provision.ts` copies the self-contained orchestrator (`cli/orchestrator.ts`, `cli/lib/orchestrator/`, `cli/lib/tickets/`) into `/opt/forge` of the control container and runs it as a systemd unit; then the old modules, verbs, commands, mod parts and docs go.

**Tech Stack:** TypeScript/Node 24, Ansible (`ansible/roles/forge_image`), systemd in the container, `node:test`, the VM's real Incus.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§6.2, §6.4, §6.6, §6.9, §6.10, §7, §8 part 1, decision 30: a clean break). Plans 1a–1c are done on this branch. The map of the old code is `.superpowers/sdd/team-model-map.md` in the worktree; its §8 lists every file to scope the removal.

## Global Constraints

- Same branch (`agent/ticket-driven-part-1`); conventional commits in French; code comments in French; role prompts and `container/CLAUDE.md` in French; skills and sub-agents in English.
- Boundary: Ansible configures the image (and the host), never a running container; `forge` configures containers, never the host OS.
- `forge-orch`: uid/gid **1002**, member of group 1001, no login shell, home `/var/lib/forge-orch`.
- Orchestrator files in the container: `/opt/forge/orchestrator.ts`, `/opt/forge/lib/orchestrator/*.ts`, `/opt/forge/lib/tickets/*.ts` (root, 0644; dirs 0755); unit `/etc/systemd/system/forge-orchestrator.service` (`User=forge-orch`, `ExecStart=/usr/bin/node /opt/forge/orchestrator.ts --base /var/lib/forge-orch/tickets --socket /var/lib/forge/api.sock --state /var/lib/forge-orch/state --prefix <prefix>`, `Restart=always`, `RestartSec=5`, `UMask=0007`).
- Lean tests: no test on prompts, `CLAUDE.md`, `README.md` or skills.
- Kept for part 2, untouched: the Pilot's prompt and skills files (`teams/reference/prompts/pilot.md`, `skills/design`, `skills/checkpoint`), `container/forge-mode` handling and the autonomous rules of `container/pre-bash.sh` (decision 33).
- Tests to run, on this VM: `npm test`, `FORGE_INTEGRATION=1 npm run test:integration`, `ansible/tests/vm-test.sh --lima` (repository `CLAUDE.md`, contributor model).

## Review Focus

1. **A converge after an orchestrator code change**: the files are re-pushed and the service restarted; an unchanged converge restarts nothing (Task 2).
2. **A stale `teams`/`pilot` config after the upgrade**: refused with a message that says what to write instead, not a crash (Task 4).
3. **`forge fetch`/`forge ship` after the removal**: still work on a project (Task 4 keeps their tests green).
4. **The orchestrator crashing in a loop** (bad base folder): systemd restarts it every 5 s; `forge team status` shows the service state (Task 2).
5. **An executor's agent calling a removed verb** (`forge-team message`): a clear usage error, exit 64 (Task 3).

---

### Task 1: The orchestrator's user in the image

**Files:** Modify `ansible/roles/forge_image/tasks/` (a new `orchestrator.yml` included after `aiuser.yml`, vars `forge_image_orch_user: forge-orch`, `forge_image_orch_uid: 1002`), `ansible/roles/forge_image/defaults/main.yml`, the role's verify test if one checks users (see `ansible/tests/`).

- [ ] Add the `acl` package (for `setfacl` on the ticket base, plan 1c Global Constraints) to the image's package list, with a comment.
- [ ] Add the group and the user (`group` and `user` modules: uid/gid 1002, groups `aiuser`'s group, shell `/usr/sbin/nologin`, home `/var/lib/forge-orch`, mode 0700), with a comment saying why (§6.2: the orchestrator's own user).
- [ ] Run `npm run test:ansible` and `ansible-lint` on the role, then `forge image build` on the VM; check `incus exec <build> -- getent passwd forge-orch` in the built image. Expected: the user exists with uid 1002.
- [ ] Commit `feat: l'utilisateur de l'orchestrateur dans l'image`.

### Task 2: The orchestrator as a service in the control container

**Files:** Modify `cli/lib/project-provision.ts` (`installOrchestrator(ctx, cfg, m): Promise<boolean>` called by `provisionControl` and `convergeControl`), `cli/lib/commands/team.ts` (status row of the control container gains `orchestrator: "active" | "failed" | "inactive" | "unknown"` from `systemctl is-active forge-orchestrator`); test `tests/project-provision.test.ts`.

**Interfaces — Produces:** `installOrchestrator` pushes the files listed in Global Constraints and the unit, with a sha256 manifest `/opt/forge/.manifest` like `installReferenceKit`; when the manifest differs: push, `systemctl daemon-reload`, `systemctl enable forge-orchestrator`, `systemctl restart forge-orchestrator`, return true; else return false and only `systemctl start` if inactive. `/var/lib/forge-orch/state` is created (forge-orch, 0700).

- [ ] Write the failing tests (fake incus): a first converge pushes every file and restarts; a second unchanged one restarts nothing; a changed `cli/lib/orchestrator/tick.ts` (point `FORGE_REPO_DIR` at a temp copy) restarts; the unit holds `User=forge-orch` and the project's prefix. Run, implement, run `npm run test:unit`, commit `feat: l'orchestrateur tourne en service dans le conteneur de contrôle`.

### Task 3: What the executors get

**Files:** Modify `container/CLAUDE.md` (rewritten for missions: one container among several, the clones under `/workspace/<repository>`, one mission at a time, the branch is the ticket's, `forge-team done` after committing, `branch-reviewer` before `done`, the tests run by the reviewer itself, no question channel yet), `teams/reference/prompts/dev.md` → `teams/reference/prompts/executor.md` (the dev mission: read the instruction, work in the named clone, commit, publish with `forge-team done`), `teams/reference/roles.json` (roles `pilot` and `executor`; `executor`: skills `tdd`, `diagnose`, `verify-before-report`, agents `scout`, `branch-reviewer`, memory false), `container/forge-team` (only `done` and `status`; anything else prints the usage and exits 64), `cli/lib/project-provision.ts` (the executor's prompt and kit come from the `executor` role), tests `tests/forge-team.test.ts`.

- [ ] Update `tests/forge-team.test.ts` first (`done` sends `{"op":"done"}` and prints `ok <id>`; `status` prints the mission; `message` exits 64), run it (FAIL), change `forge-team`, run (PASS); then the texts. Run `npm run test:unit`. Commit `feat: le prompt et les outils d'une mission dans un conteneur d'exécution`.

### Task 4: The clean break

**Files (from the map's §8):** delete `cli/lib/team.ts`, `cli/lib/team-config.ts`, `cli/lib/team-provision.ts`, `cli/lib/team-mirror.ts`, `cli/lib/pilot-repos.ts`, `cli/lib/tasks.ts`, `cli/lib/api/handle.ts`, `cli/lib/laptop/watch.ts`, `cli/lib/commands/task-base.ts` (its `team task-base` replacement lives in 1c), the Lead and Reviewer prompts and the `split-request` and `review-branch` skills, the Inbox parts of `herdr/mods/forge/` (`inbox.js`, notifications, `forge team inbox --json`, `forge answer --json` calls; keep the status bar), and their tests; modify `cli/lib/config.ts` (no `teams`/`pilot`: a config holding them is refused with `"<path>: teams and pilot are gone (the ticket-driven model): declare a project, see the release notes"`), `cli/lib/api/{protocol,server,journal}.ts` (only the mission verbs; the journal keeps its file and ids, without the Inbox helpers), `cli/lib/commands/team.ts` (subcommands `converge`, `status`, `assign`/`release` as the human's escape hatch on an executor with a sub-task id, `sync <repository>`, `for-repo`, `task-base`, `upload-pack`), `cli/lib/commands/team-laptop.ts` and `cli/forge.ts` (no `watch`, `inbox`, `question`, `answer`), `cli/lib/commands/completion.ts`, `cli/lib/team-memory.ts` (sums the project's containers), `cli/lib/commands/notify.ts` (still types its notice into the executor's session), `tests/integration/{team,api}.test.ts` (removed or rewritten on the project), `README.md` (sections 3, 4, Herdr App, Commands, "Agents talk to each other", Configuration: rewritten for a project, the ticket base and missions, with the release note: ship every task, then recreate the containers), and the repository's `CLAUDE.md` (Stack and Runtime sections: teams → project, orchestrator, missions).

- [ ] Work in this order, running `npm run check` after each step so the compiler lists what still refers to a removed name: config; API; commands and laptop; provisioning and mirrors; Herdr mod; tests; docs. Every removed test file must be one whose module is removed; any other failing test is a regression to fix, not to delete.
- [ ] Run `npm test` (the full suite runs on this VM), `ansible/tests/vm-test.sh --lima`, and `grep -rn -E "ask-human|forge answer|team watch|talkTo|read-team|agent-pilot" cli container teams tests README.md`: expected no hit outside the release note.
- [ ] Commit in a few steps (`refactor:` / `docs:`), each compiling and green.

### Task 5: End to end on the VM

**Files:** Create `tests/integration/orchestrator.test.ts`.

- [ ] Write it: a project with one local repository and two executors, a ticket base with two tickets in `dev` (each two sub-tasks); converge; replace `/usr/local/bin/forge-agent` in each executor by a stub of the same name that only `exec sleep infinity` (so no Claude session starts and the session stays live, which keeps the orchestrator's recovery quiet); check the service is `active`; then simulate the agents instead of Claude: for each assigned executor, inside its clone as `aiuser`, commit a file and run `forge-team done`; wait (bounded, 3 min) until both tickets reach `qa` in the base; assert every `agent/T-n.m` branch is in the team mirror, sub-task 2 of each ticket descends from sub-task 1, and the sub-task files hold their branch link. Run `FORGE_INTEGRATION=1 node --test --test-concurrency=1 tests/integration/orchestrator.test.ts`. Expected: PASS.
- [ ] Commit `test: de bout en bout, des tickets Markdown aux branches empilées`.

## Calls made while writing (to check)

- `forge team assign`/`release` stay as the human's escape hatch (§6.10), on an executor and a sub-task id, without the orchestrator's checks.
- The agents' sessions are simulated in the end-to-end test: a real Claude run is the maintainer's morning check, with a token on the host.
- The Pilot's files stay unused until part 2.
