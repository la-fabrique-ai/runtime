# Ticket-driven forge, part 3d: `forge fetch` and `forge ship` by ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From their clone, the human reads a ticket's stack (`forge fetch <ticket>`) and ships it (`forge ship <ticket>`): every branch of the stack re-signed, pushed bottom-up, one pull request per sub-task, linked as a GitHub stack, and the ticket set to `pr-review`. A second ship after a cascade rewrites GitHub's branches under a lease.

**Architecture:** The laptop never reads the ticket base. It asks the host, which asks the control container: reads go through the Pilot's channel, as `forge team status` does; the two gestures that change a status (`shipped` here, `merged` in plan 3e) go through a **reserved channel**, a second socket only the orchestrator's user can reach, so the Pilot cannot mark a ticket shipped or merged. The ship plan of today (`cli/lib/laptop/ship-plan.ts`) keeps its rule for a branch that only grew; it gains one case, the **rewrite**, pushed with `--force-with-lease` against the commit the last ship pushed. When a repository asks for it, the ship adds one signed commit on top of the stack that writes the ticket's spec into the repository.

**Tech Stack:** TypeScript run by Node 24, `node:test`. `git`, `gh` (and its `gh-stack` extension, optional). No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.2, §2.4, §6.10, §6.11, §9; decisions 1, 27, 28, 33). First plan of pull request 2 (3d, 3e), on the branch `agent/ticket-driven-part-3-ship`, from `origin/main` once pull request 1 is merged.

## Global Constraints

- The Global Constraints of plan 3a apply, with the branch `agent/ticket-driven-part-3-ship`.
- **The connector does not change.** This plan uses `setSubtaskLinks` (`pr`) and `setTicketStatus`.
- **The human ships, the human merges** (decisions 28, 33). No container holds a GitHub credential; nothing here runs in a container but the reserved channel's server and its client.
- **Decisions of the maintainer for this pull request** (2026-11-27): the spec is copied into the repository as **a committed file**, by a signed commit of the ship; the gestures `shipped` and `merged` go through **a reserved path**, not the Pilot's channel.
- **A force push only ever touches a branch of the ticket being shipped**, always with a lease on an exact commit, never a bare `--force` (decision 27, §9).
- **One repository per ticket** in part 3. `forge fetch <ticket>` and `forge ship <ticket>` run in the clone of that repository and refuse elsewhere, naming the ticket's repository.
- Every ref handed to git is a full `refs/…` name, read with `show-ref --verify`, as `ship-plan.ts` already does.
- A text that comes from an agent or from the ticket base (a title, a commit subject, a spec) is printed through `printable` and never reaches a shell line or an argv as an option.
- The channel's two rules stay: no verb sets a status by name, and nothing here types a line into the Pilot's session.

## Review Focus

1. **A second ship after a cascade when someone pushed a commit on GitHub's branch**: the lease fails, nothing is overwritten, and the message names the branch and the commits GitHub holds (Task 4).
2. **A ship interrupted halfway** (a signing refused at the third branch, a network cut): run again, it pushes only what is missing, opens only the missing pull requests, and records `shipped` once (Tasks 4, 5).
3. **A ticket still in `dev` or `qa`**: refused before anything is signed, because its stack still moves (Task 5).
4. **The spec commit on GitHub's top branch is not in the team mirror**: it must not make the next ship see a diverged branch and rewrite it for nothing (Task 6).
5. **The reserved channel reached by the Pilot's user**: refused by the socket's mode, and the same verbs sent on the Pilot's channel are unknown verbs (Task 1).
6. **A clone that never shipped this ticket (a second laptop) asked to rewrite a branch**: no silent force; the human sees the commits that would be replaced and confirms (Task 4).

---

### Task 1: The reserved channel

**Files:**
- Modify: `cli/lib/orchestrator/channel.ts`, `cli/orchestrator.ts`, `cli/lib/project-provision.ts`
- Create: `cli/lib/orchestrator/human-client.ts` (run in the control container by the host)
- Test: `tests/orchestrator-channel.test.ts`, `tests/orchestrator-main.test.ts`, `tests/project-provision.test.ts`, `tests/integration/` (one case)

**Interfaces — Produces:**
- `serveChannel` takes the set of verbs it serves. The orchestrator serves two sockets: the Pilot's (`--channel`, unchanged) and the reserved one, `--human <path>`, created with mode `0600`, owned by the orchestrator's user, no group. `HUMAN_SOCKET = "/run/forge-orch/human.sock"` in `project-provision.ts`; the unit passes `--human`.
- On the reserved socket only:
  - `{"op":"shipped","id":<ticket>,"prs":[{"subtask":<id>,"url":<https url>}…]}` → `{"ok":true}`. The ticket must be in `human-review` or `pr-review` (otherwise `<id> is <status>: only a reviewed ticket is shipped`). Every `subtask` is an implementation sub-task of the ticket, `done`; every `url` is an `https://` URL of at most 500 bytes, without control characters. All checked before anything is written. Then `setSubtaskLinks({id, pr})` for each, then the ticket to `pr-review`. Sent again, it changes nothing. Logged as `shipped <id>: <n> pull requests`.
  - `{"op":"merged","id":<ticket>}` → `{"ok":true}`. The ticket must be in `pr-review` (a ticket already `done`: accepted, nothing changes). Sets it `done`. Logged as `merged <id>`.
- `human-client.ts`: reads one JSON request on stdin, sends it to `HUMAN_SOCKET`, prints the reply line, exits 0 on `ok`, 1 on a refusal (its message on stderr), 2 when the socket does not answer. Same imports rule as the orchestrator (`tests/orchestrator-imports.test.ts`); installed with the orchestrator's files under `/opt/forge`.

- [ ] **Step 1: Write the failing tests.** Through the real Markdown base: `shipped` on a ticket in `human-review` with two done sub-tasks sets both `pr` links and the ticket `pr-review`; sent again, same reply and no change; on a ticket in `dev`, refused and no link written; with a sub-task of another ticket, refused and no link written. `merged` on `pr-review` gives `done`; on `human-review`, refused. `shipped` sent on a channel served with the Pilot's verbs is `unknown verb`; `create-fixes` sent on the reserved one too. The unit's text holds `--human /run/forge-orch/human.sock`. Integration: in the control container, `aiuser` cannot connect to the reserved socket; the orchestrator's user can.
- [ ] **Step 2: Run** `node --test tests/orchestrator-channel.test.ts tests/orchestrator-main.test.ts tests/project-provision.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The socket's mode is set before `listen` returns to callers (create it in a directory only its owner can enter, or under a restrictive umask): never a window where it is group-writable.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: un canal réservé à l'humain pour marquer un ticket livré ou fusionné`.

### Task 2: The host answers the laptop about a ticket

**Files:**
- Modify: `cli/lib/commands/team.ts`, `cli/lib/incus.ts` (running a command in the control container as the orchestrator's user)
- Test: `tests/team-command.test.ts`

**Interfaces — Consumes:** the channel's `ticket` and `mission` verbs (through `forge-team` as `aiuser`, as `ticketsUnderWay` does); `human-client.ts` (Task 1). **Produces**, on the host, three sub-commands the laptop calls over SSH, listed in the usage as "read by forge fetch and forge ship":
- `forge team ticket <ticket>` prints one JSON line:
  `{"id","title","status","stacks":[{"repository","base","subtasks":[{"id","branch","text","pr"}…]}…],"fixes":<n>,"unfinished":[<sub-task ids>],"spec":<text|null>,"answers":<text|null>}`.
  A stack holds the **implementation** sub-tasks of one repository, by position, bottom first; `base` is the repository's base of the ticket (`origin/<b>`); `branch` is `agent/<sub-task id>`; `text` is the sub-task's first line; `fixes` counts the fix sub-tasks; `unfinished` lists every sub-task that is not `done`. Exit 1 with the channel's message when the ticket does not exist; exit 2 when the control container does not answer in 15 s.
- `forge team shipped <ticket>` reads a JSON array `[{subtask, url}…]` on stdin and sends `shipped` on the reserved channel.
- `forge team merged <ticket>` sends `merged`.
  Both run `human-client.ts` in the control container **as the orchestrator's user** (its uid read in the container; no supplementary group is needed), the request on stdin, with a 15 s timeout, and relay its exit code and message.

- [ ] **Step 1: Write the failing tests**, with the fake `incus`: `forge team ticket T-1` on a ticket with two implementation sub-tasks and one fix prints the stack of two, `fixes: 1`, and the mission files' text; `forge team shipped T-1` runs the client in the control container under the orchestrator's uid, never as `aiuser` and never as root, with the JSON on stdin and no URL in an argv; a refusal of the client is relayed with exit 1.
- [ ] **Step 2: Run** `node --test tests/team-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'hôte donne la pile d'un ticket et relaie les gestes livré et fusionné`.

### Task 3: `forge fetch <ticket>`

**Files:**
- Modify: `cli/lib/commands/fetch.ts`, `cli/forge.ts` (the argument)
- Create: `cli/lib/laptop/ticket.ts`
- Test: `tests/fetch.test.ts`, `tests/laptop-ticket.test.ts`

**Interfaces — Produces:**
- `ticket.ts`: `type TicketStack = { id: string; title: string; status: string; repository: string; base: string; subtasks: { id: string; branch: string; text: string; pr: string | null }[]; fixes: number; unfinished: string[]; spec: string | null; answers: string | null }` and `readTicket(ctx, host, id, repository): Promise<TicketStack>`: calls `forge team ticket <id>` on the host, validates the reply by hand (unknown shape: `<host> answered something that is not a ticket`), and picks the stack of `repository`. A ticket with no stack in this repository: `<id> has no sub-task in <repository>: its stack is in <other>`. Every `branch` must be `agent/` + a task name (`isTaskName`), every `base` a safe ref.
- `forge fetch` without an argument: unchanged.
- `forge fetch <ticket>`: fetches as today, then prints, instead of every branch:
  ```
  T-3  human-review  <title>
    agent/T-3.1  2 commits on origin/main
    agent/T-3.2  3 commits on agent/T-3.1, 1 not shipped
  Review it: git log -p refs/remotes/origin/main..refs/remotes/<remote>/agent/T-3.2
  ```
  one line per sub-task of the stack, bottom first, with the counts `cmdFetch` already computes; then the one command that shows the whole ticket. When `unfinished` is not empty: `T-3 is still moving: <ids> not done`. A branch missing from the team mirror: `agent/T-3.2  not in the team mirror`.
- An argument that is not a ticket id (`isTicketId`) is a usage error.

- [ ] **Step 1: Write the failing tests**: `readTicket` refuses a reply whose `branch` is `--upload-pack=x`; `forge fetch T-3` in a clone of the ticket's repository prints the three lines above from a fake host reply and fake refs; in a clone of another repository, it refuses naming the ticket's one.
- [ ] **Step 2: Run** `node --test tests/fetch.test.ts tests/laptop-ticket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forge fetch <ticket> montre la pile d'un ticket`.

### Task 4: The ship plan knows a rewritten branch

**Files:**
- Modify: `cli/lib/laptop/ship-plan.ts`, `cli/lib/laptop/replay.ts`
- Test: `tests/laptop-ship-plan.test.ts`, `tests/laptop-replay.test.ts`

**Interfaces — Produces:**
- `TaskPlan` gains `rewrite: boolean`, `lease: string | null` (the commit GitHub's branch must still be at; null when not a rewrite, or when no lease can be given) and `foreign: string[]` (see the lease, below; empty otherwise).
- `planTask` decides, for a branch already on GitHub (`shipped`):
  - **it only grew** when (a) for a stacked branch, the tip of the branch below as this ship leaves it is an ancestor of `origin/agent/<t>`, and (b) no commit of `origin/agent/<t>` beyond what it stands on lacks a patch-equivalent among the task's own commits in the team mirror (`git cherry <team tip> <origin branch> <limit>` prints no `+`). Then the plan is today's: the new commits onto `origin/agent/<t>`, a plain push;
  - otherwise it is a **rewrite**: every own commit of the task (limit..tip in the team mirror), onto the branch below as this ship leaves it (for the bottom of the stack: onto the merge base of its base and its tip, as a first ship does), `rewrite: true`.
  The caller passes what the branch below becomes (`below.tip`, a commit), since it is known only once the branch below is planned; a branch whose lower neighbour is rewritten or grows in this ship is itself a rewrite.
- **The lease.** After each successful push, `replayAndPush` records the pushed commit in the clone as `refs/forge/shipped/agent/<t>`. For a rewrite, `lease` is that ref's commit when it equals `origin/agent/<t>` as just fetched. When the ref is missing or differs (another clone shipped it, or someone pushed on GitHub), `planTask` returns `lease: null` with `rewrite: true` and `foreign: string[]`, the commits of `origin/agent/<t>` that the rewrite would replace; the command (Task 5) shows them and asks.
- `replayAndPush`: a rewrite pushes with `--force-with-lease=refs/heads/agent/<t>:<lease>`; a rejected lease is `GitHub's agent/<t> moved since the last ship: nothing was overwritten. Run forge fetch <ticket> and look at it.` It never passes a bare `--force`, and refuses a rewrite whose branch is not in the list of the ticket's branches it was given (`agent/<t> is not a branch of <ticket>: not forced`).
- A plan with no commit to replay and nothing to rewrite stays `nothing`.

- [ ] **Step 1: Write the failing tests**, in a temporary repository with a bare "GitHub" and a bare "team mirror": (1) A and B shipped; a fix commit lands on A in the team mirror and B is rebased onto it: A's plan is a growth of one commit, B's a rewrite of its own commits onto the new A, and after the ship GitHub's B stands on GitHub's A. (2) B rebased with a conflict resolved (its patch changed): a rewrite, pushed under the lease. (3) Someone pushes a commit on GitHub's B after the last ship: the rewrite is refused with the message above and GitHub's B keeps that commit. (4) No `refs/forge/shipped` ref in the clone: the plan carries the foreign commits and no lease. (5) A rewrite of a branch outside the ticket's list is refused.
- [ ] **Step 2: Run** `node --test tests/laptop-ship-plan.test.ts tests/laptop-replay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le ship réécrit une branche rebasée, sous bail`.

### Task 5: `forge ship <ticket>`

**Files:**
- Modify: `cli/lib/commands/ship.ts`, `cli/lib/laptop/pr.ts`, `cli/forge.ts`, `cli/lib/laptop/prereqs.ts` (the optional `gh-stack`)
- Test: `tests/ship.test.ts` (create, or the file that holds ship's tests today), `tests/laptop-pr.test.ts`

**Interfaces — Consumes:** `readTicket` (Task 3), `planTask` and `replayAndPush` (Task 4), `forge team shipped` (Task 2). **Produces:**
- `forge ship <ticket> [--host <name>]`. The argument is a ticket id; a sub-task id is refused: `forge ship takes a ticket: forge ship T-3`. Shipping one sub-task's branch, as before this plan, is gone.
- In order, nothing signed before every check and question has passed:
  1. `requireGh`, the fetch (as `fetchAgents`), `readTicket`.
  2. The ticket is in `human-review` or `pr-review`, and `unfinished` is empty; otherwise `<id> is <status>: its stack still moves, nothing shipped`.
  3. Every branch of the stack is in the team mirror; the plans, bottom first (Task 4). A sub-task whose pull request is merged is skipped as today, and the one above goes onto that pull request's base.
  4. The commits to sign, listed per branch as today, with `(rewritten)` after the name of a rewritten branch; for a rewrite without a lease, the foreign commits it would replace, then the question `Replace <n> commits of GitHub's agent/<t>?`. Then the one question `Sign and push <n> commits?`.
  5. Bottom first: replay, push, fetch the pushed branch, `ensurePr` (base: the branch below, or the stack's base).
  6. `linkStack`: with at least two open pull requests, `gh stack link` them bottom first. Without the extension, or when the link fails: one line (`the pull requests are not linked as a stack: <why>`), and the ship goes on; the bases are right either way.
  7. `forge team shipped <ticket>` on the host with every sub-task's pull request URL (the merged ones included). When it fails, the pull requests are printed and the last line says the ticket was not marked shipped and gives the command again.
- `ensurePr`'s description: the title is the sub-task's first line when the branch has several commits (`<ticket id>` stays out of it); the body ends with `Ticket <id>, sub-task <n> of <total>.` The text comes from the ticket base: one line, without control characters, at most 200 bytes.
- The last line: `T-3: shipped, in pr-review. <n> pull requests.`

- [ ] **Step 1: Check `gh stack link` on a scratch repository** (its arguments, what it prints, what it does to pull requests already linked) and write what was found in `docs/superpowers/spikes/2026-11-28-gh-stack-link.md`, with the `gh` and extension versions. The docs say it "links pull requests into a stack on GitHub without local tracking"; the exact arguments are not taken from memory. If the feature is not available to the account, say so there: step 6 then only prints its line.
- [ ] **Step 2: Write the failing tests**, with a fake `gh` and a fake host: a ticket in `qa` is refused and nothing is signed; a first ship of a stack of two pushes A then B, opens B's pull request against `agent/<A>`, links the two and sends `shipped` with both URLs; run again with nothing new, it signs nothing, opens nothing and sends `shipped` again; a `forge team shipped` that fails leaves exit 1 and the command to run; a missing `gh-stack` does not fail the ship; a title holding an escape sequence reaches `gh` without it.
- [ ] **Step 3: Run** the two test files. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same, then `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: forge ship <ticket> livre la pile d'un ticket en pull requests empilées`.

### Task 6: The spec, committed with the ship

**Files:**
- Modify: `cli/lib/project-config.ts`, `cli/lib/commands/team.ts` (`forge team ticket` says the folder), `cli/lib/laptop/ticket.ts`, `cli/lib/laptop/replay.ts`, `cli/lib/laptop/ship-plan.ts`, `cli/lib/commands/ship.ts`
- Test: `tests/project-config.test.ts`, `tests/laptop-replay.test.ts`, `tests/laptop-ship-plan.test.ts`

**Interfaces — Produces:**
- Config: `project.repositories.<name>.specDir`, optional, a relative folder of the repository (`docs/specs`): segments of `[A-Za-z0-9._-]`, no leading `/`, no `..`, no empty segment, at most 200 bytes. Absent: no copy. `forge team ticket` adds `"specDir": <string|null>` to each stack.
- With a `specDir` and a ticket that has a `spec`, the ship adds, on top of the **top branch** of the stack, one commit that writes `<specDir>/<ticket id>.md`: the spec, then, when there are answers, a line `## Answers` and the answers. Signed like the others, message `docs: spec of <ticket id>`, with the trailer `Forge-Spec: <ticket id>`. It counts in the number of commits the question announces, on its own line (`  the spec, as <path>`).
- It is made in the replay's worktree, after the top branch's commits, from text the laptop holds: written to the file by Node, never through a shell.
- **Idempotent.** When the file at the tip of GitHub's top branch already has that exact content, no commit. When the content changed (the review changed the spec), one new commit.
- **Not a divergence.** In Task 4's comparison, a commit of `origin/agent/<t>` that carries the trailer `Forge-Spec: <ticket id>` and touches only `<specDir>/<ticket id>.md` is forge's own: it is ignored when deciding between growth and rewrite, and made again after a rewrite.
- A `spec` longer than 1 048 576 bytes, or a `specDir` path that exists in the tree as a file: refused before anything is signed.

- [ ] **Step 1: Write the failing tests**: the config refuses `../x`, `/abs` and `a//b` for `specDir`; a first ship with a `specDir` leaves GitHub's top branch with one more signed-path commit holding the file; a second ship with the same spec adds nothing and plans no rewrite; a second ship with a changed spec adds one commit; after a rewrite of the top branch, the file is there once.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run test:unit` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le ship copie la spec du ticket dans le dépôt, par un commit signé`.
