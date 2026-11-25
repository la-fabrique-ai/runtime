# Ticket-driven forge, part 1a: the ticket model, the connector and the Markdown base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ticket vocabulary, the connector's interface with its JSON-lines protocol, and the local Markdown ticket base as the default adapter: a library with its tests, wired to nothing yet.

**Architecture:** `cli/lib/tickets/` holds hand-validated types (`model.ts`), a header codec for the Markdown files (`header.ts`), the `Connector` interface (`connector.ts`), the default adapter `MarkdownBase` (`markdown-base.ts`), and the protocol that lets any executable be an adapter (`protocol.ts`: the server side `serveLine`, the client side `execAdapter`). One conformance suite runs against `MarkdownBase` directly and against `execAdapter` talking to `serveLine(MarkdownBase)`.

**Tech Stack:** TypeScript run by Node 24 (`node --test`), no dependency, `node:fs`. The existing `Context.exec` seam (`cli/lib/context.ts`) runs external adapters.

**Spec:** `docs/superpowers/specs/2026-11-25-ticket-driven-forge-design.md` (read it first; §6.3 is what this plan builds, §6.12 says where the base lives, §8 part 1 is the delivery slice). This is plan 1a of four for part 1 (§8):

- **1a (this plan)**: model, connector, Markdown base.
- **1b**: the orchestrator's rule and events (dev missions only), against this interface and a fake host.
- **1c**: the host side: `project` config, control and executor containers, the two users, the API verbs, the branch records.
- **1d**: the orchestrator as a process in the control container, `forge team up`, the missions' prompts, removal of the old team model.

## Global Constraints

- Branch `agent/ticket-driven-part-1a`, from `origin/main`; commit messages conventional and in French; code comments in French, like the repository.
- No dependency: parse and validate by hand (`cli/lib/api/protocol.ts` is the model).
- Lean tests (repository `CLAUDE.md`): a nominal case, a failure case, and the security guards; no test on documentation.
- The Markdown base is a folder beside the repositories, **never inside a project's repository** (decision 29); this plan never reads a repository.
- The write side never deletes (the console's decision 0005): no operation removes a file.
- The orchestrator reads structured fields only; free text (description, text, comments) is returned verbatim and never interpreted by this code (decision 24).
- A credential reaches an adapter by a file path in the environment variable `FORGE_ADAPTER_CREDENTIAL_FILE`, never in a request (§6.3).
- No personal value (name, login, host, path) in code or tests.

## Review Focus

1. **A path in an id** (`../T-2`, `T-1/../T-2`, an absolute path) must never reach the filesystem: every operation validates its ids first (Tasks 3, 4).
2. **A newline in a header value** (a title `"x\nstatus: done"`) must not forge a field: the codec refuses it, and so does `createTicket` (Tasks 2, 4).
3. **One hand-edited, malformed ticket** must not hide the others: `listTickets` returns the valid ones and names the broken one in `problems` (Task 3).
4. **Two writers at once**: two answers to one request keep the first and refuse the second; two `createSubtask` calls get different ids (Task 4).
5. **A misbehaving adapter**: non-zero exit, a timeout, non-JSON, two lines, a reply that breaks the shape, an error message full of control characters (Task 5).
6. **An oversized file** in the base (hand-edited, over 1 MiB) is refused, not loaded (Task 3).

---

### Task 1: The vocabulary

**Files:**
- Create: `cli/lib/tickets/model.ts`
- Test: `tests/tickets-model.test.ts`

**Interfaces:**
- Produces, all exported from `model.ts`:
  - `class ConnectorError extends Error {}` (the one error a connector throws, message shown to the human);
  - `const TICKET_STATUSES = ["todo", "spec", "dev", "qa", "human-review", "pr-review", "done", "cancelled"] as const`, type `TicketStatus`;
  - `const SUBTASK_STATUSES = ["ready", "in-dev", "done"] as const`, type `SubtaskStatus`;
  - `type SubtaskKind = "implementation" | "fix"`, `type CommentKind = "answer" | "qa-report" | "link" | "note"`, `type MissionFile = "spec" | "answers" | "split"`;
  - `type Repo = { name: string; base: string }` (`base`: a branch, or `stack:<ticket id>`);
  - `type Ticket = { id: string; title: string; description: string; status: TicketStatus; priority: 0 | 1 | 2 | 3 | 4; repositories: Repo[] }` (priority 1 is the most urgent, 4 the least, 0 none);
  - `type Subtask = { id: string; ticket: string; repository: string; position: number; rank: number; status: SubtaskStatus; kind: SubtaskKind; fixes: string | null; reason: "rebase" | null; branch: string | null; pr: string | null; text: string }`;
  - `type Request = { id: string; ticket: string; subtask: string; text: string; recommended: string | null; answer: string | null }`;
  - `type Comment = { id: string; ticket: string; author: string; kind: CommentKind; at: string; text: string }`;
  - `type Mission = { spec: string | null; answers: string | null; split: string | null }`;
  - `type Problem = { id: string; message: string }`;
  - id guards: `isTicketId(s)` (`/^[A-Z][A-Z0-9]*-[1-9][0-9]{0,8}$/`), `isSubtaskId(s)` (a ticket id, a dot, a positive integer), `isSeq(s)` (`/^[1-9][0-9]{0,8}$/`, request ids), `isCommentId(s)` (six digits), `isRepoName(s)` (`/^[A-Za-z0-9._-]+$/`, no leading `-`), `isBranchBase(s)` (a git ref as in `cli/lib/validate.ts` `validateGitRef`, or `stack:` plus a ticket id);
  - parsers `parseTicket`, `parseSubtask`, `parseRequest`, `parseComment`, `parseMission`, `parseProblem`, each `(raw: unknown) => T`, throwing `ConnectorError("<type>: <field> …")` on any wrong or missing field, unknown extra fields ignored.

- [ ] **Step 1: Write the failing tests** in `tests/tickets-model.test.ts`: `isTicketId` accepts `T-1`, `WEB-120` and rejects `t-1`, `T-0`, `T-01`, `../T-1`, `T-1/x`, `T-1 `, `""`; `isSubtaskId` accepts `T-1.2` and rejects `T-1.0`, `T-1.`, `T-1.2.3`; `parseTicket({ id: "T-1", title: "a", description: "", status: "dev", priority: 2, repositories: [{ name: "web", base: "main" }] })` returns it unchanged; `parseTicket` throws `ConnectorError` matching `/status/` for `status: "bogus"`, matching `/priority/` for `5`, matching `/base/` for a base of `--upload-pack=x`; `parseSubtask` throws matching `/id/` for `id: "../x"`.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test tests/tickets-model.test.ts`. Expected: FAIL, cannot find module `model.ts`.
- [ ] **Step 3: Implement `cli/lib/tickets/model.ts`** with the exports above. A shared private helper `field(raw, type, name, check)` keeps the parsers short; `isBranchBase` reuses `validateGitRef`'s charset without importing its throwing form.
- [ ] **Step 4: Run to verify it passes.** Run: `node --test tests/tickets-model.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add cli/lib/tickets/model.ts tests/tickets-model.test.ts
git commit -m "feat: le vocabulaire des tickets et leurs validateurs"
```

### Task 2: The header codec

**Files:**
- Create: `cli/lib/tickets/header.ts`
- Test: `tests/tickets-header.test.ts`

**Interfaces:**
- Consumes: `ConnectorError` (Task 1).
- Produces:
  - `parseDocument(text: string): { fields: Record<string, string>; body: string }`: the fields are the leading `key: value` lines up to the first blank line (key `/^[a-z][a-z-]*$/`, one space after the colon, value to the end of the line, an empty value allowed); the body is everything after that blank line, verbatim. A line that is not `key: value`, or a repeated key, before the blank line throws `ConnectorError`. A document with no blank line is all header, empty body;
  - `formatDocument(fields: Record<string, string>, body: string): string`: the inverse; throws `ConnectorError` when a key breaks the pattern or a value contains `\n` or `\r`. `parseDocument(formatDocument(f, b))` returns `f` and `b` for any valid `f` and any `b`.

- [ ] **Step 1: Write the failing tests** in `tests/tickets-header.test.ts`: a round trip with a body that contains the lines `status: done` and a blank line; an empty value (`branch: `) comes back as `""`; `parseDocument("id: T-1\nid: T-2\n\nx")` throws `/repeated/`; `parseDocument("not a field\n\nx")` throws; `formatDocument({ title: "x\nstatus: done" }, "")` throws `/newline/`; `formatDocument({ "Bad Key": "x" }, "")` throws `/key/`.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test tests/tickets-header.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `header.ts`.** The body begins after the first `\n\n`; `formatDocument` emits the fields, one blank line, the body.
- [ ] **Step 4: Run to verify it passes.** Run: `node --test tests/tickets-header.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le codec d'en-tête des fichiers Markdown de la base de tickets`.

### Task 3: The connector's interface and the Markdown base, read side

**Files:**
- Create: `cli/lib/tickets/connector.ts`, `cli/lib/tickets/markdown-base.ts`
- Test: `tests/tickets-markdown-base.test.ts`

**Interfaces:**
- Consumes: Task 1 types and parsers, Task 2 `parseDocument`.
- Produces, in `connector.ts`, `interface Connector` (every method takes one object and returns a promise):
  - `listTickets(a: { status?: TicketStatus[] }): Promise<{ tickets: Ticket[]; problems: Problem[] }>`, tickets ordered by priority (1 to 4, then 0 last), then by id's number;
  - `getTicket(a: { id: string }): Promise<Ticket>`;
  - `listSubtasks(a: { ticket: string }): Promise<Subtask[]>`, ordered by `rank`;
  - `listRequests(a: { ticket: string; open?: boolean }): Promise<Request[]>` (`open: true`: unanswered only), by id number;
  - `listComments(a: { ticket: string; after?: string }): Promise<{ comments: Comment[]; cursor: string | null }>`: the comments whose id is greater than `after`, oldest first; `cursor` is the last id returned, or `after` (or `null`) when none;
  - `readMission(a: { ticket: string }): Promise<Mission>`;
  - and the write methods of Task 4, declared in the same interface now: `createTicket(a: { title: string; description: string; priority?: 0 | 1 | 2 | 3 | 4; repositories: Repo[] }): Promise<Ticket>`, `setTicketStatus(a: { id: string; status: TicketStatus }): Promise<Ticket>`, `createSubtask(a: { ticket: string; repository: string; position: number; rank: number; kind: SubtaskKind; fixes?: string; text: string }): Promise<Subtask>`, `setSubtaskStatus(a: { id: string; status: SubtaskStatus; reason?: "rebase" }): Promise<Subtask>`, `setSubtaskLinks(a: { id: string; branch?: string; pr?: string }): Promise<Subtask>`, `openRequest(a: { ticket: string; subtask: string; text: string; recommended?: string }): Promise<Request>`, `answerRequest(a: { ticket: string; id: string; text: string }): Promise<Request>`, `addComment(a: { ticket: string; author: string; kind: CommentKind; text: string }): Promise<Comment>`, `writeMission(a: { ticket: string; file: MissionFile; text: string }): Promise<Mission>`.
- Produces, in `markdown-base.ts`: `openMarkdownBase(dir: string, opts?: { prefix?: string; now?: () => Date }): Connector` (`prefix` default `"T"`, `now` default `() => new Date()`); the write methods throw `ConnectorError("not implemented")` until Task 4.
- The layout (my call, the colleague iterates on it): `<dir>/<ticket id>/ticket.md` (header: `id`, `title`, `status`, `priority`, `repositories` as `name:base` pairs separated by `, `; body: the description), `<dir>/<ticket id>/subtasks/<n>.md` (header: `id`, `repository`, `position`, `rank`, `status`, `kind`, `fixes`, `reason`, `branch`, `pr`; body: the text), `<dir>/<ticket id>/requests/<n>.md` (header: `id`, `subtask`, `recommended`; body: the question) with its answer in `requests/<n>.answer.md` (body only), `<dir>/<ticket id>/comments/<six digits>.md` (header: `id`, `author`, `kind`, `at`; body: the text), `<dir>/<ticket id>/{spec,answers,split}.md` (the mission files, bodies only).

- [ ] **Step 1: Write the failing tests** in `tests/tickets-markdown-base.test.ts`, with a helper that writes a base in `mkdtempSync(join(tmpdir(), "tickets-"))` by hand (so the read side is tested against the layout, not against Task 4): `listTickets` returns two tickets ordered priority 1 before priority 3 before priority 0; the `status` filter keeps only `dev`; `getTicket({ id: "../x" })` and `getTicket({ id: "T-1/../T-2" })` reject with `ConnectorError` and `getTicket({ id: "T-9" })` rejects with `/T-9/`; a ticket whose header says `status: bogus` is absent from `tickets` and present in `problems` with its id, while the valid ticket is still listed; a `ticket.md` over 1 MiB is a `problem`, not loaded; `listSubtasks` returns the sub-tasks by `rank`; `listRequests({ open: true })` leaves out the request that has an `.answer.md`; `listComments({ after: "000002" })` returns the third comment and `cursor: "000003"`; `readMission` returns `null` for a missing file.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test tests/tickets-markdown-base.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the interface and the read side.** A private `readDocument(path)` checks the size (1 MiB) before reading and goes through `parseDocument`. The directory is listed with `readdirSync`; entries that do not pass the id guards (editor backup files, `.git`) are ignored without being a problem.
- [ ] **Step 4: Run to verify it passes.** Run: `node --test tests/tickets-markdown-base.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'interface du connecteur et la lecture de la base Markdown`.

### Task 4: The Markdown base, write side

**Files:**
- Modify: `cli/lib/tickets/markdown-base.ts`
- Test: `tests/tickets-markdown-base.test.ts` (add)

**Interfaces:**
- Consumes: Task 3's `Connector` and layout, `formatDocument`.
- Produces: the nine write methods of the interface, with these rules:
  - `createTicket` claims the next number by `mkdirSync(dir/<prefix>-<n>)` (no `recursive`), retrying with the next number on `EEXIST`; initial status `todo`; refuses a title that is empty or holds a newline, and a repository that fails `isRepoName` or `isBranchBase`;
  - `createSubtask` claims `subtasks/<n>.md` with the `wx` flag the same way; initial status `ready`, `reason` and links empty; refuses a `repository` the ticket does not list, and a `fixes` that is not an existing sub-task of the ticket;
  - `openRequest` claims `requests/<n>.md` the same way, the sub-task must exist; `answerRequest` creates `requests/<n>.answer.md` with `wx`: a second answer throws `ConnectorError("request <id> is already answered")` and leaves the first;
  - `addComment` claims `comments/<six digits>.md` the same way and stamps `at` from `now().toISOString()`;
  - `setTicketStatus`, `setSubtaskStatus`, `setSubtaskLinks`, `writeMission` rewrite their file through a temporary file in the same folder and `renameSync`; `setSubtaskStatus` sets `reason` to the given one, or clears it when none is given;
  - no method removes anything; every id is validated before any path is built.

- [ ] **Step 1: Write the failing tests** (added to the same file): create a ticket then `getTicket` returns it with status `todo`; `createTicket({ title: "x\nstatus: done", … })` rejects and creates no folder; ten `createSubtask` calls through `Promise.all` give ten distinct ids `T-1.1` to `T-1.10`; `setSubtaskStatus({ id, status: "ready", reason: "rebase" })` then `setSubtaskStatus({ id, status: "in-dev" })` leaves `reason: null`; `answerRequest` twice keeps the first answer and the second rejects `/already answered/`; `addComment` twice gives `000001` then `000002` and `listComments` with the first cursor returns only the second; `writeMission({ file: "spec" })` then `readMission` returns the text; `createSubtask` with `fixes: "T-1.99"` rejects; `setTicketStatus({ id: "../x", status: "dev" })` rejects and touches no file outside the base.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test tests/tickets-markdown-base.test.ts`. Expected: FAIL on the new tests only.
- [ ] **Step 3: Implement the write methods** with a private `claim(path, content)` (`writeFileSync` with `flag: "wx"`) and `replace(path, content)` (temporary file then rename).
- [ ] **Step 4: Run to verify it passes.** Run: `node --test tests/tickets-markdown-base.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: l'écriture de la base Markdown, sans jamais rien supprimer`.

### Task 5: The protocol and the external adapter

**Files:**
- Create: `cli/lib/tickets/protocol.ts`
- Test: `tests/tickets-protocol.test.ts`

**Interfaces:**
- Consumes: `Connector`, the Task 1 parsers, `Context` and `ExecResult` from `cli/lib/context.ts`.
- Produces:
  - `const OPS: readonly (keyof Connector)[]` (every method of the interface, the only operations either side accepts);
  - `serveLine(connector: Connector, line: string): Promise<string>`: parses `{"op": string, "args": object}`, calls `connector[op](args)` for an `op` in `OPS`, answers one line `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`. An unknown op, a non-object `args` or a bad line gives `ok: false`. A `ConnectorError` passes its message; any other error gives `"internal error"` and nothing else;
  - `execAdapter(ctx: Context, opts: { argv: string[]; credentialFile?: string; timeoutMs?: number }): Connector`: each call runs `argv` once through `ctx.exec(argv, { input: <request line>, env, timeoutMs })` (default 30 000 ms), with `FORGE_ADAPTER_CREDENTIAL_FILE` in `env` when `credentialFile` is given. It accepts exactly one non-empty stdout line with exit code 0, parses it, and validates the result with the parser of that operation (`parseTicket` for `getTicket`, and so on; `listTickets` and `listComments` validate their envelopes). Every failure throws `ConnectorError` starting `adapter <argv[0]>:`, and an `error` message from the adapter is cut to 500 characters with control characters replaced by spaces.

- [ ] **Step 1: Write the failing tests** in `tests/tickets-protocol.test.ts`, with a `ctx` made from `fakeContext()` whose `exec` is replaced by `async (argv, o) => ({ code: 0, stdout: await serveLine(base, o!.input!), stderr: "" })` over an `openMarkdownBase` in a temporary folder: `createTicket` then `getTicket` through `execAdapter` returns the ticket; `serveLine(base, '{"op":"constructor","args":{}}')` and `'{"op":"getTicket","args":[]}'` and `"not json"` all answer `ok: false` and no stack; a `ctx.exec` that returns code 1, one returning `timedOut: true`, one returning `"{}"`, one returning two lines, one returning `{"ok":true,"result":{"id":"T-1","title":"a","description":"","status":"bogus","priority":1,"repositories":[]}}` for `getTicket`, each reject with `/^adapter /`; an adapter error `"bad\u001b[31m" + "x".repeat(900)` comes back under 600 characters with no `\u001b`; with `credentialFile: "/run/cred"` the recorded `env` holds `FORGE_ADAPTER_CREDENTIAL_FILE` and the recorded `input` does not contain `/run/cred`.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test tests/tickets-protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `protocol.ts`.** One table maps each op to its result parser, shared by `OPS` and the client's validation, so a new operation cannot be added to one side only.
- [ ] **Step 4: Run to verify it passes.** Run: `node --test tests/tickets-protocol.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: le protocole JSON des adaptateurs de tickets et l'adaptateur externe`.

### Task 6: One conformance suite for both

**Files:**
- Create: `tests/lib/connector-conformance.ts`
- Modify: `tests/tickets-markdown-base.test.ts`, `tests/tickets-protocol.test.ts`

**Interfaces:**
- Consumes: `Connector`.
- Produces: `conformance(make: () => Connector): void`, which registers `test(...)` cases and which any future adapter's tests can reuse.

- [ ] **Step 1: Write `connector-conformance.ts`** and call it from both test files (`make` = `openMarkdownBase` on a fresh folder; `make` = `execAdapter` over `serveLine` of a fresh base). The cases are the flow the orchestrator will drive, in one test each: create a ticket and two sub-tasks and read them back in order; open a request, answer it, read it back as answered; add two comments and read them past a cursor; write and read the mission files; set a ticket `dev` and a sub-task `in-dev` then back to `ready` with reason `rebase`.
- [ ] **Step 2: Run the whole suite.** Run: `npm run test:unit && npm run test:contract && npm run check`. Expected: all PASS, no type error. (`npm run test:bash` is not run in a team container, repository `CLAUDE.md`.)
- [ ] **Step 3: Commit** `test: une suite de conformité commune aux adaptateurs de tickets`.

---

## Self-review

- **Spec coverage (§6.3, §6.12, §8 part 1, this slice):** the vocabulary and statuses (T1), every operation of the §6.3 table (read and write: T3, T4; the "branch or pull request link" is `setSubtaskLinks`), the JSON-lines executable and the credential by file (T5), the Markdown base in a folder beside the repositories, the mission files, never a deletion (T3, T4), requests with a recommended answer answered once (T4), a base that survives hand edits (T3). Not here, by design: the orchestrator (1b), the config and containers (1c), the process and the removal of the old model (1d), the screens' slice (part 2).
- **Names across tasks:** `Connector`, `ConnectorError`, `openMarkdownBase`, `serveLine`, `execAdapter`, `OPS`, `parseDocument`/`formatDocument` are defined once and used with those names.
- **Proportion:** no step carries a function body; the signatures, the layout and the tests' assertions are what the implementer cannot choose alone.

## Calls made while writing (to check)

- The Markdown base implements `Connector` in-process; the JSON-lines protocol serves adapters of other managers. The spec says an adapter is an executable (§6.3) and the console's engine runs in the orchestrator's process (§6.12): both hold.
- Priority: 1 most urgent, 4 least, 0 none sorts last (the console says "0 to 4" without the direction).
- The file layout of the base, the id schemes (`<prefix>-<n>`, `<ticket>.<n>`) and `setSubtaskLinks` for a sub-task's branch and pull request are mine; the base's author iterates on them (§8).
- `Subtask.position` is the place in the repository's stack and `rank` the place in the ticket's order across stacks; with one repository (part 1) they are equal.
- Status words are forge's own (`todo`, `spec`, `dev`, `qa`, `human-review`, `pr-review`, `done`, `cancelled`); the mapping onto the console's eight common statuses is for the adapters of other managers, so the Markdown base needs none.
