# Ticket-driven forge, part 2b: the host API for questions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host API implements the contract of plan 2a: an executor asks (`ask`) and hands back unfinished work (`done --wip`) or a report; the orchestrator starts a question session in the control container (`session`), delivers an answer into a developer's session (`answer`), and each mission gets a read-only copy of its mission files.

**Architecture:** Everything is in `cli/lib/api/missions.ts`, on the pattern of part 1: a verb per socket kind, a request validated by hand, the mission changes one at a time (`exclusive()` and the mission lock), a journal line per call. The pending question of an executor is an instance key, as its mission is. `cli/lib/hc-session.ts` learns to run a session that is not the container's `agent` terminal.

**Tech Stack:** TypeScript run by Node 24, the fake `incus` and fake `hc` of the unit tests. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§6.4, §6.5, §6.6, §9). Plan 2a is done on this branch: its `cli/lib/orchestrator/host.ts` is the contract, keep its names and its wire format verbatim.

## Global Constraints

- Same branch (`agent/ticket-driven-part-2`); commit messages conventional and in French; code comments in French.
- The caller comes from the socket, never from the request. Every field is validated by hand; an unknown field is refused, as today.
- No agent text in an argv or a shell line: a question, an answer, an instruction and a mission file travel as pushed files (`pushText`). The only typed text is a line forge wrote itself, in the charset of `SUMMARY_ALLOWED` (`cli/lib/api/protocol.ts`).
- A text that holds a secret forge handed out is refused (`checkText`), in `ask`, `answer`, `session`, a report and a mission file.
- Every `incus` and `hc` call of a verb has a timeout (`INCUS_MS`), as in part 1.
- The anti-goals of DX 5 stay (§9): no container reaches another container's socket; nothing here lets an executor write into the control container.

## Review Focus

1. **A second `ask` while the first waits**: refused, with the id of the pending one (Task 1).
2. **An `answer` for a question that is no longer pending** (the executor finished, or was released): nothing is typed in the developer's session, the question session is ended, `delivered: false` (Task 3).
3. **`done --wip` with nothing committed**: accepted, nothing copied to the mirror; with tracked changes not committed: refused as a plain `done` is (Task 2).
4. **Mission files of the previous mission** still in the container when the next one has none: removed at each `assign` and each `release` (Task 4).
5. **A developer session that died before the answer arrives**: the key is cleared, `delivered: false`, no error (Task 3).

---

### Task 1: `ask`

**Files:**
- Modify: `cli/lib/api/missions.ts`, `cli/lib/api/journal.ts` (the comment of `Entry.text`: also a question and a report)
- Test: `tests/api-missions.test.ts`

**Interfaces — Produces:**
- `QUESTION_KEY = "user.forge.question"`: the id of the pending `ask`, in decimal; absent when none;
- executor verb `{"op":"ask","text":<string>}` → `{"ok":true,"id":<n>}`. Refused: no mission held (`<executor> holds no mission: there is nothing to ask about`); a pending question (`question <n> still waits for its answer`); a text empty, over `INSTRUCTION_MAX` bytes or holding a secret (`checkText(text, INSTRUCTION_MAX, "question", secrets)`). Accepted, inside `exclusive()` and the mission lock: the journal line first (op `ask`, `text` the question, `mission` the held mission), whose id is the question's, then the key;
- `status` (control) gives each executor's `question` (the key as a number, `null` when absent or unreadable); `events` also returns the accepted `ask` lines as `AskEvent`s, in the same id order as the `done`s;
- `assign` and `release` clear `QUESTION_KEY`.

- [ ] **Step 1: Write the failing tests**: `ask` from an executor that holds a mission is accepted, its id is the journal line's, `status` shows it as `question`, and `events` returns it with its text; a second `ask` is refused and names the first id (**Review Focus 1**); `ask` without a mission is refused; `ask` from the control socket is refused (`ask is not a verb of the control container`); a question holding the Claude token is refused and the journal line does not hold it; `release` clears the key.
- [ ] **Step 2: Run** `node --test tests/api-missions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: un exécuteur pose une question (ask)`.

### Task 2: `done` with work in progress and a report

**Files:**
- Modify: `cli/lib/api/missions.ts`
- Test: `tests/api-missions.test.ts`

**Interfaces — Produces:** executor verb `{"op":"done","wip":<bool>,"report":<string|null>}`; both fields optional on the wire (absent: `false`, `null`), so a `forge-team` of part 1 still works. A report is checked as a question is (an empty one counts as `null`). With `wip: true`, the refusal "nothing committed beyond the base" does not apply, and the branch is copied to the agents' mirror only when it has a commit beyond its base; a clone with tracked changes not committed is still refused. The journal line keeps `wip` and the report (`text`); `events` returns them in the `DoneEvent`.

- [ ] **Step 1: Write the failing tests**: `done` with `wip: true` and no commit is accepted and runs no fetch into the mirror (**Review Focus 3**); with one commit it copies the branch; with a dirty clone it is refused; a `done` with a report gives an event whose `report` is the text and `wip` is false; `{"op":"done"}` alone still works; an unknown field (`"force":true`) is refused.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: done rend un travail en cours (wip) et un compte rendu`.

### Task 3: `session` and `answer`

**Files:**
- Modify: `cli/lib/hc-session.ts`, `cli/lib/api/missions.ts`
- Test: `tests/hc-session.test.ts`, `tests/api-missions.test.ts`

**Interfaces — Produces:**
- `startSession(ctx, m, task, instruction, opts)` gains `opts.session?: string` (default `SESSION`), `opts.instructionPath?: string` (default `INSTRUCTION_PATH`) and `opts.keepMessages?: boolean`: with a session name of its own, it kills and removes only that terminal, labels its Herdr tab with that name, and leaves `agent` and the messages folder alone. `stopSession` and `typeNotice` gain an optional session name the same way;
- `questionSession(n: number): string` = `question-<n>`; its instruction is pushed to `/home/aiuser/.forge/questions/<n>.md`;
- control verb `session` (`{"op":"session","question":<n>,"instruction":<string>}`): `n` a positive safe integer, the instruction checked as an assign's; it starts `questionSession(n)` in the control container, as `aiuser`, in `/workspace`. Not in `exclusive()`: it changes no mission;
- control verb `answer` (`{"op":"answer","to":…,"question":<n>,"kind":"answer"|"needs-human","text":<string>}`), inside `exclusive()` and the mission lock: `to` an executor of the project; when its `QUESTION_KEY` is `n`: push the text to `/home/aiuser/.forge/messages/answer-<n>.md` (`aiuser`, mode 600), type one line in its `agent` session — `[forge] answer to your question <n>: read /home/aiuser/.forge/messages/answer-<n>.md` for `answer`, `[forge] your question <n> waits for the human: read /home/aiuser/.forge/messages/answer-<n>.md, commit your work, then run forge-team done --wip` for `needs-human` — and clear the key; a session that is not live (`typeNotice` refuses) clears the key too and counts as not delivered. In every case, the question session `question-<n>` of the control container is killed and removed (a failure is ignored). Reply `{"ok":true,"delivered":<bool>}`.

- [ ] **Step 1: Write the failing tests**: `startSession` with `session: "question-7"` runs `hc run --name question-7`, never `hc kill agent`, and pushes its instruction to the path given; `session` from the control socket starts it and from an executor's is refused; `answer` to an executor waiting for question 7 pushes the file, sends the `[forge] answer to your question 7` line, clears the key, kills `question-7` in the control container and replies `delivered: true`; **Review Focus 2**: `answer` with question 8 while the key is 7 types nothing and replies `delivered: false`; **Review Focus 5**: with `hc send` answering "has finished", the reply is `delivered: false` and the key is cleared; the two typed lines pass `SUMMARY_ALLOWED` once their `[forge] ` prefix is removed.
- [ ] **Step 2: Run** `node --test tests/hc-session.test.ts tests/api-missions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'hôte lance une session de question et livre une réponse`.

### Task 4: The mission files in the executor

**Files:**
- Modify: `cli/lib/api/missions.ts`, `cli/lib/commands/team.ts` (the human's `forge team assign` sends no file)
- Test: `tests/api-missions.test.ts`

**Interfaces — Produces:** `assign` reads `mission.files` (an object with exactly `spec`, `answers`, `split`, each `null` or a string of at most 262 144 bytes without a secret); `MISSION_FILES_DIR = "/home/aiuser/.forge/mission"` (the same path as `MISSION_DIR` of plan 2a's `instruction.ts`: a test asserts they are equal). Before the session starts: the folder is emptied (as root), then each file that is not null is pushed as `<name>.md`, owned by root, mode 444, in a folder owned by root, mode 755: the agent reads it and cannot change it. `release` empties the folder. `HELD_FIELDS` leaves `files` out as it does `instruction`: the instance key and the journal never hold a mission file. `forge team assign` builds its mission with the three files `null`.

- [ ] **Step 1: Write the failing tests**: an `assign` with `files.spec` pushes `/home/aiuser/.forge/mission/spec.md` with mode 444 and uid 0, and no `answers.md`; an `assign` with the three `null` empties the folder (**Review Focus 4**); a file of 262 145 bytes is refused; a file holding the Claude token is refused; the instance key after the assign holds no `files`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:unit && npm run test:contract && npm run check`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: chaque mission reçoit une copie en lecture seule de ses fichiers de mission`.

### Task 5: `forge-team` in an executor

**Files:**
- Modify: `container/forge-team`
- Test: `tests/forge-team.test.ts`

**Interfaces — Produces:** `forge-team ask` (the question on stdin; an empty stdin or a terminal is a usage error, exit 64) prints `ok <id>` then `your question is recorded: go on with what does not depend on it; the answer arrives in this terminal`; `forge-team done [--wip] [--report-file <path>]` (a missing or unreadable file is exit 64, before any request). The usage text lists the four forms. Plan 2c adds the verbs of the control container to the same script.

- [ ] **Step 1: Write the failing tests** against a `net` server on a temporary socket (`FORGE_API_SOCKET`): `ask` with `what is the limit?` on stdin sends `{"op":"ask","text":"what is the limit?"}` (stdin as read, its trailing newlines removed); `done --wip --report-file r.md` sends `wip: true` and the file's content; `done` alone sends `{"op":"done","wip":false,"report":null}`; `done --report-file missing.md` exits 64 and sends nothing.
- [ ] **Step 2: Run** `node --test tests/forge-team.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forge-team ask, done --wip et --report-file`.

## Calls made while writing (to check)

- The pending question is an instance key beside the mission's, cleared by `answer`, `assign` and `release`.
- `answer` also ends the question session, so the orchestrator needs no verb to stop one.
- The answer arrives as a file plus one typed line, the way `forge notify` reaches a session; the developer's session is not restarted.
- A mission file's copy is root-owned in the executor: the base stays the only place where it changes (decision 29).
- Between this plan's deployment and the orchestrator's (the same `forge team converge` pushes both), the two sides can disagree on the contract for a few turns: the orchestrator's turns end with an error line and resume by themselves.
