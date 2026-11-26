# Ticket-driven forge: a ticket manager drives the team — Design

**Date:** 2026-11-25
**Status:** Model approved by the maintainer on 2026-11-25 ("on part sur ça"),
after a brainstorm and the maintainer's review the same day; the points still open are to
be settled by later fixes. This document is the written form of that model,
which was first drawn as a page in French for the maintainer's colleagues
(not in the repository). Updated the same day after an independent review
and a reading of the console's last version (`la-fabrique-ai/console`,
`a31b23d`), with the maintainer's answers.
**Branch:** `agent/ticket-driven-design`, from `main` (pull request `--base main`)
**Supersedes, in part:** the DX 5 design
(`docs/superpowers/specs/2026-11-11-dx-5-herdr-core-design.md`) and the
reference team design
(`docs/superpowers/specs/2026-11-18-reference-team-skills-design.md`); §7
lists what changes in each.
**Related:** la-fabrique-ai/runtime#186 (restarting sessions after a host
restart), which this design mostly dissolves: the state of the work lives in
the ticket manager.

## 1. Intent

forge's team today (DX 5, then the reference team) is a chain of agents: a
Pilot that talks with the human, one Lead agent per repository that splits a
request and coordinates, developers, and a Reviewer. The state of the work
lives in the agents' notes and in the API journal; the human follows it in
terminals and answers questions in forge's Inbox.

The maintainer's organisation builds three bricks around agent development:

- the **runtime** (this repository);
- a **local ticket manager**, open source. Its first form is the console
  (`la-fabrique-ai/console`), a "mission control" written next to forge;
  that repository is archived and the runtime absorbs its ticket management
  (§6.12). This design's decisions win wherever the console decided
  otherwise;
- a **cloud ticket manager**, proprietary.

**The ticket manager drives the flow.** The state of the work lives in
tickets, no longer in the agents' heads. For forge, a ticket manager is only a
**connector**: a small set of operations on tickets (§6.3).

**Why.**

- **The human follows and answers in a tool made for it**, instead of reading
  terminals.
- **The state survives failures.** In the #179 acceptance run, after a host
  restart, the Pilot believed the work was lost: the state lived in the
  agents' notes. With the statuses in the tickets, resuming means re-reading
  the statuses and restarting the missions (la-fabrique-ai/runtime#186).
- **Cost.** No coordinating agent whose context grows: the distribution of
  work becomes code.

**Success.** On a real host, with the console: the human opens a ticket with
the Pilot; they write the spec together, the Pilot proposes a split into a
stack of sub-tasks and creates it once the human agrees. The orchestrator
hands the sub-tasks one after another to free execution containers, while
other containers work on other tickets. A developer's question gets a fresh
session that answers it from the spec, or reaches the human in the ticket
manager, and the developer's container is freed meanwhile. When the stack is
finished, a QA mission tests its top; a defect becomes a fix in the sub-task
it belongs to, and the sub-tasks above are rebased. The human reviews with the
Pilot, runs `forge ship <ticket>`, which opens the stack as GitHub stacked
pull requests, and merges it on GitHub.

## 2. The model

### 2.1 Words

- **Ticket**: a user story, a bug… The unit of value and of priority. It
  lives in the ticket manager.
- **Sub-task**: a piece of a ticket's implementation: one branch
  `agent/<sub-task>`, one pull request. Its first purpose is a human review of
  a digestible size.
- **Stack**: the sub-tasks of a ticket in one repository, in order. Each
  starts from the branch of the one below; the first starts from the stack's
  base: `main` by default, another branch, or the top of another ticket's
  stack. A ticket that touches several repositories has one stack per
  repository.
- **Control container**: hosts the orchestrator, the Pilot and the question
  sessions. The only container that talks to the ticket manager; inside it,
  only the orchestrator does.
- **Execution container**: generic, with clones of all the repositories of
  the client project. It takes one mission at a time.
- **Mission**: one unit of work for an execution container: **dev**
  (implement a sub-task, or fix one), **rebase** (rebase a sub-task onto the
  branch below), or **QA** (test the top of a ticket's stacks). A fresh Claude
  session per mission.
- **Pilot**: a single Claude session, the human's entry point. It writes the
  spec with the human, splits each ticket into stacks, and takes the human's
  review.
- **Orchestrator**: code, not an agent, under its own Unix user in the
  control container. It distributes missions, and alone holds the ticket
  manager's credential and the forge API socket.
- **Question session**: a fresh Claude session in the control container,
  opened for one question of one developer.
- **Reviewer**: a sub-agent of the developer, which reviews its sub-task
  before it hands it back. No Reviewer container.

### 2.2 The life of a ticket

```
            approved               stack done           OK
  (Pilot) ──> Spec ──────────> Dev ──────────> QA ──────────> Human review
                                ^               │                 │   │
                                │   KO: fixes   │                 │
                                ├───────────────┘                 │
                                │   changes requested             │ forge ship
                                ├─────────────────────────────────┤
                                │                                 v
                                │   peer comments             PR review ──> Done
                                └─────────────────────────────────┘   PRs merged
                                                                      by the human
```

| Status | Who works on it | Leaves when |
|---|---|---|
| Spec | the Pilot, with the human | the human approves the spec and the split; the Pilot creates the stacks → Dev |
| Dev | execution containers, one sub-task after another | every sub-task is Done → QA |
| QA | one execution container on a QA mission, on the top of the stacks | OK → Human review; KO → fixes → Dev |
| Human review | the human: `forge fetch`, and the review written to the Pilot | changes → fixes → Dev; validated → `forge ship` → PR review |
| PR review | peers, on GitHub | comments imported by the human → fixes → Dev; the human merges the stack → Done |
| Done | — | — |

Any fix sends the ticket back to Dev, then through QA and human review again:
the stack has changed. A non-blocking point raised in review becomes a **new
ticket** in the backlog, without holding the current one.

These statuses map onto the console's eight common statuses (§6.12), which
the connectors translate to each external tool: Spec = *In preparation*, Dev
= *In progress*, QA = *In test*, Human review = *To validate*, PR review =
*In review*, Done = *Done*; a ticket not yet opened with the Pilot is *To
do*, a dropped one *Cancelled*. A sub-task is *To do* (Ready), *In progress*
(In dev) or *Done*; "Waiting for human" is not a status there but an open
request on the sub-task.

### 2.3 The life of a sub-task

```
  created by the Pilot     assigned by the        branch done
  or the orchestrator ──> Ready ──────────> In dev ──────────> Done
                           ^ ^  orchestrator   │                 │
                           │ │                 │ question not    │
                           │ │ human answers   │ settled         │
                           │ └── Waiting <─────┘                 │
                           │     for human                       │
                           └─────────────────────────────────────┘
                              the branch below changed: rebase
```

- **Ready** waits for a container. **One active sub-task per ticket**: the
  lowest of its stack that is not Done (across several stacks, in the order
  the Pilot set). For now, parallelism comes from tickets; independent
  sub-tasks of one ticket in parallel come later (§4).
- **Waiting for human**: a question waits for the human in the ticket
  manager; the whole ticket waits with it, and the containers go to other
  tickets. Before its container is freed, the developer has committed and
  published its work in progress; any container resumes the sub-task from the
  team mirror.
- **A fix sub-task** works on the branch of the sub-task it fixes. It has no
  pull request of its own: it updates the fixed sub-task's one.
- **The branch belongs to the ticket**, not to a container.

### 2.4 The stack and the cascade

```
  Before                       main ── A ── B ── C        QA tests C
  After a fix of A             main ── A ── A' ── B' ── C'
                                            fix   rebased, in order: B, then C
```

- The QA tests the top of the stack, which holds the whole ticket: exactly
  what merging the pull requests in order will give. For a ticket on several
  repositories, it tests the tops of all its stacks together (every execution
  container has every clone).
- A fix goes on the branch of the sub-task it fixes. The sub-tasks above go
  back to Ready, reason `rebase`, and a free container rebases them one by
  one, as rebase missions. The QA then runs again on the new top.
- A conflict during a rebase is resolved by the agent as in any sub-task; it
  asks a question if it does not know.
- A defect the QA attributes to no sub-task (transverse) becomes a new
  sub-task on top of the stack.
- A ticket may start from the top of another ticket's stack: the cascade then
  crosses tickets, and a fix in the first rebases the second's stack too.
- **When the base moves** (the human merged another ticket, then a gesture
  refreshed the origin mirror), open stacks are not rebased at once. Before
  each QA, the orchestrator compares a stack's base with the base's current
  tip; if it moved, the stack is rebased bottom-up first, with the same
  rebase missions as the cascade. The QA then tests what merging will really
  give, and a refresh does not cost a rebase of every open stack. If the base
  moves again between the QA and the ship, GitHub shows any conflict, and the
  Pilot creates a rebase.
- The pull requests: A → `main`, B → `agent/A`, C → `agent/B`, linked as a
  GitHub stack, merged bottom-up by the human.

### 2.5 The orchestrator's rule

When an execution container becomes free:

1. a ticket whose stacks are finished and that has no QA running: **QA
   mission** on the highest-priority such ticket (or, if its base moved, the
   rebase missions that come first, §2.4);
2. otherwise, a ticket in Dev whose active sub-task is Ready, by priority:
   **dev or rebase mission** on it;
3. otherwise the container stays free.

Finish before starting: the QA of a ready ticket goes before any new
sub-task. There is no limit of tickets in Dev: the orchestrator works through
the queue. The inbound bottleneck stays the human's spec work; if a limit is
needed, the ticket manager sets it.

The events it reacts to:

- **A container is free**: the rule above.
- **A sub-task is done**: the next one of the ticket becomes active; with none
  left, the ticket waits for its QA.
- **A question arrives** (through the forge API): it opens a question session
  (§2.6).
- **A QA report arrives**: OK, the ticket goes to Human review. KO: the report
  files each defect under a sub-task or as transverse; the orchestrator
  creates one fix sub-task per defect, and the ticket goes back to Dev.
- **The human answered a question** (seen by polling the manager): the
  sub-task goes back to Ready, the answer attached to its next mission.

### 2.6 A developer's question

1. The developer asks through the forge API (`forge-team ask`, §6.5).
2. The API passes it to the orchestrator, which opens a fresh question session
   in the control container, with the ticket's context: spec, sub-task,
   earlier questions and answers, read access to the code.
3. **If the spec settles it**: the session gives the answer; the orchestrator
   writes the question and the answer in the ticket manager and delivers the
   answer to the developer, who goes on.
4. **Otherwise**: the session says it needs the human; the orchestrator writes
   the question in the ticket manager and sets the sub-task to Waiting for
   human; the developer commits, publishes, and is released. When the human
   answers, the orchestrator sets the sub-task back to Ready, and a free
   container takes the branch back with the answer.

A fresh session per question: its context never grows. In return, everything
that matters must be written in the ticket.

## 3. Decisions made by the maintainer

Numbered as on the model page, so the team can refer to them by number.

**The ticket and its stacks**

1. **One pull request per sub-task** (DX 5 decision 7 stays).
2. **One stack per ticket and per repository**; the QA tests the top of the
   stack, or the tops of all the stacks of a multi-repository ticket
   together.
3. **Base branch**: `main` by default, another branch, or the top of another
   ticket's stack; the cascade then crosses tickets.
4. **The human approves the spec and the split** before the ticket goes to
   Dev.
5. **A fix goes in its sub-task**; the sub-tasks above are rebased in cascade.
6. **The QA attributes each defect** to a sub-task, or as transverse.
7. **Any fix sends the ticket back** through QA, then human review.
8. **The words are adopted**: ticket, sub-task.

**The Pilot**

9. **A single Pilot, the human's entry point.** Between two tickets, it clears
   or compacts its context and recovers it from the ticket manager, as after a
   restart. (The maintainer rejected one Pilot session per ticket: one entry
   point for the human.)
10. **In supervised mode, the human writes the review to the Pilot.**
11. **Peer comments on pull requests come in at the human's gesture**: a
    forge command on the Mac reads them with the human's GitHub access and
    hands them to the Pilot.
12. **The origin mirror is refreshed at the human's gestures** (DX 5 decision
    8), including the launch of the Pilot on a ticket, which becomes a forge
    command on the Mac.

**The orchestrator and the containers**

13. **The orchestrator is code**; each question of a developer opens a fresh
    session.
14. **It polls the ticket manager** at a regular interval.
15. **No limit of tickets in Dev**: the orchestrator works through the queue.
    The inbound bottleneck stays the human's spec work; if a limit is needed,
    the ticket manager sets it.
16. **The branch belongs to the ticket**: any container resumes a sub-task
    from the team mirror.
17. **The developer commits and publishes its work in progress** before being
    released.
18. **The cascade's rebase is a mission** like any other.
19. **One VM per client project, one group of execution containers for all
    its repositories.** Each container has every clone, which also serves the
    multi-repository QA.
20. **The reviewer is only a sub-agent of the developer**; no Reviewer
    container.

**The ticket manager**

21. **The local ticket manager is mandatory**: the console, open source,
    merged into the runtime as the default. forge has only one way to run a
    team.
22. **Only the control container talks to the ticket manager.**
23. **forge defines the connector's interface**; each ticket manager supplies
    its adapter, which runs in the control container.
24. **The ticket source is trusted**; it is the connector's job to ensure who
    may write in it.

**Credentials and GitHub**

25. **The orchestrator alone holds the ticket manager's credential and the
    API socket**, under its own Unix user; the sessions go through it. A
    change of the security architecture, validated by the maintainer on
    2026-11-25.
26. *Withdrawn by decision 33* (the orchestrator held the GitHub credential
    in autonomous mode).
27. **`forge ship <ticket>` opens or updates all the stacks of the ticket**,
    in order. After a cascade, it force-pushes with `--force-with-lease`, on
    the ticket's branches only.
28. **A stack is merged through GitHub's stacked pull requests, and the human
    always merges**.

**Later**: independent sub-tasks of one ticket developed in parallel, on the
Pilot's decision. Building the final stack then gets harder; for now, one
active sub-task per ticket.

Settled after the review and the reading of the console's last version:

29. **The console's repository is archived; the runtime absorbs its ticket
    management**, notably its Markdown work (§6.12): the structure, then
    iterations. The Markdown ticket base is unfinished; its author goes on
    with it. The Linear connector is not taken: if needed, it becomes a
    repository of its own. **The Markdown never goes into a project's
    repository**: one source of truth, which branches would split. It lives
    in a folder beside the repositories, which can be made a git repository
    of its own. Where the console decided
    otherwise about the runtime (a Lead agent, a mission branch with one main
    pull request, an independent reviewer container, an engine and a Pilot on
    the Mac), this design's decisions win: stacked pull requests into the base
    (decisions 1 and 28), the orchestrator as code (13), the reviewer
    sub-agent (20).
30. **A clean break on `main`.** The new model replaces the team model in
    place; nothing keeps both alive. The maintainer's own work does not depend
    on `main` meanwhile: a tag marks the last version before DX 5 (one agent
    per container, Superpowers), to develop forge itself, and the maintainer's LAN host
    stays on the old system for its project.
31. **The Pilot and the question sessions share `aiuser`.** A question
    session's binding to its question guards against an agent's mistake, not
    against a hijacked session; accepted. What must hold: **no question
    reaches the Pilot's conversation with the human**. Only the human, and
    the human's own gestures, write into the Pilot's session.
32. **The human's interface to the tickets starts as small as it can be, and
    a colleague of the maintainer iterates on it once the runtime engine and
    the connector API are defined.** Preparing a ticket is the conversation
    with the Pilot in its terminal (§6.8), not the console's question and
    spec pages. The screens keep to what that conversation does not give: the
    list of tickets with their statuses, a ticket's page (sub-tasks, QA
    report) and the answer to a request. They are the console's screens
    taken as a base and adapted (§6.12), not rewritten.
33. **No autonomous mode.** forge runs supervised only: the human ships with
    `forge ship` and merges on GitHub. Decision 26 is withdrawn, §6.13 says
    what stays, and the delivery has four parts (§8).
34. **Part 2 ships without the screens** (maintainer, 2026-11-26). The human
    answers a request through the Pilot, or by writing the answer in the
    ticket base; the screens' small slice of decision 32 follows part 2, with
    the colleague who iterates on it.

## 4. Goals, non-goals, anti-goals

### Goals

- The flow of §2, supervised mode, with the console as the ticket manager.
- The connector: forge's interface, and the local Markdown ticket base as
  the default adapter, in iterations.
- The control container: the orchestrator under its own user, the Pilot, the
  question sessions.
- Generic execution containers, one mission at a time, every clone.
- Stacks per ticket and per repository, the cascade, rebase and QA missions.
- `forge fetch` and `forge ship` by ticket, the stack opened as GitHub stacked
  pull requests, the force-push with lease limited to the ticket's branches.
- The import of peer comments into the Pilot, at the human's gesture.
- A restart that resumes from facts: the orchestrator recomputes everything
  from the ticket manager and the host.

### Non-goals (for now)

- Independent sub-tasks of one ticket in parallel.
- A limit of tickets in Dev inside forge.
- The cloud ticket manager's adapter: it lives outside this repository.
- An origin mirror refreshed without the human; peer comments read without
  the human, in supervised mode.
- Several humans per VM (la-fabrique-ai/runtime#135).
- The autonomous mode (decision 33): forge runs supervised only, and GitHub
  is reached only at the human's gestures.
- Keeping the current team model (Lead agent, Reviewer container, Inbox,
  `forge answer`, `forge team watch`) alongside the new one.

### Anti-goals (would make this a failure even if it works)

- A Claude session (Pilot, question, mission) that can read the ticket
  manager's credential, the GitHub credential, or the forge API socket of the
  control container.
- The orchestrator acting on free text from a ticket or an agent: it reads
  structured fields only.
- A force-push outside the ticket's branches, or without lease.
- forge depending on the cloud ticket manager, or on any manager beyond the
  connector's interface.
- State that exists only in an agent's context: what the flow needs is in the
  ticket manager or on the host.

## 5. Approaches

**Who coordinates** (decided: code).

- **A Lead agent per repository** (today). It splits, assigns, answers
  questions. Its context grows with the request; after a host restart it
  rebuilds the state from its notes, wrongly in the #179 run.
- **Code, the orchestrator** (chosen). The split moves to the Pilot, with the
  human; the distribution of missions is a fixed rule (§2.5); judgement
  (answering a question) goes to fresh sessions. The state lives in the ticket
  manager, so a restart re-reads it.
- An agent driving tools: same cost and drift as the Lead, for no gain the
  rule does not give.

**The Pilot** (decided: one).

- One Pilot session per ticket, resumed for review (proposed): each ticket
  keeps its whole conversation. Rejected by the maintainer: the human would
  juggle several sessions.
- **A single Pilot** (chosen), which clears or compacts its context between
  tickets and re-reads the ticket when it comes back to it. Heavy spec work
  can go to a sub-agent (§6.8), the conversation stays with the Pilot.

**Who calls whom** (decided: forge calls the manager).

- The manager drives forge through an API on the Mac or the host (the DX 5
  template model): the manager would hold forge's verbs. This is what the
  console did until its last version: its engine, on the Mac, handed each
  ticket to forge's Lead over SSH.
- **forge calls the manager** (chosen): the orchestrator polls it through an
  adapter in the control container. The manager needs no access to the host,
  and the only credential is in one place.

**Where a fix goes** (decided: in its sub-task).

- A new sub-task on top of the stack: no rebase, but the fixed pull request
  stays wrong and the reviewer reads the fix elsewhere.
- **In its sub-task** (chosen), with the cascade: each pull request stays
  right on its own; the cost is the rebase missions and a force-push with
  lease.

**How the pull requests are arranged** (decided: a stack into the base).

- **The console's mission branch** (its decision 0008): each sub-task's pull
  request targets a mission branch, and one main pull request takes the
  mission branch into `main`. No chained rebase, but the work is merged
  twice, and the console's engine merged the sub-tasks' pull requests itself.
- **A stack into the base** (chosen, decisions 1, 27, 28): each pull request
  targets the branch below, the bottom one the base, linked as a GitHub stack;
  the human merges them all.

## 6. Design

### 6.1 Overview

- **The Mac**: Herdr App (the Pilot's terminal), the ticket manager's
  interface, and the human's forge commands: launch the Pilot on a ticket,
  `forge fetch`, `forge ship <ticket>`, import peer comments. It reaches the
  host over SSH, GitHub with the human's access, and the ticket manager.
- **The host, one VM per client project**: the forge API (one socket per
  container), the origin mirror and the team mirror of each repository, the
  journal.
- **The control container**: the orchestrator (its own user, the ticket
  manager's credential, the API socket), the Pilot and the question sessions, read-only clones of every
  repository.
- **The execution containers** (N): one mission at a time, every clone, the
  project's Docker services. They see only the forge API: no ticket
  credential, no GitHub.
- **The ticket manager**: the local Markdown base taken from the console
  (default), or another adapter such as the cloud manager's, reached
  only by the orchestrator, through the adapter.

### 6.2 Containers and users

**The configuration** (host, `~/.config/agent-forge/config.json`) declares one
project per VM: its repositories, the number of execution containers and their
resources, the ticket manager's adapter, the mode. An illustration, not a
format:

```json
{
  "project": {
    "repositories": {
      "web": { "url": "git@github.com:<owner>/web.git" },
      "api": { "url": "git@github.com:<owner>/api.git" }
    },
    "executors": { "count": 3, "memory": "8GiB" },
    "tickets": { "adapter": "console" },
    "mode": "supervised"
  }
}
```

**The control container** replaces the Pilot container. Two Unix users:

- **the orchestrator's user** (name: the builder's): runs the orchestrator as
  a long-running service; owns the ticket manager's credential (a mode-600
  file), the container's forge API socket (`/run/forge/api.sock`, owned by
  this user, mode 600, where today `aiuser` owns it);
- **`aiuser`**: runs the hc core, the Pilot session and the question
  sessions, with read-only clones of every repository (today's `read-repos`).
  It cannot read the orchestrator's files nor connect to the API socket.

The sessions reach the orchestrator through a **local socket** the
orchestrator owns, writable by `aiuser` (group permission), with a few narrow
verbs (§6.5). Validation by hand, as in `cli/lib/api/protocol.ts` and
`cli/lib/relay/serve.ts`.

**The execution containers**: generic, `executor-<n>` (names: the builder's).
Each has a clone of every repository (`repo` for all of them), `publish`,
`services`, and its API socket owned by `aiuser` as today. Their memory
follows the heaviest Docker stack of the project.

**Capabilities.** The closed list of DX 5 stays the mechanism, but the roles
are fixed by forge: control, executor. `talk-to`, `assign`, `ask-human` and
the Lead/Reviewer roles go; the human no longer composes roles.

### 6.3 The connector

forge defines the interface; each ticket manager supplies an adapter, which
runs in the control container and which only the orchestrator calls. forge
knows a fixed vocabulary of statuses (§2.2, §2.3, the console's eight common
statuses); mapping each manager's own statuses onto it is the adapter's work.
The **default adapter is the local Markdown ticket base** taken from the
console (§6.12), in this repository. Any other adapter (the cloud manager's,
a Linear one) lives in a repository of its own.

**The adapter is an executable** speaking JSON lines on stdin/stdout (one
request, one answer), so an adapter can be written in any language and
shipped as a binary. It gets its credential from a file path the orchestrator
passes it; the credential never travels in a request.

**First operations.** The write side follows the console's rule of a few
named write gestures, never a deletion (its decision 0005):

| Read | Write |
|---|---|
| list tickets by status and priority | create a sub-task: parent ticket, repository, position in the stack, rank in the ticket's order, kind (implementation or fix), fixed sub-task, text |
| read a ticket: title, description, priority, status, its repositories and their base (a branch, or the top of another ticket's stack) | change the status of a ticket or a sub-task (with a reason: `rebase`) |
| read a ticket's sub-tasks: repository, position, rank, status, kind, fixed sub-task, branch, pull request | open a request on a sub-task (a question for the human, with a recommended answer), and read its answer |
| read the comments and answers since a cursor | comment: answer, QA report, branch or pull request link |
| read the ticket's mission files: spec, answers, split | write the mission files, and put the spec's summary and a link in the ticket |
| | create a ticket (the non-blocking points) |

**Who creates what.** The human creates the tickets (in the ticket manager);
the Pilot writes the mission files and, after the human's approval, the
sub-tasks; the orchestrator writes statuses, requests and comments. The Pilot
creates tickets only for the non-blocking points of a review.

**The source is trusted** (decision 24): what comes from the manager (a
sub-task, an answer) is treated as coming from the team. The connector
ensures who may write in the tickets, and in whose name. The orchestrator
reads only structured fields; the free text of a ticket is information for
the agents, never an instruction for the orchestrator.

### 6.4 The orchestrator

**A process** in the control container, under its own user, started by
`forge team up` and kept alive (a supervisor in the container; the builder's
choice). It keeps no state of its own that the flow needs: at start, and at
each poll, it recomputes the picture from the ticket manager (statuses) and
the host (`forge-team status`: which container holds which mission, which
session is alive). Only cursors (the comments already read) are kept on disk,
and losing them costs a re-read, nothing more.

**Polling**: the manager at a regular interval (decision 14; the interval is
the builder's, configurable); the API's events (questions, mission ends) at
each poll too, through a verb that returns what came since a cursor.

**Missions.** The orchestrator `assign`s a mission to a free execution
container through the API, then `release`s it when the mission ends:

- **dev**: the sub-task's branch, checked out in the right clone. The host
  creates it from its base if it does not exist (the branch below, or the
  stack's base), or takes it from the team mirror if it does: the branch
  belongs to the ticket (decision 16). The first instruction holds the
  sub-task's text, the answers already given, and for a fix the QA report's
  defect; it points to the mission files instead of copying them (the
  instruction is capped at 64 KiB). **The mission files** (`spec.md`,
  `answers.md`, `split.md`) **live in the ticket base, never in the
  project's repository** (decision 29): one source of truth. For each
  mission, the host pushes a read-only copy of them into the execution
  container, beside the instruction and outside the clone; the copy is a
  snapshot for that mission, the base stays the truth.
- **rebase**: the sub-task's branch, rebased onto the new branch below. The
  team mirror already accepts forced updates of `agent/*`.
- **QA**: the tops of the ticket's stacks checked out in their clones, and
  the mission files' copy. The report files each defect under a sub-task or as
  transverse (decision 6), in a structured form the orchestrator can read
  (a list of `{sub-task | transverse, text}`); the text is copied into the
  fix sub-tasks, never interpreted.

**After a restart.** A mission whose session is `lost` or `exited` while the
container still holds it is re-issued: a fresh session on the same branch,
with the same instruction and a first line saying the mission resumes. The
work in progress is on the branch (decision 17 applies to the developer; an
unplanned stop loses only uncommitted work).

### 6.5 The API and the local channel

**The forge API** (host, one socket per container) changes its verbs:

| Caller | Verb | What it does |
|---|---|---|
| execution container | `ask` | a question about the current mission; returned to the orchestrator as an event |
| execution container | `done` | the mission is finished (branch published, or the QA report as body); the host fetches the branch into the team mirror first |
| execution container | `status` | its own mission |
| control (orchestrator) | `assign`, `release` | a mission to an execution container (kind, ticket, sub-task, branch, base, instruction) |
| control (orchestrator) | `events` | the questions and mission ends since a cursor |
| control (orchestrator) | `answer` | delivers an answer into the asking container's session |
| control (orchestrator) | `session` | starts a fresh question session in the control container, as `aiuser`, with a given instruction |
| control (orchestrator) | `status` | every container: mission, session state |

`message`, `ask-human` and the Inbox go. The API still identifies the caller by
its socket, validates by hand, refuses a text carrying a handed-out secret,
and keeps its journal.

**The local channel** (control container, owned by the orchestrator, for
`aiuser`'s sessions):

| Caller | Verb | What it does |
|---|---|---|
| Pilot | read verbs | list tickets, read a ticket, its sub-tasks, comments and mission files (to recover its context) |
| Pilot | `write-mission` | the mission files of a ticket (spec, answers, split), and the spec's summary in the ticket |
| Pilot | `create-stack` | after the human's approval: the sub-tasks of a ticket, per repository, with their order; the ticket goes to Dev |
| Pilot | `create-subtask`, `create-ticket`, `comment` | fixes from the review or peer comments; non-blocking points; a written answer |
| question session | `answer` | the answer to its question |
| question session | `escalate` | the question needs the human |

A question session's verbs act only on its own question: the channel knows
which session the orchestrator opened for which question (a token in the
session's first instruction, or a socket per session: the builder's choice).
All these sessions run as `aiuser`, which can read another session's
instruction: the binding guards against an agent's mistake, not a hijacked
session (decision 31). Nothing in the channel writes into the Pilot's
session: questions go to question sessions, then to the ticket manager,
never to the Pilot.

**In the containers**, `forge-team` stays the command the agents use (`ask`,
`done`, `status` in an execution container; the local verbs in the control
container).

### 6.6 Execution containers and missions

- **Every clone**: one per repository of the project, with `origin` as that
  repository's read-only origin mirror. A mission works in the clone of its
  repository; a QA mission may read and run them all.
- **A fresh session per mission**, with the developer's prompt, skills and
  sub-agents (the reference team's `dev` kit, §6.9), including the reviewer
  sub-agent (`branch-reviewer`) it runs before `done`. The reviewer runs the
  tests itself: the developer saying they pass is not evidence (a rule the
  console's handoff to the Lead already set).
- **Before release**, the developer commits and publishes (decision 17). For
  a question escalated to the human, the orchestrator waits for the
  developer's `done` (with a work-in-progress flag) before releasing it; the
  builder sets a timeout after which the orchestrator releases anyway.
- **Docker services** per container, as today.

### 6.7 Stacks on the host

- **Branch names**: `agent/<sub-task>`, unique per repository (the builder
  picks the scheme, for example the ticket's id and a slug). The host records,
  per branch, its ticket, its repository, its base (the branch below, or the
  stack's base) and its rank. These records replace the task records of DX 5
  (`forge task-base`, `assign --from`).
- **The cascade** is the orchestrator's: when a sub-task's branch changes
  under sub-tasks that are Done, it sets each of them back to Ready, reason
  `rebase`, bottom-up; the rule of §2.5 then gives them rebase missions one
  after another (one active sub-task per ticket). Across tickets (decision
  3), a ticket built on another's top is rebased the same way once the other
  ticket's stack settles.

### 6.8 The Pilot

- **A single session**, started by `forge team up` in the control container,
  as `aiuser`. The human talks to it in its Herdr App terminal.
- **Launching it on a ticket** is a forge command on the Mac (name: the
  builder's, for example `forge pilot <ticket>`). It refreshes the origin
  mirrors with the human's forwarded SSH agent (decision 12), then sends the
  Pilot a line naming the ticket. The Pilot reads the ticket through the local
  channel, asks its questions and writes the spec with the human
  (`write-mission`), proposes the split into stacks, and creates them after
  the human's approval (`create-stack`). The console's way of preparing
  carries over: questions asked in rounds, each with a proposed answer, the
  spec built from the request and the answers.
- **Only the human writes into its session** (decision 31): the human's messages and
  gestures (the launch on a ticket, the import of peer comments).
  Developers' questions never reach it.
- **Its context**: between two tickets it clears or compacts it, and recovers
  what it needs from the ticket manager (spec, sub-tasks, QA reports) and its
  memory, as after a restart. Its memory (the human's preferences, the
  decisions, the map of the repositories) stays on the host, as today.
- **The spec**: a sub-agent explores the code and drafts, so the Pilot keeps
  only the result; the conversation with the human stays with the Pilot (a
  sub-agent does not talk to the human).
- **The review** (supervised): the human writes it to the Pilot, which
  re-reads the ticket, then creates the fix sub-tasks and the new non-blocking
  tickets. Peer comments reach it through the import command (decision 11).
- **Answers**: the human answers a blocking question in the ticket manager,
  or to the Pilot, which writes the answer in the ticket. Either way the
  orchestrator sees it at its next poll.
- **It reads the code**: read-only clones of every repository, refreshed from
  the origin mirrors.

### 6.9 What goes into each container

- **Control container**: the Pilot's prompt and skills (`design`,
  `checkpoint`, the split, rewritten for stacks and the local channel), the
  question session's prompt (answer from the spec and the code, or escalate),
  the orchestrator and the adapter.
- **Execution containers**: one prompt with three mission kinds (dev,
  rebase, QA), the skills `tdd`, `diagnose`, `verify-before-report`, the
  sub-agents `scout` and `branch-reviewer`, and a QA skill that writes the
  structured report.
- **Gone**: the Lead's and the Reviewer's prompts, `split-request` and
  `review-branch` as roles' skills (their content moves to the Pilot's split
  and the developer's reviewer sub-agent).
- `container/CLAUDE.md` is rewritten for missions and the two containers.

### 6.10 The human's commands on the Mac

- **`forge team up`**: converges the control container and the execution
  containers from the config, the clones, the orchestrator and its
  credential, the Herdr App machines (the Pilot's at least; one per execution
  container, to watch a mission).
- **Launch the Pilot on a ticket** (§6.8).
- **`forge fetch <ticket>`**: the ticket's branches from the team mirror, for
  the human's review.
- **`forge ship <ticket>`** (§6.11).
- **Import peer comments** (name: the builder's): reads the pull requests'
  comments and state with the human's GitHub access; hands the new comments
  to the Pilot's session (as `forge answer` delivers today: over SSH, the text
  on stdin); and, when every pull request of the ticket is merged, records the
  fact for the orchestrator, which sets the ticket to Done.
- **Gone**: `forge team watch`, `forge answer`, the Herdr App mod's Inbox and
  question notifications (the screens of §6.12 take over, decision 32).
  `forge team assign`
  and `forge team release` stay as the human's escape hatch, without checks.

### 6.11 `forge ship <ticket>` and GitHub stacked pull requests

- For each stack of the ticket, bottom-up: replay each branch commit by commit
  with the human's signature (`cli/lib/laptop/replay.ts`), each onto the
  replayed branch below, refusing merge commits, as today.
- **Push**: plain when the remote branch is an ancestor; after a cascade,
  `--force-with-lease` with the lease set to the remote branch the last ship
  pushed, and only on the ticket's own branches (decision 27). Today's rule
  "never force" becomes this one.
- **Pull requests**: one per sub-task, each based on the branch below, linked
  as a GitHub stack. GitHub's stacked pull requests are generally available
  since 2026-10-06 on github.com; the CLI side is the `gh-stack` extension
  (`gh stack submit` pushes and links), which needs GitHub CLI 2.90 or later.
  Whether forge drives `gh stack` or calls the API itself is the builder's
  call; forge keeps its own replay and signature either way. A stack lives in
  one repository, which fits one stack per repository.
- **Merge**: the human, on GitHub (decision 28). After a bottom pull request
  merges, GitHub rebases the rest of the stack itself; whether that rewrite
  keeps the commits signed must be checked (GitHub's "Update branch" dropped a
  signature on #107). If it does not, the human merges the whole stack at
  once, or runs `forge ship <ticket>` again before merging the next layer.
- The ticket goes to PR review: the ship records the fact for the
  orchestrator (as the import command does).

### 6.12 What the runtime takes from the console

**The console at its last version** (`a31b23d`, archived) is a "mission
control" in TypeScript (Node 24, no runtime dependency, like forge): an
engine run as a command on the Mac, and screens that are native Herdr App
mods (Inbox, the list of missions, a mission's page, an agent's terminal).
It has its own ticket base, fed by one connector per project (Linear is
built; a Markdown connector is planned, not in that version); a ticket's
fields (its decision 0004): identifier and displayed key, origin (connector,
external id, link), title, Markdown description, type (main or sub-ticket)
and parent, status, priority (0 to 4), size, level (normal or high-risk),
order, dependencies, file area, planned developer, comments; eight common
statuses; four named write gestures; requests to the human, each with a
recommended answer, answered once; and the mission files (`spec.md`,
`answers.md`, `split.md`) written in Markdown and committed with the code.
Since 2026-11-24 its engine handed each ticket to forge's Lead over SSH.

**Taken** (decision 29): the ticket model and the common statuses, the
connector model and its write gestures, the requests with a recommended
answer, the Markdown mission files and the code that writes them safely, the
Pilot's way of preparing (questions with proposed answers, the spec built
from the answers). **The local Markdown ticket base** is built in the
console's spirit, tickets and mission files as Markdown: the structure
first, then iterations, its author carrying on with it.

**Not taken**: the Lead and the watcher (the orchestrator replaces them), the
mission branch and its main pull request, the engine merging pull requests,
the mission files committed with the code (its decision 0009: the Markdown
stays out of the projects' repositories), the Linear connector (a repository
of its own, if needed), the independent reviewer container and the double
review of high-risk tickets (later, if needed), the engine and the Pilot on
the Mac, the handoff to forge over SSH, two developers in parallel on file
areas (later, with the parallel sub-tasks).

**Where it runs**: in the control container, inside the orchestrator's
process and under its user (the base and the adapters' credentials are its).
**The Markdown base is a folder beside the repositories**: a host directory
per project, mounted into the control container, never inside a project's
repository. It survives the container's recreation, the human can read it on
the host, and it can be made a git repository of its own (its history, a
backup), still a single source of truth.

**The screens** (decision 32). Read at `a31b23d`: one Herdr App window
(`screens/mission-control/main.ts`, about 1,200 lines, with a test that runs
outside Herdr against a stand-in), in a Herdr installation of its own. Its
only link to the engine is one function that runs a command and reads a JSON
reply, over a contract (`engine/contract.ts`) shared with the engine; it
polls every three seconds. So the screens are taken and adapted:

- **The seam moves.** The command that reaches the engine now reaches the
  orchestrator in the control container, through forge's transport; the
  Linear key and the Keychain go. The cost of polling every three seconds
  over that transport is not measured: the builder checks it.
- **Kept**: the frame and the list of tickets (read from the Markdown base),
  and the answer to a request.
- **Added**: a ticket's page with its sub-tasks, their statuses and the QA
  report.
- **Not kept**: the question and spec pages (the conversation with the Pilot
  replaces them), the plan page (parallel developers, tools, minutes) and the
  development page (turns, reviews, the mission's pull request): they
  describe the Lead's flow, which is gone (§7).
- **The contract is the new model's**: sub-tasks, stacks, the eight common
  statuses, requests with a recommended answer (no `lead`, `dev` or
  `reviewer` askers, no mission stage). It is defined with the engine, and
  the colleague's iterations follow it.

### 6.13 No autonomous mode

forge runs supervised only (decision 33). No GitHub credential enters the
control container: the pull requests are opened by `forge ship` and their
comments read by the import command, both on the Mac with the human's
access. The marker `~/.claude/forge-mode` and the autonomous rules of
`container/pre-bash.sh` are not touched by this design.

## 7. What changes from DX 5 and the reference team

| Today | Tomorrow |
|---|---|
| A Pilot, one long session that never starts over | Still one Pilot, which also splits; it clears its context between tickets and recovers it from the manager |
| A Lead agent per repository, which splits and coordinates | The orchestrator is code; questions go to fresh sessions |
| A Reviewer container | A reviewer sub-agent of the developer |
| No QA in the reference team | A QA mission per ticket |
| forge runs alone, without a ticket manager (DX 5 decision 11) | The console is mandatory, merged into the runtime; the Inbox, `forge answer` and `forge team watch` give way to the manager |
| A team per repository, one clone per container | One VM per client project, one group of containers for all its repositories, each with every clone |
| A fixed role per container | A control container and generic execution containers, the role set by the mission |
| One agent per container (DX 5 decision 1) | The control container hosts several sessions; only the orchestrator, under its own user, holds the credential and the API |
| The API socket owned by `aiuser` (DX 5 decision 13) | In the control container, owned by the orchestrator's user |
| The Pilot has `assign` | The Pilot goes through the orchestrator, which alone hands out missions |
| Each sub-task from `origin/main`; `assign --from` stacks at the same developer | A stack per ticket and per repository; the branch belongs to the ticket |
| `forge ship` never forces a push | After a cascade, a force-push with lease on the ticket's branches |
| `forge ship <task>` | `forge ship <ticket>`, every stack of the ticket, as GitHub stacked pull requests |
| Questions to the human in forge's Inbox | Questions in the ticket manager |
| The state in the agents' notes | The state in the ticket manager; resuming re-reads the statuses (#186) |
| The console, a separate repository, drives forge's Lead over SSH from the Mac | The console's repository is archived; its ticket management runs in the control container |

The contributor VM and its relay are not touched by this design.

## 8. Delivery

Each part is a pull request (or a short series), merged into `main` before
the next one. A clean break (decision 30): part 1 replaces the team model in
place, and the release notes say to ship every task, then recreate the
containers. The maintainer works meanwhile from the pre-DX 5 tag and from
the old system kept on a LAN host.

1. **The orchestrator, the containers and the Markdown ticket base.** The
   connector's interface; the ticket model and statuses taken from the
   console; the local Markdown base as the default adapter; the control
   container with its two users, the API socket moved to the orchestrator's
   user; the generic execution containers with every clone; the
   orchestrator's rule, dev missions, `done`, the host's branch records; one
   repository, one stack per ticket. The old team model goes (Lead, Reviewer
   container, `message`, `ask-human`, Inbox, `forge team watch`, `forge
   answer`, the console's SSH handoff verbs). *End state: tickets written as
   Markdown files are implemented sub-task after sub-task by several
   containers in parallel.*
2. **The Pilot and the questions.** The local channel; the Pilot's launch on a
   ticket, the mission files, `create-stack`; question sessions, requests,
   Waiting for human, the answer back to Ready. *End state: the human
   specifies a ticket with the Pilot and answers questions.* It ships without
   the screens' small slice (decision 34).
3. **QA, fixes, cascade, ship.** QA missions and their report, fix sub-tasks,
   rebase missions and the base check before QA, `forge fetch <ticket>`,
   `forge ship <ticket>` with the lease and the GitHub stack, the import of
   peer comments, Done on merge. *End state: the supervised flow of §2 runs
   end to end.*
4. **Multi-repository tickets and tickets built on another's stack.**

The Markdown base iterates alongside, with its author: part 1 gives it its
structure (the ticket model, the adapter interface, files in the base's
folder), later parts add what the flow needs.

## 9. Security

- **The control container is the most powerful**: the ticket manager's
  credential (read and write), read access to every repository, the missions
  of every execution container.
- **The orchestrator's own user** is what keeps that power out of the Claude
  sessions: only it reads the manager's credential and connects to the API
  socket. A hijacked session can only ask it for the narrow verbs of the local
  channel. A change of the DX 5 security architecture, validated by the
  maintainer (decision 25).
- **The sessions share `aiuser`** (decision 31): a hijacked question session
  can read another session's instruction and use the Pilot's verbs (create
  sub-tasks or tickets, comment, write mission files), never a credential.
  What it does shows in the ticket manager. Accepted by the maintainer.
- **A Unix user is a weaker boundary than a separate VM.** A session that
  gains the orchestrator's rights (a local privilege escalation in the
  container) gets the manager's credential. The relay of the contributor VM, a separate machine, is the
  stronger model; accepted for now.
- **The ticket source is trusted by assumption** (decision 24): the connector
  guarantees who may write a sub-task or an answer. The orchestrator reads
  structured fields only.
- **The execution containers** hold no ticket credential and no GitHub
  credential, as today. They have the clones of every repository of the
  client: one host serves one client project.
- **The cloud ticket manager receives** the specs, the questions and the QA
  reports: excerpts of the client's code go there. That is for the client to
  know.
- **GitHub** is reached only at the human's gesture. The
  force-push of `forge ship` is limited to the ticket's branches, with lease.
- **The anti-goals of DX 5 stay**: no container reaches the host's hc core,
  `incus`, or another container's socket; no secret in an argv, hc's state or
  the journal; no agent text in a shell line.

## 10. Open questions

None. The two questions of the autonomous mode (trust in peer comments read
by the orchestrator, the signature of the commits it pushes) go with it
(decision 33).

## 11. Tests

Lean, as the repository's rule asks:

- **Unit**, with the fake `incus`, a fake `hc` and a Markdown ticket base in a
  temporary directory: the orchestrator's rule and events (QA first, the base
  check before QA, priority, one active sub-task per ticket, the cascade's
  order), the adapter protocol's validation, the Markdown base's reads and
  write gestures, the local channel's verbs and their refusals (a question
  session acting on another question: an agent's mistake), the new API
  verbs, the branch records, `forge ship`'s lease and its refusal to push a
  branch outside the ticket.
- **Integration** (`FORGE_INTEGRATION=1`): `aiuser` in the control container
  cannot read the orchestrator's credential nor connect to its API socket; a
  dev mission creates the branch from the branch below; a resumed sub-task
  takes its branch from the team mirror in another container.

## 12. Known limits

- One active sub-task per ticket: a long ticket is developed serially; the
  throughput comes from tickets in parallel.
- The origin mirrors are only as fresh as the human's last gesture.
- A question escalated to the human holds its whole ticket.
- The orchestrator sees the human's answers only at its next poll.
- Every execution container holds every repository and the heaviest Docker
  stack's memory.
- GitHub's automatic rebase of a stack after a merge may drop signatures
  (§6.11).
- A question session can act as the Pilot if hijacked (decision 31).
- Between the QA and the ship, the base may move again: the QA result is
  then one base behind.

## 13. Left to the builder

- Names: commands, verbs, users, containers, the config format, branch names.
- The polling interval, the timeouts (a session starting, a developer
  committing before release).
- How the orchestrator is supervised in the container.
- How a question session's verbs are bound to its question (token or socket).
- Whether `forge ship` drives `gh stack` or the GitHub API.
- The adapter protocol's exact messages, within the operations of §6.3.

## 14. Calls made while writing (to check)

These were proposals on the model page that the maintainer has not settled
one by one; the maintainer chose to start from the page as it is and fix later.

- The Pilot hands the spec's heavy work to a sub-agent; the conversation
  stays with the Pilot (§6.8). The idea is the maintainer's ("maybe"); the
  split of roles is mine.
- The human answers a blocking question in the manager, or to the Pilot,
  which writes it in the ticket (§6.8).
- A multi-repository ticket has a single order across its stacks, set by the
  Pilot: the active sub-task is the first of that order not Done (§2.3).
- A ticket built on another's stack waits, for its QA, until the other has
  passed its own: otherwise it tests work still moving.

And calls made only in this document:

- The screens' small slice is the list of tickets, a ticket's page and the
  answer to a request, adapted from the console (§6.12). What the console's
  screens cost to adapt is read from its code at `a31b23d`, not measured by
  running them.
- The adapter is an executable speaking JSON lines on stdio (§6.3).
- The orchestrator keeps no state the flow needs; it recomputes from the
  manager and the host, and re-issues a mission whose session died (§6.4).
- The API's verbs change as in §6.5 (`ask`, `done`, `events`, `answer`,
  `session`); question sessions are started by the host, as `aiuser`, at the
  orchestrator's request, so the orchestrator needs no access to `aiuser`'s
  hc core.
- The QA report is structured (a list of defects, each under a sub-task or
  transverse), its text copied, never interpreted (§6.4).
- `forge team assign` and `forge team release` stay as the human's escape
  hatch (§6.10).
- The import command also detects the merge and sets the ticket to Done; the
  ship records the move to PR review (§6.10, §6.11).
- Our statuses map onto the console's eight common statuses; "Waiting for
  human" is an open request, not a status (§2.2).
- Before each QA, a stack whose base moved is rebased first; open stacks are
  not rebased at each refresh (§2.4). This answers the review's question on
  a moving base.
- A mission gets a read-only copy of the mission files, pushed beside its
  instruction and outside the clone; the instruction points to it (§6.4).
- The human creates the tickets; the Pilot writes the mission files and the
  sub-tasks, and creates tickets only for non-blocking points (§6.3).
- The reviewer sub-agent runs the tests itself (§6.6), from the console's
  handoff rule.
- What is taken from the console and what is not (§6.12); its engine runs
  inside the orchestrator's process.
- The parts' order (§8): the Markdown base's structure comes with part 1.
- The open-source console is named (`la-fabrique-ai/console`): its ticket
  management becomes part of this repository. The cloud manager, the
  client, the projects the console ran on and the people are not named.

## 15. Next

The maintainer reads this document; then `superpowers:writing-plans` for
part 1.
