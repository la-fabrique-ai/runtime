# DX 5, part 3: what makes the team usable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The flow of the spec's §2.2 runs without a ticket manager, and a template can plug in: the human sees the team and its questions (`forge team status --json`, `forge team watch`, a forge mod in Herdr App that notifies on a new question), answers them (`forge answer`), starts from a small reference team shipped in the repository (a Pilot, a Lead, two developers), and gives a role its own `.env`, loaded into its agents' environment (a template's API token, a tool's settings).

**Architecture:** The host's `forge team status --json` becomes the one status API: members with their task, session and what they wait on, the Inbox (the journal's unanswered `ask-human` questions) and the origin mirror's age. `--quick` skips the team-mirror refresh, so the displays can poll it. `forge answer` closes a question in the journal and delivers the answer like a message (a summary typed after forge's prefix, a body as a file), only to a live `forge-agent` session. On the Mac, `forge team watch` redraws that status in a terminal, and a small forge mod for Herdr App (a status bar, docked at the bottom) polls `forge team inbox --json`, notifies a new question, and opens the watch. The reference team is three French role prompts in `teams/reference/` (pilot, lead, dev), chosen with `"prompts": "reference"`. A role's `env` names a dotenv file on the host: `converge` pushes it into each of the role's containers, and `forge-agent` exports its variables to the agent's process only, without ever running the file. This replaces the spec's `tickets` capability: forge knows nothing of ticket managers, and a template puts its token in the `.env` of the roles that need it.

**Tech Stack:** TypeScript on Node 24 (`node --test`), Incus, herdr-core `hc` 0.1.20, Herdr App mods (gpui-kit JavaScript, `herdr.d.ts`: `exec`, `notify`, `run`, `cx.timer`, `nextCommand`).

**Spec:** `docs/superpowers/specs/2026-11-11-dx-5-herdr-core-design.md`, §3 decisions 11 and 12, §5.2 (secrets per role, replacing `tickets`: see "Decisions of the maintainer"), §5.4 ("From the Mac", journal, Inbox), §5.6 (the forge mod), §5.7, §5.9 (reference team), §5.10, §5.11 part 3, §6. Inputs: the part 2 acceptance runs (#158's comments; `waiting-on=human` never clears; a free agent is invisible in Herdr App; two "workspace" spaces per machine; a host saturated by polling and retries, #126, #160). Prerequisite: part 2 merged (it is, 320617b).

## Global Constraints

- Branch `agent/dx5-usable`, from `origin/main`; one pull request, `Refs #92`. Title: `feat: ce qui rend l'équipe utilisable : status, watch, answer, mod Herdr App, équipe de référence, .env par rôle (DX 5, partie 3)`.
- The status API is one JSON object (Task 2's `TeamStatus`), printed by the host's `forge team status --json`. Everything on the Mac (watch, inbox, the mod, `team up`) reads it; nothing else is parsed from the host.
- **Polling budget** (the part 2 run saturated a 3.7 GiB host): a display calls `forge team status --json --quick` (no team-mirror refresh), never two calls at once (single-flight), each with a timeout; `forge team watch` every 5 s at most, the mod every 30 s at most. A failed call shows the error and the time since the last good answer; it never retries faster.
- An answer is a summary (one line, `SUMMARY_MAX` characters, `SUMMARY_ALLOWED`, `checkSummary` of `cli/lib/api/protocol.ts`) plus an optional body (`checkText`, `BODY_MAX`), the same refused secrets as the API's. It is typed only into a live `forge-agent` session (`awaitLiveSession`, `cli/lib/hc-session.ts`): `[forge] answer <question id> from human: <summary>`, then ` (detail: /home/aiuser/.forge/messages/a<question id>.md)` when there is a body. An answer that cannot be delivered is still recorded, and the question closed; the command says so.
- The human's text never goes into a host argv: `forge answer` sends `{"summary":…,"body":…}` on stdin of the host's `forge team answer <id>`, like `forge team assign` sends its instruction.
- Text from agents printed on the Mac (summaries, names, errors) goes through `printableText` (`cli/lib/printable.ts`). Bodies are never printed by the displays: they show the file path.
- `forge install` copies the mod; it never edits `keys.json` (any edit makes that file the person's and stops its default updates). The README gives the lines to add by hand.
- The reference team is opt-in and small: `"prompts": "reference"` for a team, `"prompt": "reference"` for the Pilot; reference roles `lead` and `dev` (plus the Pilot). A role with no reference prompt is refused at `converge` with the list of reference roles. Users compose other roles freely.
- A role's `.env`: `"env": "<path on the host>"` on a role or on `pilot`. The file is parsed, never executed (no `source`, no `eval`, no interpolation), on the host and in `forge-agent`. It lands in the container as `/home/aiuser/.config/forge/env` (uid 1001, mode 600) and only the agent's process gets the variables, never hc's core. forge names no ticket manager, anywhere.
- No runtime dependency. Lean tests (no test of documentation or prompt content). The mod's logic lives in a plain module tested by `node --test`; its view is checked with `herdr-app check` by the maintainer (the dev VM has no Herdr App).
- Docs and plan in English; `container/CLAUDE.md` and the reference prompts in French. Commits: conventional prefix, French message.

## Review Focus

1. **A host that answers slowly or not at all.** `forge team watch` and the mod keep one call in flight (`watchLoop`, `shouldPoll`), show "unreachable since <time>", and do not pile up SSH sessions (Tasks 4 and 5).
2. **An answer to an agent whose session is gone** (released, restarted, a kept shell after a reboot). Nothing is typed; the question is closed in the journal; the command prints that the answer was recorded but not delivered (Task 3).
3. **An answer to a question that does not exist or is already answered.** Refused with the reason, nothing recorded (Task 3).
4. **A `.env` value that looks like shell** (`$(touch x)`, a backtick, `; rm …`). It is exported as literal text and never run, on the host and in the container; a role whose `env` is removed from the config loses the file at the next `converge` (Task 6).
5. **A question summary from an agent shown on the Mac.** It reaches the watch, the bar and the notification only through `printableText`, truncated to the space it has (Tasks 4 and 5).

---

### Task 1: Answers and the Inbox in the journal

**Files:**
- Modify: `cli/lib/api/journal.ts`
- Test: `tests/api-journal.test.ts`

**Interfaces:**
- Consumes: `Op` (`cli/lib/api/protocol.ts`).
- Produces:
  ```ts
  export type JournalOp = Op | "answer";   // "answer" is written by `forge team answer`, never by the API
  export type Entry = { …the existing fields…; op: JournalOp | null; question: number | null };   // question: the ask-human id an answer closes; absent in old lines reads as null
  export type Question = { id: number; from: string; time: string; summary: string; hasBody: boolean };
  export function inbox(entries: readonly Entry[]): Question[];                 // ok ask-human entries with no ok answer whose question is their id, oldest first
  export function findQuestion(entries: readonly Entry[], id: number): Question | "answered" | null;
  ```
  `waitingOn` keeps its signature; an `ask-human` gives `"human"` until an ok `answer` closes that question.

- [ ] **Step 1: Write the failing tests**
  - `inbox`: two questions from lead and dev-1 → both, oldest first; an ok `answer` with `question` = the first's id → only the second; a refused `answer` closes nothing; `hasBody` is true when the question's `text` is non-null.
  - `findQuestion`: an open id → the `Question`; an answered one → `"answered"`; an unknown id, or the id of a `message` → `null`.
  - `waitingOn`: lead asks the human → `"human"`; after an ok `answer` to that question → `null`.
  - a journal line written before this change (no `question` key) reads back with `question: null`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/api-journal.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** the types and the two functions; default `question` to `null` when reading old lines.
- [ ] **Step 4: Run the tests**
  Run: `node --test tests/api-journal.test.ts tests/api-handle.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/api/journal.ts tests/api-journal.test.ts
  git commit -m "feat: les réponses et la boîte des questions dans le journal"
  ```

### Task 2: The status API

**Files:**
- Modify: `cli/lib/commands/team.ts` (`status`, its `Row`), `cli/lib/commands/team-laptop.ts` (`up`, `presentContainers`: read `members`), `cli/lib/mirror.ts` (`originMirrorAge`), `cli/forge.ts` (`--quick`), `cli/lib/commands/completion.ts`
- Test: `tests/team-command.test.ts`, `tests/team-laptop.test.ts`

**Interfaces:**
- Consumes: `inbox`, `waitingOn`, `Journal.open(journalPath())` (Task 1); `busyState`, `sessionState`, `refreshTeamMirror`, `originMirrorPath`.
- Produces:
  ```ts
  export type MemberStatus = {
    name: string; team: string | null; role: string; present: boolean;
    task: string | null;            // the branch, or NO_BRANCH; null when free
    assignedBy: string | null;
    session: SessionState;          // "none" when absent or stopped
    waitingOn: string | null;       // null while the session is working
  };
  export type TeamStatus = {
    members: MemberStatus[];
    inbox: Question[];
    mirrors: { team: string; originAgeSeconds: number | null }[];
  };
  export function originMirrorAge(team: string, now: Date): number | null;   // from the mtime of <origin mirror>/FETCH_HEAD; null when missing
  ```
  `forge team status [--json] [--quick]`: `--quick` skips `refreshTeamMirror`; on the Mac, `forge team status` passes both flags to the host. The text output keeps its table (adding a WAITING column) and adds an `INBOX` section (`#<id> <from> <age>: <summary>`) and one line per team with the origin mirror's age. A missing journal file reads as empty.

- [ ] **Step 1: Write the failing tests**
  - `status --json` with the fake `incus` and a journal holding one open question: the object above, `members` in `members(cfg)` order, `inbox` with that question, one `mirrors` entry per team.
  - `--quick` runs no `git fetch` (the fake records none); without it the refresh runs as today.
  - the laptop's `team up` reads `members[].present` from the new object (the existing G3 test, updated) and, on an older host that prints an array, assumes nothing (`presentContainers` returns `null`).
  - the text output has a `WAITING` column and an `INBOX` line for the question.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-command.test.ts tests/team-laptop.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `MemberStatus`, `TeamStatus`, `originMirrorAge`, `--quick` (parsed like `--json` in `cli/forge.ts:151`, allowed only with `team status`), and the laptop's parsing.
- [ ] **Step 4: Run the tests**
  Run: `npm run check && node --test tests/team-command.test.ts tests/team-laptop.test.ts tests/completion.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/team.ts cli/lib/commands/team-laptop.ts cli/lib/mirror.ts cli/forge.ts cli/lib/commands/completion.ts tests/team-command.test.ts tests/team-laptop.test.ts
  git commit -m "feat: forge team status --json, l'API de statut de l'équipe"
  ```

### Task 3: `forge answer`

**Files:**
- Modify: `cli/lib/commands/team.ts` (host: `forge team answer <id>`), `cli/lib/commands/team-laptop.ts` (Mac: `forge answer <id> "<summary>"`), `cli/lib/hc-session.ts` (`deliverAnswer`), `cli/lib/commands/api.ts` (export the secrets list it builds), `cli/forge.ts`, `cli/lib/side.ts`, `cli/lib/commands/completion.ts`, `container/CLAUDE.md`
- Test: `tests/team-command.test.ts`, `tests/team-laptop.test.ts`, `tests/hc-session.test.ts`

**Interfaces:**
- Consumes: `findQuestion`, `Journal` (Task 1); `checkSummary`, `checkText`, `BODY_MAX` (protocol); `awaitLiveSession`, `MESSAGES_DIR`, `pushText`.
- Produces:
  ```ts
  // cli/lib/commands/api.ts
  export function handedOutSecrets(ctx: Context): string[];   // the Claude token: the texts an answer may not contain
  // cli/lib/hc-session.ts
  export async function deliverAnswer(ctx: Context, container: string, question: number, summary: string, body: string | null): Promise<"delivered" | "no-session">;
  ```
  Host: `forge team answer <id>` reads one JSON object `{"summary": string, "body"?: string}` on stdin. It refuses an unknown or already answered `<id>` (nothing recorded), validates the texts, calls `deliverAnswer` for the question's `from`, then appends `{caller: "human", op: "answer", to: <from>, question: <id>, summary, text: body, outcome: "ok", error: null | "not delivered: <container> has no live session"}`, and prints `Answered #<id> (delivered to <from>).` or `Answered #<id>: <from> has no live session, the answer is recorded but not delivered.` Mac: `forge answer <id> "<summary>" [--host <name>]`, the body read from stdin when it is not a terminal.
  `container/CLAUDE.md`: one sentence: a line `[forge] answer <id> from human: …` is the human's answer to the question `<id>` the agent asked; read the `(detail: …)` file when there is one.

- [ ] **Step 1: Write the failing tests**
  - host, with a fake journal and a live fake session: an open question is answered; the fake `hc send` got `[forge] answer 7 from human: Garde le français`; the journal's last entry is the `answer` above; a second `forge team answer 7` is refused with `/already answered/`; `forge team answer 99` with `/no question 99/`.
  - a body `"x\u001b[201~"` goes to `/home/aiuser/.forge/messages/a7.md` and the typed line ends with `(detail: /home/aiuser/.forge/messages/a7.md)`.
  - a session in state `lost` or `none`: nothing is typed, the entry has `error: "not delivered: agent-web-lead has no live session"`, the exit code is 0 and the output says it.
  - a summary `"voir @x"` and a body holding the Claude token are refused before anything is recorded.
  - Mac: `forge answer 7 "Garde le français"` sends `["forge","team","answer","7"]` with stdin `{"summary":"Garde le français"}`; with a piped body, `body` is set.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-command.test.ts tests/team-laptop.test.ts tests/hc-session.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `handedOutSecrets` (moved out of `cmdApi`), `deliverAnswer` (shares `deliverMessage`'s file and retry code; the file name is `a<question id>.md`), the host and Mac commands, the CLAUDE.md sentence.
- [ ] **Step 4: Run the tests**
  Run: `npm run check && npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/team.ts cli/lib/commands/team-laptop.ts cli/lib/hc-session.ts cli/lib/commands/api.ts cli/forge.ts cli/lib/side.ts cli/lib/commands/completion.ts container/CLAUDE.md tests/
  git commit -m "feat: forge answer, la réponse de l'humain à une question d'agent"
  ```

### Task 4: `forge team watch`

**Files:**
- Create: `cli/lib/laptop/watch.ts`
- Modify: `cli/lib/commands/team-laptop.ts`, `cli/forge.ts`, `cli/lib/commands/completion.ts`
- Test: `tests/watch.test.ts`

**Interfaces:**
- Consumes: `TeamStatus` (Task 2), `remoteExec`, `printableText`.
- Produces:
  ```ts
  export function renderWatch(host: string, status: TeamStatus | null, error: string | null, lastGood: Date | null, now: Date, width: number): string;
  export async function watchLoop(ctx: Context, host: LaptopHost, opts: { intervalMs?: number; timeoutMs?: number; once?: boolean }): Promise<number>;
  ```
  `forge team watch [--host <name>]`: every `intervalMs` (default and minimum 5000), one `forge team status --json --quick` call (timeout 20000), then clear the screen and print `renderWatch`. A new call starts only after the previous one ended. Ctrl-C ends it with code 0. `once` is for tests.
  `renderWatch` shows: per member `name role task session waiting-on`; the Inbox (`#id from age: summary`, newest last); per team `origin mirror: synced <age> ago` (or `never`); on error, the last good view, then `unreachable since <time>: <error>`. Every field from the host goes through `printableText`; a line is cut to `width`.

- [ ] **Step 1: Write the failing tests**
  - `renderWatch` on a status with a working dev, a lead waiting on the human and one question: the lines expected, with ages as `2 min`.
  - a summary or a container name holding `\u001b[2J` is printed escaped (no raw `\u001b`).
  - an error after a good status keeps the members and adds `unreachable since`.
  - `watchLoop` with a fake `remoteExec` that takes longer than the interval: never two calls at once; with `once`, one call and exit code 0.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/watch.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `renderWatch`, `watchLoop` (clear with `\u001b[H\u001b[2J`; `SIGINT` resolves the loop), and the command.
- [ ] **Step 4: Run the tests**
  Run: `npm run check && node --test tests/watch.test.ts tests/team-laptop.test.ts tests/completion.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/laptop/watch.ts cli/lib/commands/team-laptop.ts cli/forge.ts cli/lib/commands/completion.ts tests/watch.test.ts
  git commit -m "feat: forge team watch, la vue de l'équipe dans un terminal"
  ```

### Task 5: The forge mod for Herdr App

**Files:**
- Create: `herdr/mods/forge/main.js`, `herdr/mods/forge/logic.js`, `herdr/mods/forge/mod.json`
- Modify: `cli/lib/commands/team-laptop.ts` (`forge team inbox --json`), `cli/lib/commands/install.ts` (copy the mod), `cli/lib/paths.ts` (`herdrAppModsDir()`)
- Test: `tests/forge-mod.test.ts`, `tests/team-laptop.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Consumes: `TeamStatus` (Task 2), `loadHosts()` (`cli/lib/laptop/state.ts`), `herdrAppSettingsPath()`'s directory.
- Produces:
  ```ts
  // Mac: forge team inbox --json → one line of JSON
  export type InboxReport = { hosts: { host: string; members: { working: number; idle: number; free: number }; questions: Question[]; error: string | null }[] };
  ```
  ```js
  // herdr/mods/forge/logic.js (plain ES module, no gpui import)
  export function newQuestions(seen /* Set<string> of "host#id" */, report) /* → [{ host, question }] */;
  export function barText(report) /* → "forge: 2 working · 1 question" or "forge: <host> unreachable" */;
  export function spaceRenames(spaces /* herdr spaces() */, hosts /* string[] */) /* → [{ id, name }] */;
  export function shouldPoll(inFlight /* boolean */, lastStartMs /* number | null */, nowMs /* number */) /* → boolean: never while one runs, at most every 30000 ms */;
  export function notificationFor(host, question) /* → { title, body }: "Question from <from>", the summary cut to 120 characters, control characters removed */;
  ```
  `forge team inbox --json` asks every installed host with the `setup` step done (`forge team status --json --quick`, timeout 20 s each); an unreachable host gets `error`, never a thrown command.
  The mod (`mod.json`: `{ "place": "bottom", "size": 28 }`): a one-line bar with `barText`; a timer every 5 s that calls `exec("forge", ["team", "inbox", "--json"], { timeout: 25000 })` only when `shouldPoll` says so; for each of `newQuestions` a `notify({ ...notificationFor(host, question), action: { name: "forge.watch", args: { host } } })`; a click on the bar, or the command `forge.watch` (from `nextCommand()`), selects the space named `forge team <host>` or opens it (`space.new` with `argv: ["forge", "team", "watch", "--host", <host>]`); the command `forge.sync` runs `forge team sync <team>` for each team in a new terminal space. It renames once each unnamed space whose id is `<host>-<member>/forge` to `<member>` (`spaceRenames`): the two "workspace" spaces per machine become one named after the agent. Seen question ids are kept in `localStorage`.
  `forge install` (Mac) copies `herdr/mods/forge/` to `<herdr-app dir>/mods/forge/` on every run (the mod is forge's: its files are replaced); it never writes `keys.json`.

- [ ] **Step 1: Write the failing tests**
  - `newQuestions`: a report with questions 3 and 4, `seen` holding `h#3` → only 4; the same report again → none.
  - `barText`: counts summed over hosts; one host in error → names it; a summary is never in the bar.
  - `spaceRenames`: `{ id: "forge-recette-web-dev-1/forge", named: false }` → `{ id, name: "web-dev-1" }`; a named space, or one on "This computer", → nothing.
  - `shouldPoll`: in flight → false; last start 10 s ago → false; 31 s ago → true; never started → true.
  - `notificationFor`: a 200-character summary gives a 120-character body; `"a\u0007b"` gives `"ab"`; the title names the asker.
  - `forge team inbox --json` with two fake hosts, one failing: two entries, the second with `error` and empty counts; exit code 0.
  - `forge install` copies the three files and leaves an existing `keys.json` byte for byte.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/forge-mod.test.ts tests/team-laptop.test.ts tests/install.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `logic.js`, the Mac command, the copy, then `main.js` from the guide's example (`~/.config/herdr-app/AGENTS.md`, "A mod"), using only `exec`, `notify`, `run`, `spaces`, `theme`, `nextCommand`, `cx.timer`. Read `herdr.d.ts` for the exact argument names of `space.new`, `space.select` and `space.rename` (`herdr-app commands` lists them).
- [ ] **Step 4: Run the tests**
  Run: `npm run check && node --test tests/forge-mod.test.ts tests/team-laptop.test.ts tests/install.test.ts`
  Expected: PASS. The maintainer runs `herdr-app check ~/.config/herdr-app/mods/forge` at the acceptance run.
- [ ] **Step 5: Commit**
  ```bash
  git add herdr/ cli/lib/commands/team-laptop.ts cli/lib/commands/install.ts cli/lib/paths.ts tests/forge-mod.test.ts tests/team-laptop.test.ts tests/install.test.ts
  git commit -m "feat: le mod forge de Herdr App, une barre et une notification par question"
  ```

### Task 6: A `.env` per role

**Files:**
- Create: `cli/lib/dotenv.ts`
- Modify: `cli/lib/team-config.ts` (`env` on a role and on `pilot`), `cli/lib/team.ts` (`Member.env`), `cli/lib/team-provision.ts` (`installMemberFiles`), `cli/lib/commands/team.ts` (the Pilot's NOTE), `container/forge-agent`, `container/CLAUDE.md`, `README.md`
- Test: `tests/dotenv.test.ts`, `tests/team-config.test.ts`, `tests/team-provision.test.ts`, `tests/team-command.test.ts`, `tests/test-forge-agent.sh`

**Interfaces:**
- Produces:
  ```ts
  // cli/lib/dotenv.ts
  export const CONTAINER_ENV_PATH = "/home/aiuser/.config/forge/env";
  export function parseDotenv(path: string, text: string): [string, string][];   // throws ForgeError naming the line number, never the value
  // cli/lib/team.ts: Member gains
  env: string | null;   // the role's (or the Pilot's) .env, as an expanded host path
  ```
  The format, the same on the host and in `forge-agent`: blank lines and lines starting with `#` are skipped; otherwise `KEY=VALUE`, with an optional `export ` before `KEY`; `KEY` matches `^[A-Za-z_][A-Za-z0-9_]*$`; `VALUE` is the rest of the line, taken literally, except that one pair of surrounding `'` or `"` is removed. No interpolation, no escapes, no multi-line value. Refused keys: `CLAUDE_CODE_OAUTH_TOKEN`, `HOME`, `PATH`, `USER`, and every key starting with `FORGE_` (forge's own).
  Config: `"env": "<path>"` (absolute or `~/…`) on a role or on `pilot`. At `converge` the file must exist, parse, and not be readable by group or others; otherwise `converge` stops with the path and the reason.
  `installMemberFiles` pushes the file (uid 1001, gid 1001, mode 600) to `CONTAINER_ENV_PATH` when the member has `env`, and removes it otherwise. Its `instructionsChanged` also turns true when the `.env` changed, and the Pilot's NOTE then says "instructions or environment".
  `container/forge-agent`: when `CONTAINER_ENV_PATH` exists, it reads the file line by line with the rules above and exports each pair to the agent's process only (`export "$key=$value"` where claude starts, never in hc's core), before launching claude. It never uses `source` or `eval`. A malformed line stops it with the line number.
  `container/CLAUDE.md`: one generic sentence. Some variables of the session may come from the human (a token, a setting): use them, never copy their values into a message, a commit or a file.
  `README.md`: the `env` key, its format, and that its values reach the agent and every command it runs, in clear.

- [ ] **Step 1: Write the failing tests**
  - `parseDotenv` on `A=1`, `export B="x y"`, `C='$(touch z)'`, `# note` and a blank line → `[["A","1"],["B","x y"],["C","$(touch z)"]]`; `1A=x` is refused with `line 1`; `FORGE_X=1` and `CLAUDE_CODE_OAUTH_TOKEN=x` are refused; the refusal of a line `bad key=top-secret` does not contain `top-secret`.
  - config: `env` on a role and on `pilot` parses; a file of mode 644 and a missing file are refused with their path.
  - converge (fake `incus`): a member with `env` gets `incus file push … /home/aiuser/.config/forge/env` with mode 600; a member without it gets the file removed; a live Pilot whose `.env` changed gets the NOTE.
  - `tests/test-forge-agent.sh`: with an env file holding `X=$(touch <probe>)` and `Y=ok`, the stand-in claude sees `X` as the literal text and `Y=ok`, and `<probe>` is not created; a malformed line makes `forge-agent` exit non-zero with the line number.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/dotenv.test.ts tests/team-config.test.ts tests/team-provision.test.ts tests/team-command.test.ts && bash tests/test-forge-agent.sh`
  Expected: FAIL.
- [ ] **Step 3: Implement** `parseDotenv`, the config key, the push and removal, the NOTE, the reading in `forge-agent`, the CLAUDE.md sentence and the README section.
- [ ] **Step 4: Run the tests**
  Run: `npm run check && npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/dotenv.ts cli/lib/team-config.ts cli/lib/team.ts cli/lib/team-provision.ts cli/lib/commands/team.ts container/forge-agent container/CLAUDE.md README.md tests/
  git commit -m "feat: un .env par rôle, chargé dans l'environnement de l'agent"
  ```

### Task 7: The reference team

**Files:**
- Create: `teams/reference/prompts/pilot.md`, `lead.md`, `dev.md` (French)
- Modify: `cli/lib/team.ts` (`members`: resolve `"reference"`), `cli/lib/team-config.ts` (accept `"reference"`), `README.md` (the example team and the part 3 commands)
- Test: `tests/team.test.ts`

**Interfaces:**
- Produces: `export const REFERENCE_PROMPTS = join(repoRoot(), "teams", "reference", "prompts");`. `members()` gives a team member `prompt = <REFERENCE_PROMPTS>/<role>.md` when the team's `prompts` is `"reference"`, and the Pilot `<REFERENCE_PROMPTS>/pilot.md` when its `prompt` is `"reference"`. `converge` refuses a role with no file there: `no reference prompt for role <role> (reference roles: dev, lead)`.

The reference team is deliberately small: a Pilot, a Lead and two developers, enough to show the flow; users compose other roles. The prompts say what each role should do (spec §5.9) and what the acceptance runs taught. The rules common to all (the API, `forge-team`, who releases) stay in `container/CLAUDE.md` and are not repeated:
- **pilot**: takes the human's requests in its terminal, clarifies them before passing them on, keeps a notes file in its home, gives each request to the Lead of its repository, relays the Lead's questions and the human's answers, reports back, and releases the Lead when it reports.
- **lead**: splits a request into independent sub-tasks (dependent ones run one after the other), gives each a task name and assigns it to a free developer, answers the developers or asks the human (`forge-team ask`) without waiting, reads each branch itself in the team mirror (`git fetch team`), sends fixes back to the branch's owner, releases a developer once its work is read, and reports to the Pilot what is ready to ship.
- **dev**: implements on its branch, runs the project's checks one at a time, commits, and reports to its Lead with the branch and what it checked.

- [ ] **Step 1: Write the failing tests** (no content test)
  - a team with `"prompts": "reference"`, a `lead` and two `dev`: each member's `prompt` is the file under `teams/reference/prompts/`; the Pilot with `"prompt": "reference"` gets `pilot.md`.
  - a role `reviewer` in such a team is refused, with the reference roles listed.
  - every file named by `members()` for the README's example team exists.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** the resolution and write the three prompts. Update the README's example team to a Pilot, a Lead (`repo`, `read-team`, `assign`, `ask-human`) and two developers, with `"prompts": "reference"` and the Pilot's `"prompt": "reference"`. Document `team status`, `team watch`, `answer`, and the mod, with the `keys.json` lines to add by hand for `forge.watch` and `forge.sync`.
- [ ] **Step 4: Run the tests**
  Run: `npm run check && npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add teams/ cli/lib/team.ts cli/lib/team-config.ts README.md tests/team.test.ts
  git commit -m "feat: l'équipe de référence : un Pilote, un Lead, deux développeurs"
  ```

### Task 8: On a real Incus, and the maintainer's runbook

**Files:**
- Modify: `tests/integration/api.test.ts`
- Modify: the pull request's description

- [ ] **Step 1: Integration** (`FORGE_INTEGRATION=1`), with the fake `forge-agent` session of `api.test.ts`:
  - a member asks the human (`forge-team ask`); `forge team status --json --quick` lists the question in `inbox`;
  - `forge team answer <id>` types `[forge] answer <id> from human: …` into the session (`hc read`) and empties the Inbox; a second answer is refused;
  - a member whose role has `env` has `/home/aiuser/.config/forge/env` (mode 600, owner 1001); a member without it has none.
- [ ] **Step 2: Run** `npm run check`, `npm test`, `FORGE_INTEGRATION=1 npm run test:integration`. Expected: PASS, apart from the integration failures already red on `main`, named in the description.
- [ ] **Step 3: Commit**
  ```bash
  git add tests/integration/api.test.ts
  git commit -m "test: la réponse de l'humain et le .env d'un rôle sur un vrai Incus"
  ```
- [ ] **Step 4: The maintainer's runbook**, in the pull request (not run by the agent). A host of 8 GiB or more, or light, doc-only requests on a small one (the part 2 runs saturated a 3.7 GiB host):
  1. `forge install --host <host>`: the mod is in `~/.config/herdr-app/mods/forge/`, `herdr-app check` on it passes, the bar shows at the bottom of Herdr App.
  2. The team switched to the reference team (`"prompts": "reference"`, a Lead and two developers) and the Pilot to `"prompt": "reference"`; a `.env` on the Lead with a harmless variable (`DEMO_GREETING=bonjour`); `forge team up`; the Pilot restarted (the NOTE says how).
  3. `forge team watch` in a Herdr App terminal: members, mirror age; the spaces of the agents are named after them.
  4. A request to the Pilot that leaves a question for the human: the notification arrives, its click opens the watch, `forge answer <id> "…"` reaches the Lead, the Inbox empties; in the Lead's session, `DEMO_GREETING` is set.
  5. `forge fetch`, then `forge ship` of one branch.

## Decisions of the maintainer (2026-11-15)

- `forge install` never edits `keys.json`: the mod exposes `forge.watch` and `forge.sync`, and the README gives the lines to bind them by hand.
- The reference team is opt-in (`"prompts": "reference"`, the Pilot's `"prompt": "reference"`): nothing changes for an existing team or a template. It is small on purpose: a Pilot, a Lead, two developers; no reviewer or QA role in it, the Lead reads the branches itself; users compose other roles.
- **No `tickets` capability** (the spec's §5.2 and §5.10): what a template needs is a generic `.env` per role, loaded into the agent's environment; forge knows nothing of ticket managers, and a template's prompts decide how its agents use their token.
- From the part 2 runs, already in force: the assigner releases as soon as the work is done, a later remark from the human is a new task; `release` stops the session; the containers are the variable part, the host must stay up (#126, handled in #143).

## Choices made while writing

- `forge team status --json` becomes an object (`members`, `inbox`, `mirrors`), with `--quick` for the displays; `team up` reads `members`.
- Polling budgets: watch every 5 s, the mod every 30 s, one call in flight, a timeout on each.
- An answer has the shape of a message (summary typed, body in a file `a<question id>.md`), goes only to a live `forge-agent` session, and is recorded even when it cannot be delivered.
- `forge team inbox --json` on the Mac serves the mod, across every installed host.
- The mod is a one-line bar at the bottom (a mod runs only where it is shown); it also renames the agents' spaces after their member.
- The `.env` format is a strict subset of dotenv (no interpolation, no escapes, no multi-line values), parsed the same way on both sides and never executed; forge's own variables cannot be overridden.
- The `.env` values are not added to the API's refused secrets: a value may be short and harmless (`NODE_ENV=development`), and an exact-match filter on it would refuse ordinary messages. Give a secret only to the roles that need it.
- The origin mirror's age is the age of its `FETCH_HEAD`.
