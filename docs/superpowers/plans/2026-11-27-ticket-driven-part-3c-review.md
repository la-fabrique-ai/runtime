# Ticket-driven forge, part 3c: the human's review with the Pilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket that passed its QA waits for the human's review. The human reads the branches (`forge fetch`, unchanged here), writes the review to the Pilot, and the Pilot turns it into fix sub-tasks, which send the ticket back through development, the cascade and the QA, and into new tickets for what does not block. The human sees where each ticket stands without asking an agent.

**Architecture:** Two verbs join the local channel of the control container: `create-fixes` (a list, like `create-stack`, resumable) and `create-ticket`. They reuse `addFix` of plan 3a, so a fix made from a review and a fix made from a QA report are the same sub-task. `forge team status` gains a `TICKETS` section read through the channel. The Pilot gets a skill, `review`. Nothing here reaches GitHub: shipping is pull request 2.

**Tech Stack:** TypeScript run by Node 24, `node:test`. No dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§2.2, §6.5, §6.8; decisions 7, 10, 31). Third and last plan of pull request 1 (3a, 3b, 3c), on the branch `agent/ticket-driven-part-3-qa`.

## Global Constraints

- The Global Constraints of plan 3a apply.
- **The channel stays narrow** (§6.5, §9): no verb sets a status by name. A status changes only as the effect of a named gesture (`open`, `create-stack`, `create-fixes`).
- **Only the human writes into the Pilot's session** (decision 31): nothing in this plan types a line there. The human learns that a ticket waits for a review from `forge team status`, or by asking the Pilot.
- The channel replies with the message of a `ConnectorError`, a `RuleError` or its own validation; any other error is `internal error`, as today.
- The Pilot's skills are in **English**, its role prompt in **French**. No test on their content.
- The docs of this pull request say what exists after it: `forge ship` still ships a sub-task's branch, as today; shipping a ticket comes with pull request 2.

## Review Focus

1. **`create-fixes` interrupted halfway** (the channel or the Pilot's session dies): run again with the same list, it creates only what is missing, and the ticket goes to `dev` once (Task 1).
2. **`create-fixes` on a ticket that is not in review** (`spec`, `dev`, `qa`, `done`): refused, nothing created (Task 1).
3. **A fix naming a sub-task of another ticket, or one that does not exist**: the whole request is refused before anything is created (Task 1).
4. **A new ticket made from a review** starts `todo`, with its text copied verbatim; it never starts in development by itself (Task 1).
5. **`forge team status` when the orchestrator does not answer**: the table is still printed, the tickets are said unavailable (Task 2).

---

### Task 1: The verbs of the review

**Files:**
- Modify: `cli/lib/orchestrator/channel.ts`, `container/forge-team`
- Test: `tests/orchestrator-channel.test.ts`, `tests/forge-team.test.ts`

**Interfaces — Consumes:** `addFix`, `resolveFixed` (plan 3a, `fixes.ts`). **Produces:**
- `{"op":"create-fixes","id":<ticket>,"fixes":[{"fixes":<sub-task id or null>,"text":…}…]}` → `{"ok":true,"subtasks":[ids…]}`: 1 to 20 items. The ticket must be in `human-review` or `pr-review` (otherwise `<id> is <status>: fixes are created only for a ticket in review`). Every item is checked before any is created: `text` not empty and under the channel's text cap; `fixes` null (a new sub-task on top of the stack) or a sub-task of this ticket (`resolveFixed` not null). Then one `addFix` per item, in order, then the ticket to `dev`. Logged as `create-fixes <id>: <n> sub-tasks, ticket to dev`;
- `{"op":"create-ticket","from":<ticket>,"title":…,"text":…}` → `{"ok":true,"id":<new id>}`: `from` must exist; the new ticket has its repositories, priority 0, status `todo`; `title` is one line, at most 200 bytes. Logged as `create-ticket <new id> from <from>`;
- in the control container, `forge-team create-fixes <id>` (a JSON array of `{fixes, text}` on stdin) and `forge-team create-ticket <from>` (a JSON object `{title, text}` on stdin), in the usage text; each prints the ids created.

- [ ] **Step 1: Write the failing tests**, through the real Markdown base: on a ticket in `human-review` with A and B done, `create-fixes` with one fix of A and one new sub-task creates a fix at A's position and a sub-task on top, sets the ticket `dev` and returns the two ids; the ticket set back to `human-review` by hand and the same request sent again returns the same ids and creates nothing; the request on a ticket in `dev` is refused; a list whose second item names `T-9.1` is refused and no sub-task exists; `create-ticket` gives a `todo` ticket with the repositories of `from` and a text holding `status: dev` kept as text; `forge-team create-fixes T-1` sends the stdin array, and a stdin that is not a JSON array is a usage error.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le Pilote crée les correctifs d'une revue et les tickets non bloquants`.

### Task 2: The human sees the tickets

**Files:**
- Modify: `cli/lib/commands/team.ts`, `cli/lib/orchestrator/channel.ts` (the `tickets` reply), `container/forge-team`
- Test: `tests/team-command.test.ts`, `tests/orchestrator-channel.test.ts`

**Interfaces — Produces:**
- the channel's `tickets` reply gives each ticket one more field, `waiting: number`: its requests without an answer;
- `forge team status` prints, after the table and before `PROBLEMS`, a section `TICKETS`: one line per ticket in `spec`, `dev`, `qa`, `human-review` or `pr-review`, by priority: `<id>  <status>  <title>`, followed by `  (waits for <n> answer(s))` when `waiting` is not 0. No such ticket: no section. Read as the problems are (`forge-team tickets --json` as aiuser in the control container, the same timeout); when it does not answer, the line `tickets: unavailable`. The title is printed without control characters (`printableText`). `--json` gains `tickets` (the list, or `null`); `--quick` skips it, as it skips the problems.

- [ ] **Step 1: Write the failing tests**: with one ticket in `human-review` and one in `dev` with an open request, the status prints the `TICKETS` section with the two lines, the second one saying it waits for 1 answer; with the control container stopped, the table is printed and `tickets: unavailable`; `--json` holds the list.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forge team status montre où en est chaque ticket`.

### Task 3: The Pilot's review skill

**Files:**
- Create: `teams/reference/skills/review/SKILL.md`
- Modify: `teams/reference/roles.json`, `teams/reference/prompts/control.md`
- Test: `tests/reference-kit.test.ts`

What they must say (the wording is the builder's):
- **`skills/review/SKILL.md`** (English). Use when the human gives a review of a ticket in `human-review` or `pr-review`. Read the ticket again (`forge-team ticket <id>`: its sub-tasks, its QA report, the developers' reports) and its mission files; never answer from memory. Sort each point of the review with the human: a **fix** (something a sub-task does wrong: name the sub-task it belongs to), a **new sub-task** (something the ticket lacks and no sub-task owns), or a **non-blocking point** (a new ticket, which does not hold this one). Write each fix so that it stands alone: what is wrong, where, what is expected; the developer gets only that text and the mission files. Show the list to the human and wait for an explicit agreement. Then `forge-team create-fixes <id>` with the list, and `forge-team create-ticket <id>` for each non-blocking point. Tell the human the ticket is back in development and will pass QA again before it comes back. When the human validates the ticket with no change, create nothing: tell them how the stack is shipped. Never: create a fix the human did not agree to, put several unrelated points in one fix, or answer a point by changing the spec without saying so.
- **`control.md`** (French): one paragraph on the review, pointing to the skill; the list of `forge-team` commands gains the two new ones.
- **`roles.json`**: the control's skills gain `review`.

- [ ] **Step 1: Write the failing test**: the kit of the control role lists the skill `review` and its file is read.
- [ ] **Step 2: Run** `node --test tests/reference-kit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write** the three files.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le Pilote sait prendre la revue de l'humain`.

### Task 4: The docs of pull request 1

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `container/CLAUDE.md` (the control container's commands), `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md`

No test (repository rule: no test on documentation).

- [ ] **Step 1: `README.md`**: after « Questions », two short sections. **QA**: when every sub-task of a ticket is done, a free executor tests the top of the stack; a defect becomes a fix on the branch of the sub-task it belongs to, the sub-tasks above are rebased one by one, and the QA runs again; before a QA, a stack whose base moved is rebased first; a clean QA sends the ticket to `human-review`. **Your review**: `forge team status` shows the tickets; `forge fetch` brings the branches; you write the review to the Pilot, which creates the fixes after your agreement; any fix sends the ticket through QA again. Update the sentence « QA and the pull requests come in a later part » and the description of `forge team status`. Say that a ticket lists one repository for now.
- [ ] **Step 2: `CLAUDE.md`** (the Orchestration paragraph and « Runtime v2 »): the three mission kinds, the QA and the cascade in one sentence each, the verbs `stack`, `create-fixes` and `create-ticket`, the `TICKETS` section.
- [ ] **Step 3: The spec.** In §14, under « Calls made while writing », add the calls of this pull request, each in one line: the cascade and the base check are one computation from facts (the host records what each branch stands on, the verb `stack`), not a list the orchestrator keeps; a fix sub-task has the position of the sub-task it fixes and never fixes a fix; a QA mission holds the top sub-task of the stack; the QA report is a verdict and a list of defects, validated by the host; the review's verbs are `create-fixes` and `create-ticket`; part 3 is delivered in two pull requests. In §8, mark part 3's first half as delivered by this pull request. Change nothing else in the spec.
- [ ] **Step 4: Run** `npm test` (all but the `test:bash` cases of #178 on the dev VM) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: la QA, les correctifs, la cascade et la revue avec le Pilote`.
