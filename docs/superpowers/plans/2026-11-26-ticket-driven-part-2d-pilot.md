# Ticket-driven forge, part 2d: the Pilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The human opens a ticket with the Pilot from the Mac (`forge pilot <ticket>`), writes its spec with it, approves a split, and the Pilot creates the stack; the developers' instructions and the documentation say how questions work. End state of part 2: the human specifies a ticket with the Pilot and answers questions.

**Architecture:** The control container gets what a Claude session needs to be the Pilot: a workspace, a clone of every repository, a prompt, skills. Its session is the container's `agent` terminal, started by `forge team converge` and by `forge pilot`. `forge pilot <ticket>` is a laptop command that runs a host command with the forwarded SSH agent: refresh the origin mirrors, make sure the Pilot runs, type one line naming the ticket.

**Tech Stack:** TypeScript run by Node 24, the fake `incus` and `hc` of the unit tests; Markdown prompts and skills under `teams/reference/` (in French, as the existing ones).

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§6.8, §6.9, §6.10, decisions 4, 9, 12, 31). Plans 2a, 2b and 2c are done on this branch: the channel's verbs and `forge-team`'s commands in the control container are plan 2c's.

## Global Constraints

- Same branch; commit messages conventional and in French; code comments in French.
- **Only the human writes into the Pilot's session** (decision 31): the only code that types in it is `forge pilot`, the human's gesture, and `forge notify` (the memory watchdog, as in every container). No developer's question, no orchestrator's message reaches it.
- **The human approves the spec and the split** before `create-stack` (decision 4): a rule of the Pilot's prompt and of its `split` skill.
- No credential in the control container beyond today's: the Pilot's clones come from the read-only origin mirrors; nothing leaves them (the control container has no `done`).
- No personal value in the repository (names, hosts, addresses), prompts and skills included.
- No test on the content of a prompt, a skill or the documentation (repository rule); `tests/reference-kit.test.ts` keeps checking that every skill and sub-agent a kit names exists.

## Review Focus

1. **`forge pilot` on a ticket that does not exist**: refused before any mirror is refreshed, with the channel's message (Task 3).
2. **`forge pilot` while the Pilot's session is dead** (after a host restart, or never started): the session is started first, then the line is typed (Task 2, Task 3).
3. **A control container created by part 1** (no workspace, no clone): `forge team converge` adds both without recreating it (Task 1).
4. **`forge team converge` while the Pilot talks with the human**: its session is left alone; a change of its instructions is said, not applied by force (Task 2).

---

### Task 1: The control container can host the Pilot

**Files:**
- Modify: `cli/lib/project-provision.ts`, `teams/reference/roles.json`
- Create: `teams/reference/prompts/control.md`, `teams/reference/skills/split/SKILL.md`
- Rewrite: `teams/reference/skills/design/SKILL.md`, `teams/reference/skills/checkpoint/SKILL.md`
- Delete: `teams/reference/prompts/pilot.md`
- Test: `tests/project-provision.test.ts`, `tests/reference-kit.test.ts`

**Interfaces — Produces:**
- `roles.json`: the kit `pilot` becomes `control`: `{ "skills": ["design", "split", "checkpoint"], "agents": ["scout"], "memory": true }`;
- `agentFiles` gives the control container the prompt `teams/reference/prompts/control.md` and the kit `control`;
- `provisionControl` and `convergeControl` mount `workspacesDir()/agent-control` on `/workspace` when the device is missing, then run what an executor gets for its repositories (`ensureExecutorRepos`, renamed `ensureRepos`: the mirrors mounted read-only, a clone of each repository under `/workspace/<repository>`) and `trustClones`;
- **`control.md`** (French) has two parts, chosen by the first message of the session. *A session whose first message starts with `[forge] question`* is a question session: it follows that message and nothing else of this prompt. *Otherwise it is the Pilot*, the human's only entry point, with these rules: it reads and writes the tickets only through `forge-team` (the commands of plan 2c, listed); a line `[forge] ticket <id>` means the human opens that ticket: `forge-team open <id>`, read it, then the skill `design`; the spec, the human's answers and the split go to the mission files (`write-mission`), never into a repository; nothing goes to development before the human has approved the spec and the split, then the skill `split`; the human may answer a waiting question through it: it shows the request (`forge-team ticket <id>`), and writes the human's answer with `answer-request`, in the human's words; `forge-team problems` when the human asks where things stand; it reads the code in `/workspace/<repository>` (after `git fetch origin`), never commits there; its notes are in `/workspace/notes.md`; between two tickets it runs the skill `checkpoint`; it never writes code and never answers a developer's question itself;
- **`design`** (rewritten): explore with `scout`; ask the human in rounds, each question with a proposed answer; write the answers to `answers` and the spec to `spec` (`forge-team write-mission`); show the human where to read them back (`forge-team mission <id> spec`);
- **`split`** (new): propose the stack, one sub-task per pull request a human reviews in one sitting, each standing on the ones below, in order; write the proposal to `split`; once the human agrees, `forge-team create-stack <id>` with the JSON list; then tell the human the ticket is in development and how to follow it (`forge team status`);
- **`checkpoint`** (rewritten): update `/workspace/notes.md` (the tickets in hand, what waits for the human), then recover a ticket's context from `forge-team ticket <id>` and its mission files rather than from memory.

- [ ] **Step 1: Write the failing tests**: `convergeControl` on a control container without a `workspace` device adds it, clones each repository of the project and installs the kit (**Review Focus 3**); on one that has them, it adds no device and runs no clone; `referenceKit("control")` names `design`, `split`, `checkpoint`, and the test that every named skill and sub-agent exists passes with the new kit; `referenceKit("pilot")` throws.
- [ ] **Step 2: Run** `node --test tests/project-provision.test.ts tests/reference-kit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the code, then write the prompt and the three skills.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le container de contrôle reçoit le Pilote : clones, prompt, skills`.

### Task 2: The Pilot's session

**Files:**
- Create: `cli/lib/pilot.ts`
- Modify: `cli/lib/commands/team.ts` (`converge`)
- Test: `tests/pilot.test.ts`, `tests/team-command.test.ts`

**Interfaces — Consumes:** `sessionState`, `startSession`, `isLive` (`cli/lib/hc-session.ts`), `CONTROL` (`cli/lib/project.ts`). **Produces:**
- `PILOT_INSTRUCTION`, exactly: `[forge] You are the Pilot of this project. Read /workspace/notes.md if it exists, then wait for the human.`;
- `ensurePilot(ctx: Context, opts?: { fresh?: boolean }): Promise<"started" | "running">`: a session that is `idle`, `working`, `done` or `blocked` is left alone, unless `fresh`; otherwise `startSession(ctx, { name: CONTROL }, null, PILOT_INSTRUCTION, { cwd: "/workspace" })`;
- `forge team converge` ends with `ensurePilot`: it prints `Started the Pilot's session in agent-control.` when it started one; when the session runs and the control container's instructions changed, it prints `NOTE: the Pilot's instructions changed; its session keeps the old ones until you run forge pilot <ticket> --fresh.`

- [ ] **Step 1: Write the failing tests**: with no `agent` terminal in the control container, `ensurePilot` runs `hc run` with `forge-agent` and returns `started`; with a `working` session it runs nothing and returns `running` (**Review Focus 4**); with `fresh` it starts one anyway; an `exited` session is replaced (**Review Focus 2**); `forge team converge` prints the note when the instructions changed and the session runs.
- [ ] **Step 2: Run** `node --test tests/pilot.test.ts tests/team-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: la session du Pilote, lancée par converge`.

### Task 3: `forge pilot <ticket>`

**Files:**
- Create: `cli/lib/commands/pilot.ts`
- Modify: `cli/forge.ts` (dispatch, usage, `--host` and `--fresh`), `cli/lib/commands/completion.ts`, `cli/lib/commands/team.ts` (export the refresh of one repository's mirror, today the body of `sync`)
- Test: `tests/pilot.test.ts`

**Interfaces — Produces:**
- on the laptop, `forge pilot <ticket> [--fresh] [--host <name>]`: `remoteAttachForwarding(ctx, host, ["forge", "pilot", <ticket>, …])`, the way `forge team up` reaches the host with the SSH agent;
- on the host, `cmdPilot(ctx, args, opts: { fresh?: boolean })`, in this order: the ticket id has the form of one (`isTicketId`), else usage; the project exists; the ticket exists, asked through the channel as `aiuser` (`forge-team ticket <id>` in the control container, exit code 0), else `ticket <id>: <first line of forge-team's stderr>` (**Review Focus 1**); each repository's origin mirror is refreshed (decision 12), a failure stops with the hint of `forge team sync`; `ensurePilot(ctx, { fresh })`; then `typeNotice(ctx, CONTROL, "[forge] ticket <id>: the human opens it with you")`; it prints `The Pilot is on <id>: talk to it in its terminal (forge open, or its Herdr App machine).`;
- the usage text gains, under "On your laptop": `pilot <ticket> [--fresh] [--host <name>]   Open a ticket with the Pilot: refresh the mirrors, then tell the Pilot (--fresh: in a new session)`.

- [ ] **Step 1: Write the failing tests** with the fake `incus`: `cmdPilot(["T-3"])` refreshes each repository's mirror, then sends exactly the line above to the `agent` session of the control container; with `forge-team ticket` exiting 1 it throws before any `git` call; `cmdPilot(["nope"])` is a usage error; with a dead session, `hc run` comes before `hc send`; from the laptop side, the command sent over SSH is `forge pilot T-3 --fresh` when `--fresh` is given.
- [ ] **Step 2: Run** `node --test tests/pilot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:unit && npm run test:contract && npm run check`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: forge pilot ouvre un ticket avec le Pilote`.

### Task 4: The developers' instructions and the documentation

**Files:**
- Modify: `teams/reference/prompts/executor.md`, `container/CLAUDE.md`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md`

No test (repository rule: none on the content of documentation).

- [ ] **Step 1: `executor.md` and `container/CLAUDE.md`.** Replace "there is no channel to ask a question" by the real flow: the mission files are read-only under `/home/aiuser/.forge/mission/`, to read before the code; a blocking doubt is one precise question, `forge-team ask` (stdin), and the work goes on with what does not depend on it; the answer arrives as a `[forge]` line naming a file; when the line says the question waits for the human: commit, then `forge-team done --wip`; the last report goes into a file given to `forge-team done --report-file` (it is kept in the ticket; the terminal is not). `container/CLAUDE.md` lists `forge-team`'s commands for each of the two containers.
- [ ] **Step 2: `README.md`.** In "Write tickets": a ticket starts `todo`; `forge pilot <ticket>` opens it with the Pilot, which writes `spec.md`, `answers.md` and `split.md` in the ticket's folder and, once you agree, creates the sub-tasks and sets the ticket `dev`. A new part, "Questions": a developer asks, a question session answers from the spec or sends the question to you; a waiting question is a file `requests/<n>.md` without its `requests/<n>.answer.md`; you answer by telling the Pilot, or by writing that answer file yourself; the ticket waits meanwhile and its executor goes to other tickets; `forge team status` lists the orchestrator's problems. Update the threat table's row on the ticket base (the sessions of the control container reach it only through the channel's verbs) and the sentence that says the Pilot and the questions come later.
- [ ] **Step 3: `CLAUDE.md`** (the orchestration paragraph and "Runtime v2"): the Pilot's session, `forge pilot`, the local channel, `ask`, `done --wip`.
- [ ] **Step 4: The spec.** Add decision 34 after decision 33: `**Part 2 ships without the screens** (maintainer, 2026-11-26). The human answers a request through the Pilot, or by writing the answer in the ticket base; the screens' small slice of decision 32 follows part 2, with the colleague who iterates on it.` In §8, item 2, replace the sentence that says part 2 needs the screens' small slice by a reference to decision 34.
- [ ] **Step 5: Run** `npm run test:unit && npm run test:contract && npm run check`, one after the other. Expected: all PASS.
- [ ] **Step 6: Commit** `docs: le Pilote, les questions et la décision 34`.

## What the builder cannot verify (the maintainer's acceptance run)

Say so in the pull request: a real Pilot conversation in Herdr App; a real question answered by a session, and one escalated then answered by hand; the typed lines against a real `hc` (a session whose output is still moving); `forge pilot` over SSH with a hardware key.

## Calls made while writing (to check)

- The Pilot's session is the control container's `agent` terminal, so `forge open` and the Herdr App machine show it as they show an executor's.
- `forge pilot <ticket> --fresh` is how the Pilot's context is cleared between two tickets (decision 9): a new session that recovers the ticket from the base and its notes. Without `--fresh`, the same conversation goes on.
- The Pilot's clones are ordinary clones of the read-only origin mirrors: read-only by rule, and by the absence of any way out.
- The human still creates a ticket by writing its `ticket.md` (as in part 1): the Pilot creates tickets only in part 3, for the non-blocking points of a review.
- The Pilot's own memory (Claude Code's) does not survive the control container's recreation; its notes in `/workspace/notes.md` do.
