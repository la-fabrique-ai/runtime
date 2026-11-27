# Ticket-driven forge, part 3b: rebase and QA missions on the host, and the executor's kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host accepts the three mission kinds of plan 3a: it prepares the clone for each, checks each hand-back by its kind, tells the orchestrator which branches of a stack no longer stand on what is below them, and the executor's kit knows how to rebase a sub-task and how to run a QA and write its report.

**Architecture:** Everything stays in the host API (`cli/lib/api/missions.ts`), one request at a time under the mission lock. The host's branch records gain one field, `builtOn`: the commit of its base a branch stood on at its last hand-back; the new verb `stack` compares it with the base's tip today. A clone remembers what it last published in a ref of its own (`refs/forge/published/<branch>`), so a branch that a rebase mission rewrote elsewhere is taken from the team mirror instead of being refused as diverged. A QA report is validated field by field before it becomes an event.

**Tech Stack:** TypeScript run by Node 24, `node:test`, the fake `incus` of the unit tests. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.4, §6.4 to §6.7, §6.9). Second of the three plans of pull request 1 (3a, 3b, 3c), on the branch `agent/ticket-driven-part-3-qa`.

## Global Constraints

- The Global Constraints of plan 3a apply. The names of the contract (`MissionKind`, `QaReport`, `QaDefect`, `StackBranch`, `StackState`, the `stack` wire format, `DoneEvent.mission` and `.qa`) are those of plan 3a, Task 1: do not rename them.
- **Validation by hand**, exact keys, as everywhere in `cli/lib/api/`. A text an agent wrote (a defect, a report) is checked with `checkText` like an instruction: its size, and no secret forge handed out.
- **No agent text in an argv or a shell line** (DX 5 anti-goal): a ref the host passes to git is validated (`isGitRef`, a sub-task id) before it reaches a command.
- Every git call of the API keeps a timeout, as the existing ones do.
- The executor's skills are in **English**, its role prompt in **French** (`teams/reference`). No test on the content of a prompt or a skill (repository rule); the kit's test only checks that what `roles.json` names exists.
- `forge-team` reads a text from stdin or from a file, never from an argument.

## Review Focus

1. **A clone that holds an old copy of a branch a rebase mission rewrote in another executor**: the next mission on that branch there takes the team mirror's branch. A clone with commits it never handed back is still refused (Task 2).
2. **A rebase mission's `done` on a branch that was not rebased**: refused, nothing copied to the team mirror (Task 3).
3. **A QA report written by an agent**: wrong keys, a `ko` without a defect, a defect on another ticket's sub-task, a defect holding a secret, 51 defects: each refused with a message that names the field; nothing malformed reaches the events (Task 3).
4. **A QA mission leaves the clone on a detached commit**: the dev mission that follows on that executor starts normally (Task 1).
5. **A branch record written by part 2**, without `builtOn`: read as never recorded, not as a broken file (Task 2).
6. **A fix mission** works on `agent/<fixed sub-task>` while it holds the fix's id: the branch record of that branch keeps its base, and `forge team task-base` still lists one line per branch (Task 1).

---

### Task 1: The three kinds at `assign`

**Files:**
- Modify: `cli/lib/api/missions.ts`
- Test: `tests/api-missions.test.ts`

**Interfaces — Consumes:** `MissionKind`, `MissionSpec` (plan 3a). **Produces:**
- `parseMission` accepts `kind` `dev`, `rebase` or `qa`. `branch` must be `agent/<a sub-task id of the mission's ticket>`; for `rebase` and `qa` it must be `agent/<subtask>`. The refusals name the field, as today;
- `assign` by kind:
  - `dev` and `rebase`: `prepareBranch` as today (Task 2 changes one of its cases);
  - `qa`: in the clone, `git fetch team`, then tracked changes are a refusal (the message of a dev mission off its branch), then `git switch --detach team/<branch>`; a branch the team mirror does not have is a refusal that names it. No branch record is written for a QA;
- the branch record of a `dev` or `rebase` mission is keyed by the branch as today, and its `subtask` is the sub-task the branch is named after (not a fix's id).

- [ ] **Step 1: Write the failing tests**: an assign of kind `qa` runs `git switch --detach team/agent/T-1.2` as aiuser in `/workspace/web`, writes no branch record and starts the session; a `qa` assign on a clone with tracked changes is refused; a `dev` mission `T-1.3` on branch `agent/T-1.1` is accepted and the record of `agent/T-1.1` keeps `subtask: "T-1.1"`; a `dev` mission on `agent/T-2.1` for ticket `T-1` is refused; a `rebase` mission whose branch is not `agent/<subtask>` is refused; kind `review` is refused.
- [ ] **Step 2: Run** `node --test tests/api-missions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'hôte confie les missions de rebase et de QA`.

### Task 2: What a branch stands on, and what a clone last published

**Files:**
- Modify: `cli/lib/branch-records.ts`, `cli/lib/api/missions.ts`
- Test: `tests/branch-records.test.ts`, `tests/api-missions.test.ts`

**Interfaces — Produces:**
- `BranchRecord` gains `builtOn: string | null` (a full commit id). A version-1 record without the key reads with `builtOn: null`; every record written from now on has the key. `recordBranch` on a branch that already has a record keeps its `builtOn`; `setBuiltOn(repository: string, branch: string, sha: string, path?: string): void` changes only that field;
- at each hand-back that copies a branch to the team mirror (`done` of a dev or rebase mission, `ask`), after the copy:
  - the tip of the mission's base is read in the clone (`origin/<b>` after the `git fetch origin`, or `team/<base>` after the `git fetch team`, both of which the hand-back already runs); when it is an ancestor of the branch's tip, `setBuiltOn` records it; otherwise the record is left as it is;
  - `git update-ref refs/forge/published/<branch> HEAD` in the clone, as aiuser;
- `prepareBranch`, in each of the two places where it refuses today because the local branch and the team mirror's have diverged (the clone on the branch, or off it): if the clone has no tracked changes and the local branch's tip equals `refs/forge/published/<branch>` (the clone handed back everything it has), the branch is recreated from the team mirror (`git switch -C <branch> team/<branch>`); otherwise the refusal of today.

- [ ] **Step 1: Write the failing tests**: a records file written without `builtOn` reads with `null`, and `setBuiltOn` then `recordBranch` on the same branch keeps the value; a `done` whose branch contains `origin/main`'s tip records that commit and runs the `update-ref`; a `done` on a branch that does not contain its base's tip leaves `builtOn` as it was; with a local branch equal to its published ref and diverged from the team mirror, `prepareBranch` runs `git switch -C agent/T-1.2 team/agent/T-1.2`, whether the clone is on that branch or not; with a local branch that differs from its published ref, the assign is refused with today's message.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'hôte retient sur quoi une branche est posée, et un clone ce qu'il a rendu`.

### Task 3: The hand-back by kind, and the QA's report

**Files:**
- Modify: `cli/lib/api/missions.ts`, `cli/lib/api/journal.ts`
- Test: `tests/api-missions.test.ts`

**Interfaces — Produces:**
- the request `done` gains an optional field `qa` (`{"op":"done","report":…,"qa":…}`); `parseQaReport(v: unknown, ticket: string, secrets: readonly string[]): QaReport`, exported for its test: exactly `verdict` and `defects`; `verdict` is `ok` or `ko`; `ok` has no defect, `ko` has 1 to 50; a defect is exactly `subtask` (null, or a sub-task id of `ticket`) and `text` (not empty, at most 8 192 bytes, no handed-out secret);
- `done` by the kind of the mission held:
  - `dev`: as today; a `qa` field is refused (`this is not a QA mission`);
  - `rebase`: the branch's tip must contain the tip of its base (`git merge-base --is-ancestor`), else the refusal `<branch> does not stand on <base>: rebase it, then report done again`; no minimum of commits; the branch is copied to the team mirror (the copy already forces);
  - `qa`: the `qa` field is required (`a QA mission ends with forge-team done --qa-report-file <file>`); the clones have no tracked changes; nothing is copied;
- the journal entry of a QA `done` carries the report (`Entry` gains `qa?: QaReport`); `events` gives each `done` its `mission` (the kind of the entry's mission; an entry written by part 2, without a kind, is `dev`) and its `qa` (`null` unless present).

- [ ] **Step 1: Write the failing tests**: the six refusals of Review Focus 3, each naming its field; a QA `done` with a valid `ko` report is accepted, copies nothing, and the event carries `mission: "qa"` and the two defects; a dev `done` carrying `qa` is refused; a rebase `done` whose branch does not contain `team/agent/T-1.1`'s tip is refused and nothing is fetched into the mirror; a rebase `done` that contains it is accepted with no commit of its own beyond the base check of today.
- [ ] **Step 2: Run** `node --test tests/api-missions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'hôte vérifie le rendu d'un rebase et le compte rendu d'une QA`.

### Task 4: The verb `stack`

**Files:**
- Modify: `cli/lib/api/missions.ts`
- Test: `tests/api-missions.test.ts`

**Interfaces — Consumes:** the wire format of plan 3a, `BranchRecord.builtOn`. **Produces:** `stack`, a verb of the control container only: at most 50 branches; each `repository` declared in the project, each `branch` `agent/<sub-task id>`, each `base` accepted by the existing base check. For each, on the host and without touching a container: the branch must exist in the repository's team mirror (else the refusal `<branch> is not in the team mirror of <repository>`); the tip of its base is read in the origin mirror (`refs/heads/<b>` for `origin/<b>`) or in the team mirror (`refs/heads/<base>`); `current` is true when the record's `builtOn` is that tip. The verb writes no journal line (it runs at every turn, as `events`).

- [ ] **Step 1: Write the failing tests**: for A recorded on `origin/main`'s tip and B recorded on an older commit of `agent/A`, the reply is `[{A, current: true, builtOn}, {B, current: false, builtOn}]`; a branch without a record is `current: false, builtOn: null`; a branch the team mirror lacks is refused; an executor's socket is refused the verb.
- [ ] **Step 2: Run** `node --test tests/api-missions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run check`. Expected: PASS, no type error left from plan 3a.
- [ ] **Step 5: Commit** `feat: l'hôte dit quelles branches d'une pile ne sont plus à jour`.

### Task 5: `forge-team` and what the human sees

**Files:**
- Modify: `container/forge-team`, `cli/lib/commands/team.ts`
- Test: `tests/forge-team.test.ts`, `tests/team-command.test.ts`

**Interfaces — Produces:**
- `forge-team done [--report-file <file>] [--qa-report-file <file>]`: the second file is read and parsed as JSON by `forge-team` (a file that is not JSON is a usage error, exit 64, nothing sent) and sent as the `qa` field; the usage text names it;
- `forge-team status` and `forge team status` show the kind of a mission that is not `dev`: `qa T-1 (web)`, `rebase T-1.2 (web)`; a dev mission reads as today.

- [ ] **Step 1: Write the failing tests**: `done --qa-report-file` sends `{"op":"done","report":null,"qa":{…}}`; a file holding `not json` exits 64 and sends nothing; the status table shows `qa T-1 (web)` for a held QA mission.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forge-team rend le compte rendu d'une QA, et le statut dit le genre d'une mission`.

### Task 6: The executor's kit

**Files:**
- Create: `teams/reference/skills/qa/SKILL.md`
- Modify: `teams/reference/roles.json`, `teams/reference/prompts/executor.md`, `container/CLAUDE.md`
- Test: `tests/reference-kit.test.ts`

What each file must say (the wording is the builder's; skills in English, the prompt in French):
- **`executor.md`**: the first line of the session says the kind (`[forge] mission dev`, `rebase` or `qa`), and each kind has its paragraph. Dev: as today, plus: a fix adds commits on the branch of the sub-task it fixes and never rewrites it. Rebase: replay the sub-task's own commits as the mission says, solve a conflict from the sub-task and the mission files, ask if they do not settle it, run the checks, never change what the sub-task does. QA: follow the skill `qa`; change no file, commit nothing.
- **`skills/qa/SKILL.md`**: read the mission files and the answers; run the project's checks one at a time; exercise what the ticket changes as a user would (the project's Docker services, the browser when there is a UI); a defect is something the spec asks and the stack does not do, or something it breaks: never a preference. Attribute each defect to the sub-task whose commits introduced it (`git log team/agent/<below>..team/agent/<sub-task>` lists a sub-task's own commits), or to none (transverse) when it belongs to no single one. Write two files outside the clone: the free report (what was run, what was seen) and the structured one, exactly `{"verdict":"ok","defects":[]}` or `{"verdict":"ko","defects":[{"subtask":"<id or null>","text":"<what is wrong, how to see it, what the spec says>"}]}`; the defect's text is all the developer of the fix will get, so it must stand alone. Then `forge-team done --qa-report-file <json> --report-file <report>`.
- **`roles.json`**: the executor's skills gain `qa`.
- **`container/CLAUDE.md`**: the three kinds of mission in « Une mission à la fois », and `--qa-report-file` under `forge-team done`.

- [ ] **Step 1: Write the failing test**: the kit of the executor role lists the skill `qa` and its file is read (the existing test's form).
- [ ] **Step 2: Run** `node --test tests/reference-kit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write** the four files.
- [ ] **Step 4: Run** the same, then `npm run test:unit` and `npm run test:contract`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le kit de l'exécuteur sait rebaser une sous-tâche et mener une QA`.

### Task 7: One integration test

**Files:**
- Modify: `tests/integration/project.test.ts`

Runs only with `FORGE_INTEGRATION=1`, on a real Incus (the dev VM), with the simulated sessions the file already uses.

- [ ] **Step 1: Write the test**: two stacked sub-tasks A and B handed back from executor 1; a commit added to A from executor 2 and handed back; `stack` then says B is not current; a rebase mission of B on executor 2 (which holds no copy of B) rebases it and hands it back; `stack` says both current; a mission on B assigned to executor 1, whose clone holds the old B, starts without a refusal and its clone is on the rebased B; a QA mission on executor 1 leaves a detached HEAD on B's tip and its `done --qa-report-file` gives an event with `mission: "qa"`.
- [ ] **Step 2: Run** `FORGE_INTEGRATION=1 npm run test:integration`. Expected: PASS for this test (say which other tests fail, and whether they fail on `origin/main` too).
- [ ] **Step 3: Commit** `test: une pile rebasée dans un exécuteur se reprend dans un autre, et une QA rend son compte rendu`.
