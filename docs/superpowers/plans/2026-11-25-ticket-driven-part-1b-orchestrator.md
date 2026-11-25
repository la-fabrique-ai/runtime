# Ticket-driven forge, part 1b: the orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator as code: the rule of §2.5 for dev missions, the events it reacts to, the recovery after a restart, and the client of the host API it drives — all testable with a Markdown base in a temporary folder and a fake host.

**Architecture:** `cli/lib/orchestrator/` holds the host API's types and its socket client (`host.ts`), the pure rule (`rule.ts`), the mission's first instruction (`instruction.ts`) and one polling turn (`tick.ts`); `cli/orchestrator.ts` is the process's entry. These modules and `cli/lib/tickets/` import nothing else from the repository: part 1d copies them into the control container and runs them there with Node.

**Tech Stack:** TypeScript run by Node 24, `node:net` for the socket, `node:test`. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.3, §2.5, §6.4, §6.5, §6.7). Plan 1a (`cli/lib/tickets/`, the `Connector`) is done on this branch. Part 1 covers dev missions only: no question (`ask`, part 2), no QA, rebase or cascade (part 3), one repository per ticket (part 4).

## Global Constraints

- Same branch as 1a (`agent/ticket-driven-part-1`); commit messages conventional and in French; code comments in French.
- **Self-contained**: every file under `cli/lib/orchestrator/`, `cli/lib/tickets/` and `cli/orchestrator.ts` imports only `node:*` modules and files of those two folders. A test enforces it (Task 1).
- The orchestrator reads structured fields only; the free text of a ticket or a sub-task goes verbatim into the instruction and is never interpreted (decision 24, anti-goal).
- It keeps no state of its own but the event cursor (§6.4): every turn recomputes the picture from the ticket base and the host.
- Branch of a sub-task: `agent/<sub-task id>` (e.g. `agent/T-3.2`). Base of a mission: `origin/<branch>` for the first sub-task of a stack whose ticket base is a branch, `agent/<sub-task id>` of the sub-task just below otherwise.
- One active sub-task per ticket: the lowest `rank` not `done` (§2.3).
- The instruction stays under 64 KiB (the host refuses more): the sub-task text is cut with a marker when needed.

## Review Focus

1. **A crash between "sub-task set in-dev" and "mission assigned"**: the next turn sees an `in-dev` sub-task no executor holds and sets it back to `ready` (Task 4).
2. **The same `done` event read twice** (cursor lost): the second is ignored, nothing is released twice, the sub-task stays `done` (Task 4).
3. **A ticket the host refuses** (unknown repository, `stack:` base): the sub-task goes back to `ready`, the turn goes on with the other tickets, and the problem is reported once per turn, not thrown (Task 4).
4. **A host socket that does not answer**: the client times out and the turn ends with an error line; the next turn retries (Task 2).
5. **A dead mission** (executor holds it, session `exited`, `lost` or `none`): released and re-assigned with the resume line (Task 4).

---

### Task 1: The host API's types, and the self-containment test

**Files:**
- Create: `cli/lib/orchestrator/host.ts` (types only in this task), `tests/orchestrator-imports.test.ts`

**Interfaces — Produces** (the wire contract plan 1c implements on the host; keep the names verbatim):
- `type MissionKind = "dev"`;
- `type MissionSpec = { kind: MissionKind; ticket: string; subtask: string; repository: string; branch: string; base: string; instruction: string }`;
- `type HeldMission = Omit<MissionSpec, "instruction">`;
- `type SessionState = "none" | "idle" | "working" | "done" | "exited" | "lost" | "unknown"`;
- `type ExecutorStatus = { name: string; mission: HeldMission | null; session: SessionState }`;
- `type HostEvent = { id: number; kind: "done"; executor: string; ticket: string; subtask: string; branch: string }`;
- `interface HostApi { status(): Promise<ExecutorStatus[]>; assign(to: string, mission: MissionSpec): Promise<void>; release(to: string): Promise<void>; events(after: number): Promise<HostEvent[]> }`;
- the wire format, one JSON line each way: `{"op":"status"}` → `{"ok":true,"executors":[ExecutorStatus…]}`; `{"op":"assign","to":…,"mission":{MissionSpec}}` → `{"ok":true}`; `{"op":"release","to":…}` → `{"ok":true}`; `{"op":"events","after":<n>}` → `{"ok":true,"events":[HostEvent…]}`; any refusal → `{"ok":false,"error":"…"}`. Write this format as a comment at the top of `host.ts`.

- [ ] **Step 1: Write `tests/orchestrator-imports.test.ts`**: it lists every `.ts` file under `cli/lib/orchestrator/` and `cli/lib/tickets/` plus `cli/orchestrator.ts` (skip the latter while it does not exist), reads each one, and asserts that every `from "…"` and `import("…")` specifier starts with `node:` or `./` and resolves inside those folders (for `cli/orchestrator.ts`: `./lib/orchestrator/` or `./lib/tickets/`).
- [ ] **Step 2: Run** `node --test tests/orchestrator-imports.test.ts`. Expected: PASS on the 1a files (they already comply; if one does not, fix that import in this task).
- [ ] **Step 3: Write the types of `host.ts`.** Run `npm run check`. Expected: clean.
- [ ] **Step 4: Commit** `feat: le contrat de l'API hôte vu de l'orchestrateur`.

### Task 2: The socket client

**Files:**
- Modify: `cli/lib/orchestrator/host.ts`
- Test: `tests/orchestrator-host.test.ts`

**Interfaces — Produces:** `socketHost(path: string, opts?: { timeoutMs?: number }): HostApi` (default timeout 30 000 ms); `class HostError extends Error {}`. One connection per call: write the request line, read one line, close. Validate every reply by hand: `ok` boolean; on `ok: false` throw `HostError(error)`; `executors` and `events` arrays whose items have exactly the fields of the types above with the right primitive types (a `mission` of `null` or an object with the six string fields). Anything else, a closed socket without a line, or the timeout throws `HostError` naming the op.

- [ ] **Step 1: Write the failing tests** with a `net.createServer` on a socket in a temporary folder that answers scripted lines: `status()` returns the parsed executors; `assign` sends exactly `{"op":"assign","to":"agent-executor-1","mission":{…}}` (assert the received line); `{"ok":false,"error":"busy"}` rejects with `HostError` matching `/busy/`; a reply `{"ok":true,"events":[{"id":"1"}]}` rejects; a server that never answers rejects within `timeoutMs: 200`; a missing socket rejects with `HostError`.
- [ ] **Step 2: Run** `node --test tests/orchestrator-host.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `socketHost`.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le client de l'API hôte pour l'orchestrateur`.

### Task 3: The rule and the instruction

**Files:**
- Create: `cli/lib/orchestrator/rule.ts`, `cli/lib/orchestrator/instruction.ts`
- Test: `tests/orchestrator-rule.test.ts`

**Interfaces — Consumes:** `Ticket`, `Subtask` (1a), `ExecutorStatus`, `MissionSpec` (Task 1). **Produces:**
- `activeSubtask(subtasks: Subtask[]): Subtask | null`: the lowest `rank` whose status is not `done`;
- `missionBase(ticket: Ticket, subtasks: Subtask[], s: Subtask): string`: `position === 1` → the ticket's base for `s.repository`, as `origin/<branch>`; a `stack:` base or a missing repository throws `RuleError`; otherwise `agent/<id of the sub-task of the same repository at position - 1>` (missing → `RuleError`);
- `class RuleError extends Error {}`;
- `type Candidate = { ticket: Ticket; subtask: Subtask; base: string }`;
- `candidates(tickets: { ticket: Ticket; subtasks: Subtask[] }[], held: Set<string>): { candidates: Candidate[]; problems: string[] }`: in the given order (priority order, as `listTickets` returns it), one candidate per ticket whose active sub-task is `ready` and whose id is not in `held`; a `RuleError` becomes a problem line `"<ticket>: <message>"`;
- `devInstruction(c: Candidate, resumed: boolean): string`: first line `[forge] mission dev <sub-task> (ticket <ticket>)`, then, when `resumed`, the line `This mission resumes: your branch already holds the earlier work.`, then sections `## Ticket` (title, then description), `## Sub-task` (its text), `## Branch` (`agent/<id>`, based on `<base>`, in `/workspace/<repository>`), `## When you are done` (`commit, then run: forge-team done`). Free text is copied verbatim; if the result exceeds 65 536 bytes, the description, then the sub-task text, are cut and end with `[cut: read the ticket <id> in full]`.

- [ ] **Step 1: Write the failing tests**: `activeSubtask` skips `done` and takes the lowest rank even when the files are listed out of order; `missionBase` gives `origin/main` for position 1 with `repositories: [{ name: "web", base: "main" }]`, `agent/T-1.1` for position 2, and throws for a `stack:T-2` base; `candidates` returns the priority-1 ticket before the priority-3 one, skips a ticket whose active sub-task is `in-dev` or held, and turns a `stack:` base into a problem without dropping the other tickets; `devInstruction` starts with the `[forge] mission dev` line, holds the resume line only when asked, keeps a sub-task text containing `forge-team done; rm -rf /` verbatim, and stays under 65 536 bytes with a 100 000-byte description (ends with the cut marker).
- [ ] **Step 2: Run** `node --test tests/orchestrator-rule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: la règle de l'orchestrateur et l'instruction d'une mission`.

### Task 4: One turn

**Files:**
- Create: `cli/lib/orchestrator/tick.ts`
- Test: `tests/orchestrator-tick.test.ts`

**Interfaces — Consumes:** `Connector` (1a), `HostApi`, the rule. **Produces:**
- `type Cursor = { read(): number; write(id: number): void }`, and `fileCursor(path: string): Cursor` (missing file → 0; written through a temporary file and rename);
- `type TickReport = { completed: string[]; assigned: { subtask: string; executor: string }[]; recovered: string[]; problems: string[] }`;
- `tick(d: { tickets: Connector; host: HostApi; cursor: Cursor }): Promise<TickReport>`, in this order:
  1. **Events**: `host.events(cursor.read())`; for each `done` event: if the sub-task is `in-dev`, set it `done`, set its links (`branch`), release the executor if `status()` still shows it holding that sub-task; when no sub-task of the ticket is left un-`done`, set the ticket `qa`. A sub-task already `done` is skipped. Write the cursor after each event.
  2. **Picture**: `host.status()`; `listTickets({ status: ["dev"] })`; `listSubtasks` of each.
  3. **Recovery**: an executor holding a mission whose session is `exited`, `lost` or `none` → `release`, then `assign` the same mission again with `devInstruction(…, true)` (recorded in `recovered`); an `in-dev` sub-task held by no executor → back to `ready`.
  4. **Distribution**: free executors (mission `null`) in name order, each given the next candidate (Task 3); for each: set the sub-task `in-dev`, then `host.assign`; if `assign` throws, set it back to `ready` and add a problem.
  A `HostError` from the host, or a `ConnectorError` from `events`/`status`/`listTickets`, ends the turn with the error as a problem; it never throws. **One bad ticket never stops the others** (final review of 1a): `listTickets().problems` are copied into the report; a `ConnectorError` from one ticket's `listSubtasks` makes that ticket a problem line and the turn goes on with the others. A ticket is set `qa` only when it has at least one sub-task and all are `done` (an empty or unreadable list never does it).

- [ ] **Step 1: Write the failing tests** with an `openMarkdownBase` in a temporary folder and an in-memory `FakeHost implements HostApi` (executors, an events list, recorded calls): two tickets in `dev` and two free executors → two missions, priority order, both sub-tasks `in-dev`, bases `origin/main`; a `done` event → sub-task `done` with its branch link, executor released, next sub-task assigned in the same turn to a free executor with base `agent/<previous>`; the last sub-task's `done` sets the ticket `qa`; the same event read again (cursor reset to 0) changes nothing and releases nothing; an `in-dev` sub-task held by nobody goes back to `ready` and is re-assigned; a held mission with session `lost` is released and re-assigned with the resume line; `assign` throwing `HostError("unknown repository")` puts the sub-task back to `ready` and reports a problem while the other ticket is still assigned; `events` throwing ends the turn with a problem and no write to the base; one malformed sub-task file in T-2 leaves T-1 assigned and reports one problem line for T-2; a malformed ticket in `dev` (listed in `problems`) is reported, not silently skipped.
- [ ] **Step 2: Run** `node --test tests/orchestrator-tick.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `tick.ts`.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: un tour de l'orchestrateur : événements, reprise, distribution`.

### Task 5: The process

**Files:**
- Create: `cli/orchestrator.ts`
- Test: `tests/orchestrator-main.test.ts`

**Interfaces — Produces:** `cli/orchestrator.ts` runs `node cli/orchestrator.ts --base <dir> --socket <path> --state <dir> [--prefix <p>] [--poll-seconds <n>]` (defaults: prefix `T`, poll 10, minimum 2); it opens the Markdown base, `socketHost`, `fileCursor(<state>/cursor)`, then loops: `tick`, print one line per assignment, completion, recovery and problem (`[orchestrator] …`, never the free text of a ticket), sleep, until SIGTERM or SIGINT, which end the loop after the current turn with exit 0. Missing or bad arguments: usage on stderr, exit 64. Export `parseArgs(argv: string[]): { base: string; socket: string; state: string; prefix: string; pollSeconds: number }` for the test; guard the main loop with `import.meta.main`.

- [ ] **Step 1: Write the failing tests**: `parseArgs` with all options; defaults; `--poll-seconds 1` refused; a missing `--base` refused. Then spawn `node cli/orchestrator.ts` against a temporary base and a `net` server answering `status` with one free executor and `events` with `[]`, send SIGTERM after the first `assign` line arrives at the server, and assert exit code 0 and an `[orchestrator] assigned` line on stdout.
- [ ] **Step 2: Run** `node --test tests/orchestrator-main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm run test:unit && npm run test:contract && npm run check`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: le processus de l'orchestrateur`.

## Calls made while writing (to check)

- A finished stack sets the ticket to `qa`, which nothing picks up until part 3.
- The orchestrator re-reads `status()` before releasing on a `done` event, so a mission re-issued meanwhile is not released by an old event.
- The poll interval is a process argument (default 10 s); the spec leaves it to the builder.
