# Ticket-driven forge, part 2a: questions, seen from the orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator handles a developer's question from end to end (a question session, its verdict, the request in the ticket base, the answer delivered or the sub-task waiting for the human), gives each mission its mission files and the answers already given, and keeps the agent's final report in the ticket — all testable with a Markdown base in a temporary folder and a fake host.

**Architecture:** The contract of the host API grows in `cli/lib/orchestrator/host.ts` (plan 2b implements it on the host). A new module, `questions.ts`, keeps the questions in flight in one file of the orchestrator's state folder; `tick.ts` gets a "questions" step computed from the picture, as its recovery is. A question waiting for the human is an **open request** in the ticket base (§2.2 of the spec): the connector's contract does not change.

**Tech Stack:** TypeScript run by Node 24, `node:test`. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.3, §2.6, §6.4, §6.5, §6.6). Part 2 is four plans, in this order: 2a (this one), 2b (the host), 2c (the local channel), 2d (the Pilot, the command, the docs). Out of part 2: QA, fixes, rebase, the cascade, `forge ship <ticket>` (part 3); several repositories per ticket (part 4); the screens (decision 34, added by plan 2d).

## Global Constraints

- One branch for the four plans: `agent/ticket-driven-part-2`, from `origin/main`. Commit messages conventional and in French; code comments in French; messages shown to an agent or to the human in English, as in part 1.
- **Self-contained** (`tests/orchestrator-imports.test.ts`): every file under `cli/lib/orchestrator/` and `cli/lib/tickets/`, and `cli/orchestrator.ts`, imports only `node:*` and those two folders.
- The orchestrator reads structured fields only. A question, an answer, a report, a mission file are copied verbatim, never interpreted (decision 24, anti-goal).
- **No state the flow needs** outside the ticket base and the host (§6.4). The file of the questions in flight is a cursor-like convenience: losing it must cost at most a second examination of a question, never a lost question.
- The connector (`cli/lib/tickets/connector.ts`, `model.ts`) is not changed by part 2: a colleague builds on it.
- An instruction stays under 65 536 bytes; a mission file's copy under 262 144 bytes.
- Tests stay lean (repository rule): the cases named in each task, no sweep of edge cases.

## Review Focus

1. **A crash between "request written in the base" and "answer delivered"**: the next turn resumes from the record and delivers; no second request (Task 3).
2. **The file of questions lost while a question is pending**: the question is examined again by a new session; it is never dropped (Task 3).
3. **The human answers before the developer's `done --wip`**: the developer is released at its `done --wip`, then the sub-task is assigned again with the answer; nothing waits forever (Task 4).
4. **A developer that never runs `done --wip`** after an escalation: released after the grace delay, with a problem line (Task 3).
5. **The same `done --wip` event read twice** (cursor lost): the sub-task is not set back to `ready` a second time while another executor works on it (Task 4).

---

### Task 1: The contract grows

**Files:**
- Modify: `cli/lib/orchestrator/host.ts`
- Test: `tests/orchestrator-host.test.ts`

**Interfaces — Produces** (keep the names verbatim; plan 2b implements them):
- `type MissionFiles = { spec: string | null; answers: string | null; split: string | null }`; `MissionSpec` gains `files: MissionFiles`; `type HeldMission = Omit<MissionSpec, "instruction" | "files">`;
- `ExecutorStatus` gains `question: number | null`: the id of the `ask` event this executor waits an answer for;
- `type HostEvent = DoneEvent | AskEvent`, with `type DoneEvent = { id: number; kind: "done"; executor: string; ticket: string; subtask: string; branch: string; wip: boolean; report: string | null }` and `type AskEvent = { id: number; kind: "ask"; executor: string; ticket: string; subtask: string; text: string }`;
- `HostApi` gains `answer(to: string, a: { question: number; kind: "answer" | "needs-human"; text: string }): Promise<{ delivered: boolean }>` and `session(a: { question: number; instruction: string }): Promise<void>`;
- the wire format, added to the comment at the top of the file: `{"op":"answer","to":…,"question":<n>,"kind":…,"text":…}` → `{"ok":true,"delivered":<bool>}`; `{"op":"session","question":<n>,"instruction":…}` → `{"ok":true}`. `answer` on an executor that no longer waits for that question delivers nothing, ends the question session and replies `delivered: false`: it is how the orchestrator ends a session whose question has gone. `session` uses the long timeout of `assign`.

- [ ] **Step 1: Write the failing tests**: a `status` reply whose executor has `"question":7` parses, one without the `question` key is refused; an `events` reply holding one `ask` and one `done` with `wip` and `report` parses into the two types, a `done` without `wip` is refused; `answer` sends exactly the line above and returns `{ delivered: false }` from `{"ok":true,"delivered":false}`; `session` sends its line.
- [ ] **Step 2: Run** `node --test tests/orchestrator-host.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, the parsers (exact keys, as today) and the two client methods.
- [ ] **Step 4: Run** the same, then `npm run check`. Expected: the test file PASSES; `check` shows type errors only in `tick.ts`, `instruction.ts` and `cli/lib/api/missions.ts`, fixed by Task 2, Task 4 and plan 2b. Until then, make them compile with the smallest change (`files: { spec: null, answers: null, split: null }`, `question: null`, `wip: false`, `report: null`).
- [ ] **Step 5: Commit** `feat: le contrat de l'API hôte pour les questions et les fichiers de mission`.

### Task 2: The instructions

**Files:**
- Modify: `cli/lib/orchestrator/instruction.ts`
- Test: `tests/orchestrator-rule.test.ts`

**Interfaces — Consumes:** `Candidate` (`rule.ts`), `Request`, `Mission` (`tickets/model.ts`), `MissionFiles`. **Produces:**
- `MISSION_DIR = "/home/aiuser/.forge/mission"`, `MISSION_FILE_MAX = 262_144`;
- `missionFiles(m: Mission): MissionFiles`: each file as it is, or cut to `MISSION_FILE_MAX` bytes on a character boundary and ended by the line `[cut: this copy is partial]`;
- `devInstruction(c: Candidate, resumed: boolean, extra: { answered: Request[]; files: MissionFiles }): string`: today's text, plus, in this order after `## Sub-task`: `## Mission files` (only when one is not null: one line per file present, `<MISSION_DIR>/spec.md` and so on, under the sentence `Read-only copies of the ticket's mission files. Read them before the code.`); `## Questions already answered` (only when `answered` is not empty: for each request, oldest first, `Question:` and its text, `Answer:` and its answer); and before `## When you are done`, `## If you are blocked` with exactly: `Ask one precise question: forge-team ask (the question on stdin). The answer arrives in this terminal. If forge tells you the question waits for the human: commit your work, then run forge-team done --wip.` The section `## When you are done` becomes: `commit, write what you did, what you checked and what stays doubtful in a file, then run: forge-team done --report-file <that file>`. The cut order when over 65 536 bytes: the description, the answered questions (oldest first), the sub-task text, the title;
- `questionInstruction(q: { question: number; token: string; text: string }, c: { ticket: Ticket; subtask: Subtask }): string`: first line `[forge] question <question> on <sub-task> (ticket <ticket>)`; then the rules, exactly: `You answer one question of a developer, from the ticket's spec and the code, and nothing else. Read the ticket with forge-team ticket <ticket> and its mission files with forge-team mission <ticket> spec (then answers, split). The repositories are under /workspace, to read only. If the spec or the code settles the question, run: forge-team answer <token> (your answer on stdin). If it does not, never guess: run forge-team escalate <token> (what is missing on stdin; --recommended-file <file> for the answer you would give). Run exactly one of the two, once, then stop.`; then `## Question` and the text verbatim; then `## Sub-task` and its text. Cut as above (the sub-task text first, then the question).

- [ ] **Step 1: Write the failing tests**: a dev instruction with one answered request and `files.spec` set holds the `spec.md` path, not the `answers.md` one, and the question and its answer verbatim; with no answered request and no file, neither section appears; the blocked section and the new done line are there; a question instruction starts with the `[forge] question` line, holds the token in both commands, and keeps a question text containing `forge-team answer x; rm -rf /` verbatim; `missionFiles` cuts a 300 000-byte spec under the cap and ends it with the marker.
- [ ] **Step 2: Run** `node --test tests/orchestrator-rule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'instruction d'une mission porte ses fichiers et ses réponses, et celle d'une session de question`.

### Task 3: The questions in flight

**Files:**
- Create: `cli/lib/orchestrator/questions.ts`
- Test: `tests/orchestrator-questions.test.ts`

**Interfaces — Consumes:** `Connector`, `HostApi`, `ExecutorStatus`, `questionInstruction`. **Produces:**
- `type Verdict = { kind: "answer" | "needs-human"; text: string; recommended: string | null }`;
- `type QuestionRecord = { question: number; executor: string; ticket: string; subtask: string; text: string; token: string; startedAt: number; verdict: Verdict | null; request: string | null; deliveredAt: number | null }`;
- `type Questions = { all(): QuestionRecord[]; byToken(token: string): QuestionRecord | null; put(r: QuestionRecord): void; remove(question: number): void }` and `fileQuestions(path: string): Questions`: one JSON file, mode 600, written through a temporary file and a rename at each `put` and `remove`; a missing or unreadable file is an empty list;
- `giveVerdict(qs: Questions, token: string, v: Verdict): void`: sets the verdict of the record with that token; throws `QuestionError("unknown question token")` or `QuestionError("this question is already settled")`. `class QuestionError extends Error {}`;
- constants `QUESTION_TIMEOUT_MS = 15 * 60_000`, `WIP_GRACE_MS = 10 * 60_000`, `MAX_QUESTION_SESSIONS = 2`;
- `stepQuestions(d: { tickets: Connector; host: HostApi; questions: Questions; now: () => number; token?: () => string }, executors: ExecutorStatus[], picture: { ticket: Ticket; subtasks: Subtask[] }[], problems: string[]): Promise<void>`, which does, in this order:
  1. **New questions.** For each executor with a mission and `question = q` and no record for `q`, while fewer than `MAX_QUESTION_SESSIONS` records have no verdict: read the event (`host.events(q - 1)`, the `ask` of id `q`; absent → a problem line, next executor); `put` a record (token: 32 hex characters from `node:crypto`), then `host.session({ question: q, instruction })`. If `session` throws, `remove` the record and add a problem: the next turn starts over.
  2. **Timeouts.** A record without verdict older than `QUESTION_TIMEOUT_MS` gets the verdict `{ kind: "needs-human", text: "The question session gave no answer in 15 minutes.", recommended: null }`.
  3. **Settling**, for each record with a verdict and `deliveredAt === null`, whose executor still shows `question === record.question`: (a) when `request === null`, `openRequest({ ticket, subtask, text, recommended })` — for `needs-human`, the text is the question, a blank line, `From the question session:`, and the verdict's text — then `put` the record with the request's id; (b) for `answer`, `answerRequest` with the verdict's text, where a `ConnectorError` matching `/already answered/` counts as done; (c) `host.answer(executor, { question, kind, text: verdict.text })`; (d) for `answer`, `remove` the record; for `needs-human`, `put` it with `deliveredAt = now()`.
  4. **Waiting for the work in progress.** A `needs-human` record whose request is written, whose executor no longer shows the question but still holds the sub-task, is taken as delivered (a crash after the delivery): `deliveredAt = now()`. Then, for a record with `deliveredAt` set: its executor no longer holds its sub-task → `remove`; it still holds it after `WIP_GRACE_MS` → `host.release(executor)`, the problem line `<ticket>: <sub-task> on <executor>: released without its work in progress, 10 minutes after its question went to the human`, `remove`.
  5. **Gone.** Any other record whose executor no longer shows its question (mission finished or released meanwhile): `host.answer(executor, { question, kind: "needs-human", text: "abandoned" })`, its result and a `HostError` ignored, then `remove`. Nothing is written in the base.
  A `ConnectorError` or `HostError` on one record becomes a problem line (`<ticket>: question <n>: <message>`) and the step goes on with the next record; the record stays for the next turn.

- [ ] **Step 1: Write the failing tests** with an `openMarkdownBase` in a temporary folder, a ticket in `dev` with one `in-dev` sub-task, and a `FakeHost` (as in `tests/orchestrator-tick.test.ts`, extended with `answer` and `session` that record their calls): a pending question opens one session whose instruction holds the question, and no request yet; `giveVerdict` with the wrong token throws, twice with the right one throws the second time; after an `answer` verdict, the step writes one request holding the question and the answer, calls `host.answer` once, and the record is gone; after a `needs-human` verdict, the request is open with `recommended`, and the record is kept with `deliveredAt`; **Review Focus 1**: with `host.answer` throwing once, the second step delivers and the base still has one request; **Review Focus 2**: with an emptied `Questions` and the executor still showing the question, a second session is opened; a record without verdict 16 minutes old becomes an open request; **Review Focus 4**: 11 minutes after `deliveredAt`, the executor still holding, `release` is called once; a record whose executor shows `question: null` and no verdict calls `host.answer` with `abandoned` and writes nothing in the base; with three pending questions, only two sessions are opened.
- [ ] **Step 2: Run** `node --test tests/orchestrator-questions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `questions.ts`.**
- [ ] **Step 4: Run** the same, and `node --test tests/orchestrator-imports.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: les questions en cours de l'orchestrateur`.

### Task 4: The turn

**Files:**
- Modify: `cli/lib/orchestrator/tick.ts`, `cli/lib/orchestrator/rule.ts`, `cli/orchestrator.ts`
- Test: `tests/orchestrator-tick.test.ts`, `tests/orchestrator-rule.test.ts`, `tests/orchestrator-main.test.ts`

**Interfaces — Consumes:** Tasks 1 to 3. **Produces:**
- `candidates(tickets, held, waiting: Set<string>)`: a ticket whose id is in `waiting` gives no candidate;
- `TickDeps` gains `questions: Questions`; the picture gains each ticket's `requests` (`listRequests({ ticket })`, all of them; a `ConnectorError` makes the ticket unreadable, as for its sub-tasks);
- in `tick`:
  - **Events**: an `ask` event is skipped (the questions step works from `status`); a `done` event with a `report` adds `addComment({ ticket, author: <executor>, kind: "note", text: report })` after the links and before the status; a `done` with `wip: true` on a sub-task `in-dev` (or `ready` and held by the emitter) releases the executor when it still holds the sub-task and sets the sub-task `ready`, with no link and nothing in `completed`; on a sub-task that is `ready` and not held by the emitter, or `done`, it is ignored without a problem line (**Review Focus 5**);
  - **Questions**: `stepQuestions`, after the picture and before the recovery, with `report.problems`;
  - **Waiting**: `waiting` is the set of tickets with a request whose `answer` is null. A mission of such a ticket whose session is `exited` or `lost` is released, not relaunched (its sub-task goes back to `ready` by the existing "in-dev held by nobody" branch). Such a ticket is not set `qa`;
  - **Launch**: `launch` reads `readMission({ ticket })` and passes `files: missionFiles(…)` in the mission, and `devInstruction` gets the answered requests of that sub-task; a `ConnectorError` from `readMission` is a problem line and the sub-task is not launched;
- `cli/orchestrator.ts` opens `fileQuestions(join(args.state, "questions.json"))` and passes it; it keeps the problems of the last turn in a variable that plan 2c serves.

- [ ] **Step 1: Write the failing tests**: a ticket with an open request gets no mission while another ticket does; once `answerRequest` is called, the next turn assigns it, and the instruction holds the answer (**Review Focus 3**, in two turns: the request answered while the executor still holds, then the `done --wip` event, then the re-assignment); a `done` with a report leaves one `note` comment by the executor on the ticket; a `wip` done sets the sub-task `ready` and releases; the same `wip` event read again while another executor holds the sub-task changes nothing; a `lost` session on a ticket with an open request is released and not re-assigned; the mission sent to the host carries the base's `spec.md` in `files.spec`.
- [ ] **Step 2: Run** `node --test tests/orchestrator-tick.test.ts tests/orchestrator-rule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:unit`. Expected: PASS, apart from the tests of `cli/lib/api/missions.ts` that plan 2b rewrites (name them in the commit message if any fails).
- [ ] **Step 5: Commit** `feat: le tour de l'orchestrateur traite les questions, le travail en cours et le compte rendu`.

## Calls made while writing (to check)

- A question waiting for the human is an open request, and nothing else: no new sub-task status, no change to the connector. A question the session settled is written as a request answered at once, so the ticket keeps every question and answer.
- Between the developer's `ask` and the session's verdict, the question lives in the host's journal and in `questions.json`; the host's `status` (`question`) is the fact that says it is still pending.
- One question at a time per executor (the host refuses a second one, plan 2b), two question sessions at a time in the control container.
- The delays: 15 minutes for a question session, 10 minutes for the developer to hand its work in progress back. The spec leaves them to the builder.
- The agent's final report becomes a `note` comment on the ticket, by the executor's name (la-fabrique-ai/runtime#191).
