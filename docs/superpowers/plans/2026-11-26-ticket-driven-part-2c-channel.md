# Ticket-driven forge, part 2c: the local channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sessions of the control container (the Pilot, the question sessions) reach the tickets through the orchestrator, by a few narrow verbs on a local socket: read a ticket, write its mission files, create its stack, answer a request, give a question's verdict. The human sees the orchestrator's problems in `forge team status`.

**Architecture:** `cli/lib/orchestrator/channel.ts` is a small server inside the orchestrator's process, on a Unix socket the orchestrator's user owns and `aiuser`'s group may write. A request is one JSON line, validated by hand, answered by one JSON line, like the host API. `container/forge-team` gets the control container's verbs and speaks to that socket.

**Tech Stack:** TypeScript run by Node 24, `node:net`, `node:test`; `container/forge-team` stays plain JavaScript without dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (§6.2, §6.3, §6.5, §9, decision 31). Plans 2a and 2b are done on this branch: `Questions`, `giveVerdict` and `QuestionError` come from `cli/lib/orchestrator/questions.ts`.

## Global Constraints

- Same branch; commit messages conventional and in French; code comments in French; the channel's messages in English.
- **Self-contained**: `channel.ts` imports only `node:*`, `cli/lib/orchestrator/` and `cli/lib/tickets/`.
- **The orchestrator's user alone holds the ticket base and the API socket** (decision 25). The channel never returns a path, a stack trace or a credential: only a `ConnectorError`'s or a `QuestionError`'s message, anything else is `internal error`.
- A question session's verbs act only on its own question, by its token; the Pilot's verbs take no token (decision 31: a guard against an agent's mistake, not against a hijacked session).
- **Nothing in the channel writes into a session**: no verb types in a terminal or starts one.
- The Pilot's verbs of part 2 are: `tickets`, `ticket`, `mission`, `problems`, `open`, `write-mission`, `create-stack`, `answer-request`, `comment`. `create-subtask` and `create-ticket` (§6.5) come with the review, in part 3.
- A request line is at most 2 097 152 bytes; a mission file at most 1 048 576 bytes (the Markdown base's own limit); any other text at most 65 536 bytes.

## Review Focus

1. **`create-stack` interrupted halfway** (some sub-tasks created, the ticket still `spec`): run again with the same list, it creates the missing ones and sets the ticket `dev`; with another list, it is refused and changes nothing (Task 2).
2. **A question session that uses another question's token, or its own twice**: refused, the first verdict stays (Task 2).
3. **A write on a ticket that is not in `spec`** (`write-mission`, `create-stack`): refused with the ticket's status; a ticket already developed is never re-split (Task 2).
4. **A sub-task of `create-stack` on a repository the ticket does not declare**: refused before anything is created (Task 2).
5. **`aiuser` in the control container** can connect to the channel and cannot read `questions.json` nor connect to the API socket; **an executor has no channel** (Task 4, integration).

---

### Task 1: The server and the read verbs

**Files:**
- Create: `cli/lib/orchestrator/channel.ts`
- Test: `tests/orchestrator-channel.test.ts`

**Interfaces — Produces:**
- `type ChannelDeps = { tickets: Connector; questions: Questions; problems: () => string[]; log: (line: string) => void }`;
- `type ChannelReply = { ok: true; [k: string]: unknown } | { ok: false; error: string }`;
- `handleChannel(d: ChannelDeps, line: string): Promise<ChannelReply>`: parses one request `{"op":…, …}` with exactly the fields of its verb (an unknown verb or field is refused, the name repeated only when it has the form `[a-z][a-z-]{0,30}`), and never throws;
- `serveChannel(d: ChannelDeps, opts: { path: string; group: number | null }, signal: AbortSignal): Promise<void>`: removes a socket left by a crash, listens, `chmod 660`, and `chown` to `group` when it is not null; one request per connection (the first line, the reply, the close), a connection that has not sent its line in 10 s is cut; resolves when the signal aborts, the socket file removed;
- the read verbs: `{"op":"tickets","status":[…]?}` → `{"ok":true,"tickets":[{id,title,status,priority}],"problems":[…]}` (no description: a list stays short); `{"op":"ticket","id":…}` → `{"ok":true,"ticket":…,"subtasks":[…],"requests":[…],"comments":[…]}`; `{"op":"mission","id":…}` → `{"ok":true,"mission":{spec,answers,split}}`; `{"op":"problems"}` → `{"ok":true,"problems":[…]}`, the orchestrator's last turn.

- [ ] **Step 1: Write the failing tests** with an `openMarkdownBase` in a temporary folder: `handleChannel` for `ticket` returns the ticket, its sub-tasks and its requests; for an unknown ticket, `{ ok: false }` with the connector's message; a line that is not JSON, an unknown verb, an extra field are refused; a connector that throws a plain `Error("/var/lib/secret")` gives `internal error`; `serveChannel` on a temporary socket answers one `problems` request with the list given, leaves the socket in mode 660, and removes it on abort.
- [ ] **Step 2: Run** `node --test tests/orchestrator-channel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `node --test tests/orchestrator-imports.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le canal local de l'orchestrateur et ses lectures`.

### Task 2: The write verbs

**Files:**
- Modify: `cli/lib/orchestrator/channel.ts`
- Test: `tests/orchestrator-channel.test.ts`

**Interfaces — Produces** (each accepted write logs one line through `d.log`: the verb, the ticket and a count, never a text):
- `{"op":"open","id":…}`: a `todo` ticket goes to `spec`; a `spec` ticket stays (ok); any other status is refused (`<id> is <status>: only a todo ticket is opened`);
- `{"op":"write-mission","id":…,"file":"spec"|"answers"|"split","text":…}`: the ticket must be `spec`;
- `{"op":"create-stack","id":…,"subtasks":[{"repository":…,"text":…}, …]}`: 1 to 50 sub-tasks, each text not empty; the ticket must be `spec`; every repository must be declared on the ticket. The order of the list is the `rank` (from 1); the `position` is the place among the sub-tasks of the same repository (from 1); the kind is `implementation`. Existing sub-tasks must be a prefix of the list (same repository and same text, in order): the missing ones are created, then the ticket is set `dev`. Reply `{"ok":true,"subtasks":[<ids>]}`;
- `{"op":"answer-request","id":…,"request":…,"text":…}`: `answerRequest` (the connector refuses a request already answered);
- `{"op":"comment","id":…,"text":…}`: `addComment` with the author `pilot` and the kind `note`;
- `{"op":"answer","token":…,"text":…}`: `giveVerdict(…, { kind: "answer", text, recommended: null })`; `{"op":"escalate","token":…,"text":…,"recommended":<string|null>}`: the verdict `needs-human`. A token is 32 hex characters; anything else is refused before the lookup.

- [ ] **Step 1: Write the failing tests**: `open` moves a `todo` ticket to `spec` and refuses a `dev` one; `write-mission` on a `spec` ticket is read back by `mission`, on a `dev` ticket it is refused (**Review Focus 3**); `create-stack` with two sub-tasks on `web` and one on `api` gives ranks 1, 2, 3 and positions 1, 1, 2 (web, api, web), all `ready`, and the ticket `dev`; **Review Focus 1**: with the first sub-task already in the base and the ticket still `spec`, the same list creates the two others, and a list whose first text differs is refused with nothing created; **Review Focus 4**: a repository absent from the ticket is refused with nothing created; `answer` with the token of a record sets its verdict, a second call is refused, a token of another shape is refused (**Review Focus 2**); `answer-request` writes the answer.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: les écritures du canal local : fichiers de mission, pile, réponses, verdict`.

### Task 3: `forge-team` in the control container

**Files:**
- Modify: `container/forge-team`
- Test: `tests/forge-team.test.ts`

**Interfaces — Produces:** when the channel's socket exists (`FORGE_CHANNEL_SOCKET`, default `/run/forge-orch/channel.sock`), `forge-team` offers the control container's commands and only them; otherwise the executor's (plan 2b). A text is read from stdin, never from an argument.

| Command | Request | Prints |
|---|---|---|
| `forge-team tickets [<status>…]` | `tickets` | one line per ticket: id, status, priority, title; then the problems |
| `forge-team ticket <id>` | `ticket` | the ticket (header, description), its sub-tasks (id, repository, position, status, then the text), its requests (id, sub-task, answered or `WAITING`, the text, the recommended answer, the answer), its comments |
| `forge-team mission <id> <spec\|answers\|split>` | `mission` | that file, or `(none)` on stderr and exit 1 |
| `forge-team problems [--json]` | `problems` | one per line, or the JSON array |
| `forge-team open <id>` | `open` | `ok` |
| `forge-team write-mission <id> <spec\|answers\|split>` | `write-mission`, stdin | `ok` |
| `forge-team create-stack <id>` | `create-stack`, stdin: a JSON array of `{repository, text}` | `ok` and the ids |
| `forge-team answer-request <id> <n>` | `answer-request`, stdin | `ok` |
| `forge-team comment <id>` | `comment`, stdin | `ok` |
| `forge-team answer <token>` | `answer`, stdin | `ok` |
| `forge-team escalate <token> [--recommended-file <path>]` | `escalate`, stdin | `ok` |

Exit codes as today: 0, 1 refused (the reason on stderr), 2 socket unreachable, 64 usage. A `create-stack` stdin that is not a JSON array is exit 64, before any request.

- [ ] **Step 1: Write the failing tests** against a `net` server on a temporary socket given by `FORGE_CHANNEL_SOCKET`: `create-stack T-1` with a JSON array on stdin sends `{"op":"create-stack","id":"T-1","subtasks":[…]}`; `escalate <token> --recommended-file r.md` sends the stdin as `text` and the file as `recommended`; `ticket T-1` prints a request without answer with `WAITING`; with the channel's socket present, `forge-team done` is a usage error; with it absent, `forge-team tickets` is.
- [ ] **Step 2: Run** `node --test tests/forge-team.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forge-team parle au canal local dans le container de contrôle`.

### Task 4: The channel in the orchestrator's service, and the problems in `forge team status`

**Files:**
- Modify: `cli/orchestrator.ts`, `cli/lib/project-provision.ts` (`orchestratorUnit`), `cli/lib/commands/team.ts` (`status`)
- Test: `tests/orchestrator-main.test.ts`, `tests/project-provision.test.ts`, `tests/team-command.test.ts`, `tests/integration/` (one file, on the pattern of the existing ones)

**Interfaces — Produces:**
- `cli/orchestrator.ts` takes `--channel <path>` (optional: without it, no channel, as in part 1's tests) and `--channel-group <gid>`; it serves the channel beside its loop, with the problems of its last turn, and stops it on SIGTERM;
- the unit gains `RuntimeDirectory=forge-orch` and `RuntimeDirectoryMode=0755`, and `ExecStart` gains `--channel /run/forge-orch/channel.sock --channel-group 1001` (the service already has `SupplementaryGroups=1001`, which is what lets it give the socket to that group);
- `CHANNEL_SOCKET = "/run/forge-orch/channel.sock"`, exported by `project-provision.ts`;
- `forge team status` (not with `--quick`) asks the control container, as `aiuser`, for `forge-team problems --json`, with a timeout of 8 s, and prints them under the table as `PROBLEMS` (one per line); `--json` gains `problems: string[] | null`. An unreachable control container or channel prints `orchestrator's problems: unavailable` and is not an error.

- [ ] **Step 1: Write the failing tests**: `parseArgs` reads `--channel` and `--channel-group`; the spawned process of the existing test, given `--channel`, answers a `problems` request on it; `orchestratorUnit("T")` holds the `RuntimeDirectory` line and the `--channel` argument; `forge team status` with a fake `incus` whose `forge-team problems --json` prints `["T-2: assign T-2.1 to agent-executor-1: …"]` shows that line under `PROBLEMS`, and with that exec failing shows `unavailable` and exits 0.
- [ ] **Step 2: Run** those test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Write the integration test** (`FORGE_INTEGRATION=1`, **Review Focus 5**): after a converge, in `agent-control`, `aiuser` runs `forge-team tickets` (exit 0); `aiuser` cannot read `/var/lib/forge-orch/state/questions.json` nor connect to `/var/lib/forge/api.sock`; in `agent-executor-1`, `/run/forge-orch/channel.sock` does not exist.
- [ ] **Step 5: Run** `npm run test:unit && npm run test:contract && npm run check`. Expected: all PASS. The integration test runs on the dev VM (`FORGE_INTEGRATION=1 npm run test:integration`); say in the report whether it ran.
- [ ] **Step 6: Commit** `feat: le canal local dans le service de l'orchestrateur, ses problèmes dans forge team status`.

## Calls made while writing (to check)

- The channel lives in the orchestrator's process; a verdict given on it is settled by the next turn (at most the poll interval later), so only the turn writes a question's request.
- The binding of a question session to its question is a token in its instruction (§13 leaves the choice).
- The Pilot's verbs need no token: all sessions share `aiuser` (decision 31).
- `write-mission` does not put the spec's summary in the ticket (§6.5): the connector has no operation for it; left to the Markdown base's next iteration.
- The human's approval before `create-stack` (decision 4) is a rule of the Pilot's prompt (plan 2d): the channel cannot know it.
- The orchestrator's problems reach the human through the channel and `forge team status` (la-fabrique-ai/runtime#191), not through a file read as root.
