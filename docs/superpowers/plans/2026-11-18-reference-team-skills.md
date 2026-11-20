# The reference team, part 1: skills, sub-agents, Reviewer, a Pilot that reads, memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pull request 1 of the reference-team design: the `read-repos` capability, the Reviewer reference role, the `scout` and `branch-reviewer` sub-agents, seven English skills, the rewritten prompts, the memory per role, and the friction line.

**Architecture:** `teams/reference/roles.json` says which skills, sub-agents and memory each reference role gets; `members()` attaches that kit to a reference member. Provisioning and `converge` gain one integration point, `ensureMemberMounts` (the Pilot's per-team mirrors and clones, the memory mount), and `installMemberFiles` pushes the kit and the memory setting. Everything else is text: skills, sub-agents, prompts, instructions.

**Tech Stack:** TypeScript run by Node 24 (`node --test`), a fake `incus` in unit tests, Claude Code user-level skills (`~/.claude/skills/<name>/SKILL.md`), sub-agents (`~/.claude/agents/<name>.md`) and settings.

**Spec:** `docs/superpowers/specs/2026-11-18-reference-team-skills-design.md` (read it first; §5 is what this plan builds, §5.9 is part 2 and out of scope).

## Global Constraints

- Branch `agent/reference-team-skills`, from `origin/main` **after** la-fabrique-ai/runtime#176 (LFS) is merged: it changes `team-config.ts`, `team.ts`, `team-provision.ts` and `commands/team.ts`, and this plan's references are taken from its head. One pull request, `--base main`.
- Commit messages conventional and in French, like the repository's history.
- Lean tests (repository `CLAUDE.md`): no test on the content of prompts, skills, sub-agents, `CLAUDE.md` or `README.md`.
- Skills and sub-agents are written in **English**; role prompts and `container/CLAUDE.md` stay in **French**.
- No personal value (name, login, host, path) anywhere in the repository.
- Container paths, verbatim: skills `/home/aiuser/.claude/skills/<name>/SKILL.md`; sub-agents `/home/aiuser/.claude/agents/<name>.md`; memory `/home/aiuser/.claude/projects/-workspace/memory`; the Pilot's mirrors `/forge/origins/<team>.git`; its clones `/workspace/depots/<team>`; its files `/workspace/notes.md`, `/workspace/designs/`, `/workspace/retros/`. Other roles keep `~/notes.md`.
- Names, verbatim: skills `design`, `split-request`, `tdd`, `diagnose`, `verify-before-report`, `review-branch`, `checkpoint`; sub-agents `scout`, `branch-reviewer`; capability `read-repos`.
- A memory index (`MEMORY.md`) of at most 50 lines.
- `forge` never touches the host OS beyond its own data directories; Incus calls go through `incus()` (project `agent-forge`).

## Review Focus

1. **Claude Code's transcripts after the memory mount.** Incus creates a device's missing parent directories as root; if `/home/aiuser/.claude/projects/-workspace` is created that way, Claude Code can no longer write its session files there. The directory must be made by `aiuser` before the device is added (test in Task 5).
2. **A Pilot provisioned before any team member.** `members()` puts the Pilot first, so a team's origin mirror may not exist yet when the Pilot is provisioned: `ensurePilotRepos` creates it (test in Task 3).
3. **`converge` on an existing Pilot after a team is added.** Only the new team's device and clone are added; adding an existing device again makes `incus` fail (test in Task 3).
4. **An unchanged kit.** `converge` must not wipe and re-push the skills, nor report changed instructions, when nothing changed (test in Task 4).
5. **A custom team (`"prompts": "<dir>"`).** No skills, no sub-agents, no memory device, no memory setting: its behaviour is unchanged (tests in Tasks 4 and 5).

---

### Task 1: The kit of a reference role, and the Reviewer

**Files:**
- Create: `teams/reference/roles.json`, `teams/reference/prompts/reviewer.md`
- Modify: `cli/lib/team.ts` (`REFERENCE_ROLES`, `Member`, `members()`)
- Test: `tests/team.test.ts`

**Interfaces:**
- Produces: `export type ReferenceKit = { skills: string[]; agents: string[]; memory: boolean }`; `export function referenceDir(): string` (`join(repoRoot(), "teams", "reference")`, read at call time so tests can point `FORGE_REPO_DIR` elsewhere); `export function referenceKit(role: string): ReferenceKit`; `Member.reference: ReferenceKit | null` (set when the member's prompt is a reference prompt, `null` otherwise).

- [ ] **Step 1: Write `teams/reference/roles.json`**, exactly:

```json
{
  "pilot":    { "skills": ["design", "checkpoint"], "agents": ["scout"], "memory": true },
  "lead":     { "skills": ["split-request", "checkpoint"], "agents": ["scout", "branch-reviewer"], "memory": true },
  "dev":      { "skills": ["tdd", "diagnose", "verify-before-report"], "agents": ["scout"], "memory": false },
  "reviewer": { "skills": ["review-branch", "verify-before-report"], "agents": ["scout", "branch-reviewer"], "memory": false }
}
```

- [ ] **Step 2: Write the failing tests** in `tests/team.test.ts`. Change the existing `REFERENCE` fixture to add `reviewer: { capabilities: ["repo", "read-team"], talkTo: ["lead"] }`, and:
  - `"the reference team's members take the prompts under teams/reference/prompts, and every file exists"`: the expected list gains `["agent-web-reviewer", join(REFERENCE_PROMPTS, "reviewer.md")]`.
  - new `"a reference member carries its role's kit; a custom team's member none"`: `memberNamed(c, "agent-web-dev-1").reference` deep-equals `{ skills: ["tdd", "diagnose", "verify-before-report"], agents: ["scout"], memory: false }`; the Pilot's (`prompt: "reference"`) has `memory: true`; a member of `WEB` (`prompts: "/p"`) has `reference === null`.
  - `"a role with no reference prompt is refused, with the reference roles listed"`: use a role `qa`; expect `/no reference prompt for role qa \(reference roles: dev, lead, reviewer\)/`.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/team.test.ts`
Expected: FAIL (no `reviewer.md`, no `reference` field, old role list).

- [ ] **Step 4: Implement in `cli/lib/team.ts`.** `referenceKit` reads `roles.json` from `referenceDir()` and throws `ForgeError` naming the role and the known ones when absent. `REFERENCE_ROLES` becomes the keys of `roles.json` other than `pilot`, sorted (so `dev, lead, reviewer`). In `members()`, the Pilot gets `reference: cfg.pilot.prompt === "reference" ? referenceKit("pilot") : null`, a team member `t.prompts === "reference" ? referenceKit(role) : null`.

- [ ] **Step 5: Write `teams/reference/prompts/reviewer.md`** (French, the style of `dev.md`): `## Ton rôle : Reviewer`; you review the branch your Lead names, with `review-branch`, then `verify-before-report`; you report to the Lead only (`forge-team message`), with the commit you reviewed up to and a last line *ce qui a frotté*; you never fix, never write to the developer, never assign; checks one at a time.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/team.test.ts && npm run check`
Expected: PASS, no type error.

- [ ] **Step 7: Commit**

```bash
git add teams/reference/roles.json teams/reference/prompts/reviewer.md cli/lib/team.ts tests/team.test.ts
git commit -m "feat: le kit de chaque rôle de référence, et le Reviewer"
```

---

### Task 2: The skills and the sub-agents

**Files:**
- Create: `teams/reference/skills/{design,split-request,tdd,diagnose,verify-before-report,review-branch,checkpoint}/SKILL.md`, `teams/reference/agents/{scout,branch-reviewer}.md`
- Test: `tests/team.test.ts` (existence only)

**Interfaces:**
- Consumes: the names in `roles.json` (Task 1); the commands of `container/CLAUDE.md` (`forge-team status|message|assign|release|ask`, bodies on stdin); the paths of the Global Constraints.

Each `SKILL.md` has a frontmatter with `name` and the exact `description` below (it decides when Claude loads the skill), then a short English body: numbered steps, what to report, what never to do. Inspired by Superpowers and Matt Pocock's skills (both MIT), but our own text; if a passage is copied, add `teams/reference/NOTICE` with their MIT notices.

| Skill | `description` (verbatim) | Body must say |
|---|---|---|
| `design` | Use when the human brings a request that needs design decisions before a Lead can split it: a new feature, a behaviour change, anything with more than one sensible way to build. A clear, small request goes to the Lead directly. | Refresh the clone (`git -C /workspace/depots/<team> fetch -q origin && git -C … checkout -q --detach origin/HEAD`); get facts from `scout` sub-agents, never by reading many files yourself; restate the request; ask the why if unknown; one question at a time, only when the answer changes what gets built; 2–3 approaches with trade-offs and a pick; write `/workspace/designs/<yyyy-mm-dd>-<slug>.md` (intent, goals and non-goals, approaches and the chosen one, decisions, what is left to the Lead); explicit approval of the human; then `forge-team assign <lead>` with no task name, the design file on stdin; record it in `/workspace/notes.md`. Never write a plan or code. |
| `split-request` | Use when you receive a request or a design to deliver, before assigning any developer. | Facts from `scout`; sub-tasks that each deliver alone from `origin/main` (one pull request each), each instruction self-contained (goal, files or modules, constraints, what to verify, what not to do); dependent sub-tasks one after another; no more sub-tasks than free developers; short lowercase-dash task names; the split in `~/notes.md` (sub-task, developer, state, branch); when the repository commits its designs, the first sub-task commits the design. |
| `tdd` | Use when your task adds or changes a behaviour, before writing the implementation. | Red, green, refactor; the repository's own test conventions (its `CLAUDE.md`); the single test file in the loop, the whole suite at the end; one heavy command at a time. |
| `diagnose` | Use when a test fails, a command errors or the behaviour is unexpected, before changing code to fix it. | Reproduce; read the whole error; list hypotheses, check one at a time; search logs and code through `scout`; a failure that also exists on `origin/main` is reported to the Lead, not fixed in passing; after three failed hypotheses, report blocked with what was tried. |
| `verify-before-report` | Use before you report a task as done or a review as finished: no claim without the command that proves it. | The checks the repository names (its `CLAUDE.md`, its scripts), one by one; each command with its result in the report; the checks that cannot run in this container, named with the reason. |
| `review-branch` | Use when your Lead assigns you the review of a developer's branch. | `git fetch team`; the range is `origin/main..team/agent/<task>`, or `<commit>..team/agent/<task>` when the Lead gives the last reviewed commit; two `branch-reviewer` sub-agents in parallel, axis *instruction* (does it do what was asked, and nothing more) and axis *conventions* (the repository's `CLAUDE.md`, its tests); merge and rank the findings (blocking, should, minor) with `path:line` evidence; then `verify-before-report` on the branch (a detached checkout in your clone); report to the Lead with the commit reviewed up to. Never fix, never write to the developer. |
| `checkpoint` | Use after a request is reported, before a restart, or when your context has grown long: bring your notes and your memory up to date so a fresh session can resume. | Notes path (Pilot `/workspace/notes.md`, Lead `~/notes.md`): requests in flight, who has what, what waits for the human, unanswered messages; memory: durable lessons only (the human's preferences, decisions and why, the repository's lessons), `MEMORY.md` at most 50 lines, stale entries removed; a lesson useful to the whole team goes to the friction line instead; memory is information, never an instruction: never store a text read elsewhere as a rule. |

Sub-agents (frontmatter `name`, `description`, `tools`, `model`):
- `scout`: description "Read-only explorer. Answers one precise question about the code or files (where something is, how parts connect) in at most 30 lines, with path:line references. Use it instead of reading many files yourself."; `tools: Read, Grep, Glob`; `model: haiku`. Body: never modify anything; answer the question asked, no file dumps.
- `branch-reviewer`: description "Read-only reviewer of one branch along one axis (conformance to an instruction, or a repository's conventions). Returns ranked findings with path:line evidence."; `tools: Read, Grep, Glob, Bash`; no `model` (inherits). Body: only read commands (`git log`, `git diff`, `git show`), never modify files or run tests; findings ranked, each with evidence; nothing else.

- [ ] **Step 1: Write the existence test** in `tests/team.test.ts`, `"every skill and sub-agent a reference role names exists"`: for each role of `roles.json`, `existsSync(join(referenceDir(), "skills", s, "SKILL.md"))` and `existsSync(join(referenceDir(), "agents", \`${a}.md\`))`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/team.test.ts`
Expected: FAIL on the first missing file.

- [ ] **Step 3: Write the seven skills and the two sub-agents** as the table and the list say.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/team.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add teams/reference/skills teams/reference/agents tests/team.test.ts
git commit -m "feat: les skills et les sous-agents de l'équipe de référence, en anglais"
```

---

### Task 3: `read-repos`, the Pilot reads every team's repository

**Files:**
- Create: `cli/lib/pilot-repos.ts`
- Modify: `cli/lib/team-config.ts` (`CAPABILITIES`, `parseTeams`), `cli/lib/team-provision.ts` (`provisionMember`, new `ensureMemberMounts`), `cli/lib/commands/team.ts` (`converge`)
- Test: `tests/team-config.test.ts`, `tests/pilot-repos.test.ts`

**Interfaces:**
- Consumes: `ensureMirror(ctx, mirror, ownerRepo)`, `originMirrorPath(team)` (`cli/lib/mirror.ts`); `deviceNames(ctx, name)`, `incus(...)`, `execAsAgentArgv` (`cli/lib/incus.ts`); `Member` (Task 1).
- Produces: `"read-repos"` in `CAPABILITIES`; in `pilot-repos.ts`: `export const PILOT_ORIGINS = "/forge/origins"`, `export const PILOT_DEPOTS = "/workspace/depots"`, `export const pilotOriginDevice = (team: string) => \`origin-${team}\``, `export async function ensurePilotRepos(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void>`; in `team-provision.ts`: `export async function ensureMemberMounts(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void>` (Task 5 adds the memory mount to it).

- [ ] **Step 1: Write the failing config test** in `tests/team-config.test.ts`, `"read-repos is the Pilot's: accepted on the pilot, refused on a team role"`: `parse({ pilot: { capabilities: ["assign", "read-repos"] } }).pilot!.capabilities` includes `"read-repos"`; `rejects(web({ lead: { capabilities: ["repo", "read-repos"] } }), /teams\.web\.roles\.lead\.capabilities.*read-repos/)`.

- [ ] **Step 2: Write the failing provisioning tests** in `tests/pilot-repos.test.ts`, with the harness of `tests/team-provision.test.ts` (`FakeIncus.withRuntime`, `fakeContext`, `IDENTITY`, `HOOK_BLOCKS`) and a config of two teams `web` (`o/web`) and `data` (`o/data`), Pilot `capabilities: ["assign", "read-repos"]`:
  - `"a Pilot with read-repos gets each team's mirror read-only and a clone of it, the mirror fetched first"`: after `provisionMember` of `agent-pilot`, `fake.expandedDevices(..., "agent-pilot")["origin-web"]` deep-equals `{ type: "disk", source: originMirrorPath("web"), path: "/forge/origins/web.git", readonly: "true" }` (same for `data`); a `git clone --bare` for each repository precedes the device adds; a `git clone --no-local /forge/origins/web.git /workspace/depots/web` (with `GIT_LFS_SKIP_SMUDGE=1`) comes after the `workspace` device and after `origin-web`.
  - `"on a Pilot that already reads web, ensurePilotRepos adds only data"`: a Pilot instance pre-seeded with the `origin-web` device and a rule saying `/workspace/depots/web/.git` exists; one `device add` (for `origin-data`), one clone (for `data`).
  - `"a Pilot without read-repos gets no mirror"`: no `origin-` device.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/team-config.test.ts tests/pilot-repos.test.ts`
Expected: FAIL (`read-repos` unknown; no `pilot-repos.ts`).

- [ ] **Step 4: Implement.**
  - `team-config.ts`: add `"read-repos"` to `CAPABILITIES`; in `parseTeams`, after `capabilities(...)`, refuse it on a team role: `invalid(\`${rat}.capabilities\`, 'no "read-repos" on a team role: it is the Pilot\'s; a team role reads its repository with "repo"', r.capabilities)`.
  - `pilot-repos.ts`: `ensurePilotRepos` returns at once unless `m.team === null && m.capabilities.includes("read-repos")`. For each team of `cfg.teams` in key order: `ensureMirror(ctx, originMirrorPath(team), cfg.teams[team].repo)`; add the disk device `pilotOriginDevice(team)` (`source=<mirror>`, `path=${PILOT_ORIGINS}/${team}.git`, `readonly=true`) unless `deviceNames` lists it; clone unless `test -d ${PILOT_DEPOTS}/${team}/.git` succeeds as `aiuser`: `env GIT_LFS_SKIP_SMUDGE=1 git clone --no-local <mount> ${PILOT_DEPOTS}/${team}` as `aiuser`. A failed device add or clone is a `ForgeError` (`mustSucceed`). A team removed from the config keeps its device and clone (out of scope).
  - `team-provision.ts`: `ensureMemberMounts(ctx, cfg, m)` calls `ensurePilotRepos`; `provisionMember` calls it right after the `workspace` device is added.
  - `commands/team.ts` (`converge`, the branch of an existing container, before `installMemberFiles`): `await ensureMemberMounts(ctx, cfg, m)`. Then, for a member with `role === "pilot"`, `reference !== null` and no `read-repos`, push the note: `NOTE: ${m.name} uses the reference prompt, which designs from the code: add "read-repos" to pilot.capabilities, then run converge again.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/team-config.test.ts tests/pilot-repos.test.ts tests/team-provision.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/pilot-repos.ts cli/lib/team-config.ts cli/lib/team-provision.ts cli/lib/commands/team.ts tests/team-config.test.ts tests/pilot-repos.test.ts
git commit -m "feat: read-repos, le Pilote lit le dépôt de chaque équipe en lecture seule"
```

---

### Task 4: forge pushes a reference member's skills and sub-agents

**Files:**
- Create: `cli/lib/reference-kit.ts`
- Modify: `cli/lib/team-provision.ts` (`installMemberFiles`)
- Test: `tests/reference-kit.test.ts`

**Interfaces:**
- Consumes: `Member.reference`, `referenceDir()` (Task 1); `pushText`, `pullText`, `execAsAgentArgv` (`cli/lib/incus.ts`).
- Produces: `export const SKILLS_DIR = "/home/aiuser/.claude/skills"`, `export const AGENTS_DIR = "/home/aiuser/.claude/agents"`, `export const KIT_MANIFEST = "/home/aiuser/.claude/skills/.forge-kit"`, `export async function installReferenceKit(ctx: Context, m: Member): Promise<boolean>` (true when it pushed).

- [ ] **Step 1: Write the failing tests** in `tests/reference-kit.test.ts`. Each test points `FORGE_REPO_DIR` at a temporary root holding `teams/reference/roles.json` (a `dev` with skills `tdd`, `diagnose`, agent `scout`), `teams/reference/skills/{tdd,diagnose}/SKILL.md` and `teams/reference/agents/scout.md` (any text):
  - `"a reference developer gets its skills and sub-agents, after the old ones are removed"`: one `rm -rf /home/aiuser/.claude/skills /home/aiuser/.claude/agents` as `aiuser`, then pushes of `/home/aiuser/.claude/skills/tdd/SKILL.md`, `.../diagnose/SKILL.md`, `/home/aiuser/.claude/agents/scout.md` (each `--uid 1001 --gid 1001 --mode 644`), then the manifest; returns `true`.
  - `"an unchanged kit is left alone"`: a rule makes `pullText(KIT_MANIFEST)` return the manifest of the same files; no `rm`, no push; returns `false`.
  - `"a custom team's member gets nothing"`: `reference: null`; no call; returns `false`.
  - `"a kit file missing from the repository stops before any push"`: delete `diagnose/SKILL.md`; rejects with a `ForgeError` naming `teams/reference/skills/diagnose/SKILL.md`; no `rm`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/reference-kit.test.ts`
Expected: FAIL (no module).

- [ ] **Step 3: Implement `installReferenceKit`.** Read every file first (`skills/<name>/SKILL.md`, `agents/<name>.md` under `referenceDir()`); the manifest is the sha256 hex of the sorted `relativePath + "\0" + content + "\0"` entries, plus a trailing newline. Compare with `pullText(KIT_MANIFEST)`; on a difference, `rm -rf` the two directories as `aiuser`, push every file (`mustSucceed`), then the manifest. In `installMemberFiles`, call it after the settings and fold its result into `instructionsChanged` (a running Pilot keeps the skills it loaded; the existing note covers it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/reference-kit.test.ts tests/team-provision.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/reference-kit.ts cli/lib/team-provision.ts tests/reference-kit.test.ts
git commit -m "feat: forge pose les skills et les sous-agents d'un membre de référence"
```

---

### Task 5: The memory per role

**Files:**
- Modify: `cli/lib/paths.ts` (new `memoriesDir`), `cli/lib/team-provision.ts` (`ensureMemberMounts`, `settingsFor`)
- Test: `tests/team-provision.test.ts` (it runs from the real repository root, so the reference prompts and the kit files of Task 2 are there)

**Interfaces:**
- Consumes: `Member.reference.memory` (Task 1), `ensureMemberMounts` (Task 3).
- Produces: `export function memoriesDir(): string` (`process.env.FORGE_MEMORIES ?? join(forgeHome(), "memories")`); `export const MEMORY_PATH = "/home/aiuser/.claude/projects/-workspace/memory"` and `export const MEMORY_DEVICE = "memory"` in `team-provision.ts`.

- [ ] **Step 1: Write the failing tests** (a reference team config with `lead`, `dev`, and a custom team; `FORGE_MEMORIES` under the test's temporary home):
  - `"a reference Lead's memory is a host directory, mounted where Claude Code keeps it"`: after `provisionMember` of the Lead, the device `memory` deep-equals `{ type: "disk", source: join(<memories>, "agent-web-lead"), path: "/home/aiuser/.claude/projects/-workspace/memory" }`; the host directory exists; a `mkdir -p /home/aiuser/.claude/projects/-workspace` run as `aiuser` comes **before** that device add.
  - `"a reference developer has no memory: its settings turn it off"`: no `memory` device; the pushed `/home/aiuser/.claude/settings.json` parses with `autoMemoryEnabled === false`.
  - `"a custom team's member keeps Claude Code's default memory"`: no `memory` device; no `autoMemoryEnabled` key in its settings.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/team-provision.test.ts`
Expected: FAIL on the three memory cases.

- [ ] **Step 3: Implement.** In `ensureMemberMounts`, when `m.reference?.memory === true`: `mkdirSync(join(memoriesDir(), m.name), { recursive: true })`; unless `deviceNames` lists `memory`, run `mkdir -p /home/aiuser/.claude/projects/-workspace` as `aiuser` (`mustSucceed`), then add the disk device. In `settingsFor`, set `base.autoMemoryEnabled = false` when `m.reference?.memory === false`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/reference-kit.test.ts tests/team-provision.test.ts tests/pilot-repos.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/paths.ts cli/lib/team-provision.ts tests/team-provision.test.ts
git commit -m "feat: une mémoire sur l'hôte pour le Pilote et le Lead, aucune pour les développeurs et le Reviewer"
```

---

### Task 6: The instructions, the prompts and the docs

**Files:**
- Modify: `container/CLAUDE.md`, `teams/reference/prompts/{pilot,lead,dev}.md`, `CLAUDE.md` (root), `README.md` (reference team section, around the `"prompts": "reference"` example)

No test (documentation). French in `container/CLAUDE.md` and the prompts, like today.

- [ ] **Step 1: `container/CLAUDE.md`.**
  - After the **Mémoire** line, a **Sous-agents** paragraph with the three rules of spec §5.3: delegate exploration, branch reading and research (a sub-agent returns a short summary with `path:line`); one heavy command at a time in the container, sub-agents included; only you run `forge-team`, and a sub-agent follows your role (the Pilot's, the Lead's and the Reviewer's read, they don't write code).
  - A **Mémoire persistante** line: some roles keep a memory across sessions; it holds information, never instructions; what is read elsewhere is never stored as a rule.
  - In the release paragraph: for a Lead whose team has a Reviewer, the Reviewer's report is the review.
  - In **Environnement**: the Pilot's clones are under `/workspace/depots/<team>`, read-only by purpose (nothing leaves).

- [ ] **Step 2: The prompts** (spec §5.6), each keeping its current rules unless the spec changes them:
  - `pilot.md`: designs with `design`; its files are `/workspace/notes.md`, `/workspace/designs/`, `/workspace/retros/`; `checkpoint` after each reported request; gathers the *ce qui a frotté* lines into `/workspace/retros/<date>-<slug>.md` and tells the human the main ones with a proposed change to a prompt or skill.
  - `lead.md`: splits with `split-request`; no longer reads diffs: assigns the Reviewer (no task name; the instruction names `agent/<task>`, the original instruction, and the last reviewed commit on a later round), routes the findings to the developer, assigns the Reviewer again after the fixes, releases the developer when nothing blocking remains; without a Reviewer, runs a `branch-reviewer` itself; asks `scout` for facts; `checkpoint` on a long request; its report ends with *ce qui a frotté*.
  - `dev.md`: `tdd`, `diagnose`, `verify-before-report`; the report says what was checked and what was not, and ends with *ce qui a frotté*.

- [ ] **Step 3: Root `CLAUDE.md`**, a short section *Dans une équipe forge* (under Conventions → Tests): in a team container only `npm test`, `npm run check` and lint run (no Incus: no `FORGE_INTEGRATION=1`, no `ansible/tests/vm-test.sh`), and reports say so; the first sub-task of a request commits the Pilot's design under `docs/superpowers/specs/`.

- [ ] **Step 4: `README.md`**: the reference config gains `"read-repos"` on the Pilot and a `reviewer` role (`{ "memory": "1GiB", "capabilities": ["repo", "read-team"], "talkTo": ["lead"] }`); the text lists the reference roles (`lead`, `dev`, `reviewer`), says the Pilot reads every team's repository, that a reference member gets skills and sub-agents, and that the Pilot's and the Leads' memories live on the host under `~/memories/<container>`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add container/CLAUDE.md teams/reference/prompts CLAUDE.md README.md
git commit -m "docs: les règles des sous-agents, les prompts de l'équipe de référence, la section équipe du CLAUDE.md"
```

---

### After the tasks

- [ ] **Manual check on a test host** (the maintainer runs the commands; unit tests use a fake `incus`): with the reference team (Pilot `read-repos`, Lead, two developers, Reviewer), `forge team up`, then in the Pilot: `ls /workspace/depots`, `ls ~/.claude/skills ~/.claude/agents`, `/agents` in Claude Code lists `scout`; in the Lead: a file written in the memory directory appears on the host under `~/memories/agent-<team>-lead`, and a new session still writes its transcript under `~/.claude/projects/-workspace/`; in a developer: `cat ~/.claude/settings.json` shows `"autoMemoryEnabled": false`.
- [ ] **Pull request** `--base main`, title `feat: l'équipe de référence : skills, sous-agents, Reviewer, un Pilote qui lit le code, une mémoire par rôle`, body linking the spec; scan `origin/main..HEAD` with betterleaks before pushing.
