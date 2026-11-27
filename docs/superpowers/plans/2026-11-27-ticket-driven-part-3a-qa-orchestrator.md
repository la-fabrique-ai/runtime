# Ticket-driven forge, part 3a: QA, fixes, rebase and the cascade, seen from the orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket whose sub-tasks are all done is tested by a QA mission on the top of its stack; a defect becomes a fix sub-task on the branch it belongs to; the sub-tasks above are rebased one by one; the QA runs again; a clean QA sends the ticket to human review — all testable with a Markdown base in a temporary folder and a fake host.

**Architecture:** Two mission kinds join `dev`: `rebase` and `qa`. The cascade is **not** a list the orchestrator keeps: before each QA it asks the host which branch of the stack no longer stands on the tip of what is below it (a new verb, `stack`), and sets the lowest such sub-task back to `ready`, reason `rebase`. A fix that adds commits to a branch, a base that moved on GitHub and a rebase done by hand are then the same case, and a crash loses nothing. A QA report is structured (a verdict and a list of defects); its text is copied into fix sub-tasks, never interpreted.

**Tech Stack:** TypeScript run by Node 24, `node:test`. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.2 to §2.5, §6.4, §6.7; decisions 2, 5, 6, 7, 18, 35). Part 3 is five plans in **two pull requests**. Pull request 1, branch `agent/ticket-driven-part-3-qa`: 3a (this one), 3b (the host and the executor's kit), 3c (the review with the Pilot). Pull request 2, branch `agent/ticket-driven-part-3-ship`, from `origin/main` once the first is merged: 3d (`forge fetch` and `forge ship` by ticket), 3e (peer comments, Done, the docs). Out of part 3: several repositories per ticket and a ticket built on another's stack (part 4).

## Global Constraints

- One branch for plans 3a, 3b and 3c: `agent/ticket-driven-part-3-qa`, from `origin/main`. Commit messages conventional and in French; code comments in French; messages shown to an agent or to the human in English, as in parts 1 and 2.
- **The connector does not change** (`cli/lib/tickets/connector.ts`, `model.ts`): a colleague builds on it. Everything here uses what it already has: `createSubtask` (`kind: "fix"`, `fixes`), `setSubtaskStatus` (`reason: "rebase"`), `setTicketStatus`, `addComment` (`kind: "qa-report"`).
- **Self-contained** (`tests/orchestrator-imports.test.ts`): every file under `cli/lib/orchestrator/` and `cli/lib/tickets/`, and `cli/orchestrator.ts`, imports only `node:*` and those two folders.
- The orchestrator reads structured fields only. A defect's text, a report, a mission file are copied verbatim, never interpreted (decision 24, anti-goal).
- **No state the flow needs** outside the ticket base and the host (§6.4): every step below is recomputed from the picture at each turn, or is safe to replay.
- **One repository per ticket** in part 3: a ticket that lists several repositories gets no QA and a problem line (`<ticket>: several repositories: QA comes with part 4`).
- **A fix sub-task has the repository and the position of the sub-task it fixes**, and a rank after every existing one. It never fixes another fix: a defect attributed to a fix sub-task goes to the sub-task that one fixes.
- An instruction stays under 65 536 bytes. Tests stay lean (repository rule): the cases named in each task, no sweep of edge cases.

## Review Focus

1. **A QA `done` read twice, or a crash while its fix sub-tasks are being created**: no fix sub-task is created twice, and the ticket goes back to `dev` once (Task 5).
2. **The turn releases an executor "whose sub-task is done"**: a QA mission holds the top sub-task, which is done; it must not be released by that rule, nor by the recovery's "no longer to do" (Task 6).
3. **A fix sub-task shares its position with the one it fixes**: the base of the sub-task above is still the branch of the implementation sub-task, never `agent/<fix>` (Task 2).
4. **The base moved, or a branch below changed, between the ticket going to `qa` and its QA starting**: the stale sub-task is rebased first; no QA starts on a stale stack (Task 4).
5. **A QA report naming a sub-task that does not exist, or a fix sub-task**: the defect is kept, as a transverse sub-task or on the sub-task that fix fixes (Task 3).
6. **A QA or rebase mission whose session died, or a rebase stopped by a question**: it is started again as the same kind, not as a dev mission (Task 6).

---

### Task 1: The contract grows

**Files:**
- Modify: `cli/lib/orchestrator/host.ts`
- Test: `tests/orchestrator-host.test.ts`

**Interfaces — Produces** (keep the names verbatim; plan 3b implements them on the host):
- `type MissionKind = "dev" | "rebase" | "qa"`. `MissionSpec` keeps its fields for the three kinds:
  - `dev`: as today; for a fix sub-task, `subtask` is the fix's id and `branch` the branch of the sub-task it fixes;
  - `rebase`: `subtask` is the sub-task rebased, `branch` its branch, `base` what it must stand on;
  - `qa`: `subtask` is the top sub-task of the ticket's stack, `branch` its branch, `base` its base; a QA mission commits nothing;
- `type QaDefect = { subtask: string | null; text: string }` (`null`: transverse), `type QaReport = { verdict: "ok" | "ko"; defects: QaDefect[] }`;
- `DoneEvent` gains `mission: MissionKind` and `qa: QaReport | null` (`null` unless `mission` is `"qa"`);
- `type StackBranch = { repository: string; branch: string; base: string }`, `type StackState = { branch: string; current: boolean; builtOn: string | null }`;
- `HostApi` gains `stack(branches: StackBranch[]): Promise<StackState[]>`: one state per branch, in the order asked. `builtOn` is the commit of `base` the branch stood on at its last hand-back (`null`: never recorded); `current` is true when that commit is still the tip of `base` (the origin mirror for `origin/<b>`, the team mirror for `agent/<x>`). A branch the team mirror does not have is a refusal;
- the wire format, added to the comment at the top of the file: `{"op":"stack","branches":[{"repository":…,"branch":…,"base":…}…]}` → `{"ok":true,"branches":[{"branch":…,"current":<bool>,"builtOn":<sha or null>}…]}`.

- [ ] **Step 1: Write the failing tests**: an `events` reply holding a `done` with `"mission":"qa"` and a `qa` object parses, and one whose `qa.defects[0].subtask` is a number is refused; a `done` without `mission` is refused; `stack` sends exactly the line above and returns the two states of a two-branch reply; a reply with one state for two branches is refused.
- [ ] **Step 2: Run** `node --test tests/orchestrator-host.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, the parsers (exact keys, as today) and the client method.
- [ ] **Step 4: Run** the same, then `npm run check`. Expected: the test file PASSES; `check` shows type errors only in `tick.ts` and `cli/lib/api/missions.ts`, fixed by the tasks below and plan 3b. Until then, make them compile with the smallest change (`mission: "dev"`, `qa: null`).
- [ ] **Step 5: Commit** `feat: le contrat de l'API hôte pour les missions rebase et QA et l'état d'une pile`.

### Task 2: The rule knows fixes, rebases and QA

**Files:**
- Modify: `cli/lib/orchestrator/rule.ts`
- Test: `tests/orchestrator-rule.test.ts`

**Interfaces — Produces:**
- `stackOf(subtasks: Subtask[], repository: string): Subtask[]`: the `implementation` sub-tasks of that repository, by `position`;
- `branchOf(subtasks: Subtask[], s: Subtask): string`: `agent/<s.fixes>` for a fix, `agent/<s.id>` otherwise; a fix whose `fixes` is not an implementation sub-task of the list is a `RuleError`;
- `missionBase(ticket, subtasks, s)`: unchanged for an implementation sub-task, except that the sub-task below is looked up in `stackOf` (fix sub-tasks are ignored); for a fix, the base of the sub-task it fixes;
- `Candidate` gains `kind: "dev" | "rebase"` (`"rebase"` when `s.reason === "rebase"`) and `branch: string`;
- `type QaCandidate = { ticket: Ticket; top: Subtask; base: string; stack: StackBranch[] }` and `qaCandidates(tickets: { ticket: Ticket; subtasks: Subtask[] }[]): { candidates: QaCandidate[]; problems: string[] }`: one per ticket whose sub-tasks are all `done` and that has at least one implementation sub-task; `stack` lists that repository's implementation sub-tasks bottom-up with their branch and base; a ticket with several repositories gives the problem line of the Global Constraints.

- [ ] **Step 1: Write the failing tests**: with A (position 1), B (position 2) and a fix F of A (position 1, kind fix), `missionBase` of B is `agent/A` and `branchOf` of F is `agent/A`, base `origin/main`; a `ready` sub-task with reason `rebase` gives a candidate of kind `rebase`; `qaCandidates` gives the stack `[A on origin/main, B on agent/A]` and names B as top, ignores a ticket with a sub-task not done, and reports a two-repository ticket.
- [ ] **Step 2: Run** `node --test tests/orchestrator-rule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: la règle connaît les correctifs, les rebases et la QA`.

### Task 3: Fix sub-tasks

**Files:**
- Create: `cli/lib/orchestrator/fixes.ts`
- Test: `tests/orchestrator-fixes.test.ts`

**Interfaces — Consumes:** `Connector`, `stackOf`. **Produces:**
- `resolveFixed(subtasks: Subtask[], id: string | null): Subtask | null`: the implementation sub-task a defect belongs to: `id` itself, or the one it fixes when `id` is a fix sub-task; `null` for `null` or an id the list does not have;
- `addFix(tickets: Connector, ticket: Ticket, a: { fixes: string | null; text: string }): Promise<Subtask>`: with a sub-task resolved by `resolveFixed`, a `fix` sub-task with that sub-task's repository and position, `fixes` set to it, rank one above the highest; otherwise (transverse) an `implementation` sub-task on top of the stack of the ticket's only repository. A sub-task that is not `done`, of the same kind, the same `fixes` and the same text already there is returned instead of a second one. Plan 3c reuses it for the review.

- [ ] **Step 1: Write the failing tests**, through the real Markdown base: a defect on A creates a fix at A's position, `fixes: A`, rank 3 after A and B; called again with the same text, it returns the same sub-task and the base still holds one; a defect on a fix of A is attributed to A; a defect with `fixes: null`, or naming `T-9.9`, creates an implementation sub-task at position 3.
- [ ] **Step 2: Run** `node --test tests/orchestrator-fixes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: un défaut devient une sous-tâche de correctif, une seule fois`.

### Task 4: The instructions of a rebase and of a QA

**Files:**
- Modify: `cli/lib/orchestrator/instruction.ts`
- Test: `tests/orchestrator-rule.test.ts`

**Interfaces — Produces:**
- `devInstruction`: the `## Branch` section uses the candidate's `branch`; for a fix, one more line under `## Sub-task`, exactly: `You fix sub-task <fixes> on its branch: add commits on top, never rewrite the ones that are there.`;
- `rebaseInstruction(c: Candidate, builtOn: string | null, resumed: boolean): string`: first line `[forge] mission rebase <sub-task> (ticket <ticket>)`; then, exactly: `The branch below yours changed. Replay your sub-task's own commits onto it, and change nothing else.`; then `## Branch` as a dev mission; then `## How`, with `git fetch team` (or `git fetch origin` for an `origin/` base), then `git rebase --onto <ref> <builtOn>` when `builtOn` is not null and `git rebase <ref>` otherwise, where `<ref>` is `team/<base>` for an `agent/` base and the base itself for an `origin/` one; then: `Solve a conflict as the sub-task's text and the mission files say. If they do not settle it, run git rebase --abort, then ask as in any mission. Run the project's checks, then: forge-team done --report-file <file> (what conflicted, how you solved it, what you ran).`;
- `qaInstruction(q: QaCandidate, extra: { answered: Request[]; files: MissionFiles }): string`: first line `[forge] mission qa <ticket>`; the ticket's title and description; `## Stack`, one line per sub-task bottom-up with its id and its text's first line; `## Mission files` and `## Questions already answered` as a dev mission, with **every** answered request of the ticket; then `## What to do`, exactly: `Your clone is on the top of the stack: it holds the whole ticket. Test it against the spec, as a user would: run the project's checks, then exercise what the ticket changes. Change no file and commit nothing. Write your report as the qa skill says, then run: forge-team done --qa-report-file <file>`.

- [ ] **Step 1: Write the failing tests**: a fix's dev instruction names `agent/A` as its branch and holds the fix line; a rebase instruction with `builtOn` `abc123` on base `agent/A` holds `git rebase --onto team/agent/A abc123`, and without it `git rebase team/agent/A`; a QA instruction starts with its first line, lists A then B, holds an answer given on A, and keeps a description containing `forge-team done; rm -rf /` verbatim.
- [ ] **Step 2: Run** `node --test tests/orchestrator-rule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the same cut order as a dev instruction (the description first).
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: les instructions d'une mission de rebase et d'une mission de QA`.

### Task 5: The QA's report

**Files:**
- Modify: `cli/lib/orchestrator/tick.ts`
- Test: `tests/orchestrator-tick.test.ts`

**Interfaces — Consumes:** `DoneEvent.mission`, `DoneEvent.qa`, `addFix`, `resolveFixed`. **Produces:** `TickReport` gains `qa: { ticket: string; verdict: "ok" | "ko" | "started" }[]`.

In the events loop, a `done` is handled by its `mission`:
- `dev` and `rebase`: as today (`setSubtaskStatus` to `done` clears the reason);
- `qa`, in this order, each step safe to replay: the ticket is not in `qa` → ignored; the free-text report kept as a comment of kind `qa-report` (author: the executor); `ko`: one `addFix` per defect, in the report's order, then the ticket to `dev`; `ok`: the ticket to `human-review`; then the emitter released if it still holds this mission. The ticket's status changes last: a crash before it replays the whole step, and `addFix` creates nothing twice.

- [ ] **Step 1: Write the failing tests**, with the real Markdown base and the fake host (give `FakeHost` a `qaDone(executor, report)` helper): a `ko` with one defect on A and one transverse creates a fix at A's position and a sub-task on top, sets the ticket `dev`, keeps a `qa-report` comment and releases the executor; the same event read again (cursor reset to 0) creates nothing more; an `ok` sets the ticket `human-review`; a QA `done` for a ticket in `dev` changes nothing.
- [ ] **Step 2: Run** `node --test tests/orchestrator-tick.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `onQaDone`, with the error and cursor rule of `onDone`.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le compte rendu d'une QA devient des correctifs ou envoie le ticket en revue`.

### Task 6: The turn hands out QA and rebase missions

**Files:**
- Modify: `cli/lib/orchestrator/tick.ts`, `cli/orchestrator.ts` (the new report lines)
- Test: `tests/orchestrator-tick.test.ts`, `tests/orchestrator-main.test.ts`

**Interfaces — Consumes:** `qaCandidates`, `HostApi.stack`, `qaInstruction`, `rebaseInstruction`.

The turn changes as follows; everything else stays.
- **The picture** reads the tickets in `dev` and in `qa`. A ticket in `qa` with a sub-task that is not `done` goes back to `dev` (a crash between the two writes of the next point).
- **Before the dev distribution, the QA step**, for each QA candidate in `qa`, by priority, that waits for no request and whose QA no executor holds:
  1. `host.stack(candidate.stack)`; a refusal is a problem line for that ticket, and the turn goes on;
  2. the lowest branch that is not `current`: its sub-task goes `ready` with reason `rebase`, then the ticket goes back to `dev`; nothing else for this ticket in this turn;
  3. all current and an executor free: a QA mission is assigned (`kind: "qa"`, the instruction of Task 4, the mission files); no status changes in the base. A refused assign is a problem line and uses the refusal delay that dev missions have.
  QA candidates take free executors before dev candidates (§2.5: finish before starting).
- **A dev or rebase candidate** is launched as today, with its `kind`, its `branch` and, for a rebase, the `builtOn` that `host.stack` gives for its branch (one call for that branch).
- **A sub-task keeps its reason `rebase` until it is `done`**: every status the turn writes before that (`in-dev` at launch, back to `ready` after a refused assign, a lost mission or a question handed back) passes the reason it had. Without it, a rebase interrupted once would come back as a dev mission.
- **A held mission of kind `qa`** is left alone by the rule that releases an executor whose sub-task is `done`, and by the recovery's "no longer to do": it is released only when its ticket is no longer in `qa`.
- **Recovery** (`exited`, `lost`) starts the mission again with its own kind: a QA as a QA while the ticket is in `qa`, a rebase as a rebase.
- `cli/orchestrator.ts` prints `[orchestrator] qa <ticket>: started`, `…: ok` or `…: ko` for each entry of `report.qa`.

- [ ] **Step 1: Write the failing tests** (give `FakeHost` a `stackStates` map, `current: true` by default): a ticket in `qa` with a free executor gets a QA mission on its top sub-task, before a `ready` sub-task of another ticket of higher priority; with branch B not current, B goes `ready` reason `rebase`, the ticket `dev`, no QA is assigned, and the next turn assigns a rebase mission whose instruction holds the `builtOn`; after that rebase's `done` and with all branches current, the ticket is back in `qa` and gets its QA; a rebase mission whose `ask` is handed back leaves its sub-task `ready` with reason `rebase`, and the mission assigned after the answer is a rebase; an executor holding a QA mission is not released by the turn while the ticket is in `qa`, and is released once the ticket is `human-review`; a QA mission whose session is `exited` is assigned again with `kind: "qa"`; a ticket in `qa` whose request waits gets no QA.
- [ ] **Step 2: Run** `node --test tests/orchestrator-tick.test.ts tests/orchestrator-main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:unit`, then `npm run check`. Expected: PASS, with type errors left only in `cli/lib/api/missions.ts` (plan 3b).
- [ ] **Step 5: Commit** `feat: le tour distribue la QA avant le développement, et le rebase d'une pile qui n'est plus à jour`.
