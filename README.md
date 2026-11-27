# agent-forge

Run Claude Code agents on tickets, in sealed Incus system containers, one container
per agent, on a hardened host that you reach from your own machine with
[Herdr App](https://herdr.dev).

```
your machine                     host (a VM)                          containers
┌──────────────────────┐  ssh    ┌───────────────────────────┐        ┌──────────────────────┐
│ Herdr App, hc        │───────▶ │ forge, Incus              │ incus  │ agent-control,       │
│ git, ssh (your key)  │         │ Claude token, mirrors     │──────▶ │ agent-executor-<n>:  │
│ Ansible (provisions) │◀─────── │ ~/workspaces/<container>  │  exec  │ Claude Code, hc, …   │
└──────────────────────┘  fetch  └───────────────────────────┘        └──────────────────────┘
```

- **The host** is an Ubuntu 26.04 VM that `ansible/site.yml` provisions and
  hardens: a cloud VM or a LAN machine (remote mode), or a Lima VM on your own
  Mac or Ubuntu machine (local mode).
- **The containers** hold no SSH key and no GitHub credential. The host clones
  and fetches with your forwarded SSH agent; agents commit locally and never
  push. You fetch their work from your machine (`forge fetch`), review it, then
  `forge ship` signs it, pushes it and opens the PR.
- **A project** is declared in the host's configuration: its repositories, a
  number of executors and a folder of tickets, written as Markdown files. An
  orchestrator, in its own control container, hands each ready sub-task of a
  ticket to a free executor as a mission, on a branch of its own. Every
  container is a machine in Herdr App, with its own terminal that survives
  your laptop closing.

The [security model](#security-model) says what this protects against and
what it does not.

## Choose your setup

| | Local | Remote |
|---|---|---|
| Where the host runs | A Lima VM on your Mac (Apple Silicon) or Ubuntu machine | A cloud VM or a machine on your LAN |
| Best for | Trying agent-forge, working on one machine | Agents that keep running while your laptop is off |
| Guide | [Quick start: local](#quick-start-local) | [Remote host](#remote-host) |

Both are one command, `forge install`, run from a checkout of this
repository on your machine. It provisions the host, logs Claude Code in and
builds the image, then opens herdr (the TUI, `forge open`).

## Quick start: local

About an hour, most of it waiting for the playbook and the image build. The
VM takes 4 CPUs, 6 GiB of memory and a sparse 60 GiB disk (about 11 GiB used
after the first image build); change them with `limactl edit`.

Validated on an Apple Silicon Mac. The Ubuntu 24.04 path is
**not yet validated** on a real machine: report what breaks.

### 1. Install the tools on your machine

**macOS:**

```bash
brew install lima ansible
```

**Ubuntu 24.04:** Lima runs its VMs with QEMU and KVM. Lima itself comes from
its release archive (2.1.2 or newer, see https://github.com/lima-vm/lima/releases),
and Ubuntu's own ansible is too old:

```bash
sudo apt install qemu-system-x86 qemu-utils ovmf pipx   # ovmf: the UEFI firmware Lima boots the VM with
sudo usermod -aG kvm "$USER"          # then log out and back in; /dev/kvm must be writable
curl -fsSL https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-x86_64.tar.gz \
  | sudo tar -C /usr/local -xz
pipx install ansible-core             # 2.20 or newer
```

Install Herdr App and its `hc` from https://herdr.dev. `forge team up` needs
an `hc` of the 0.x line, no older than the minimum forge names
(`HC_MIN_VERSION` in `cli/lib/hc.ts`; `hc --version` shows yours): Herdr
App's own updates within 0.x are fine. It refuses to add machines to Herdr
App with an older `hc`, a 1.x or later one, or an `hc --version` it cannot
read, and says what to do. `forge open` also needs the herdr TUI.

**Both:** you need git, and an SSH key that GitHub accepts, loaded in the
agent that ssh uses for `github.com` (`ssh-add -L` lists it). The host clones
your repositories with it, through agent forwarding. If that key lives in
another agent (a hardware key's, a password manager's), point `IdentityAgent`
at it in your `~/.ssh/config`, in a `Host github.com` block.

### 2. Install

```bash
git clone https://github.com/la-fabrique-ai/runtime.git
cd runtime
./cli/forge install
```

With no option, and no host installed yet, `forge install` sets up the local
VM `forge-local`. It never installs anything on your machine: when a tool is
missing it prints the command to run and stops. Run it again afterwards.

It asks little:

- which key is your GitHub key, only when your agent holds several (it uses
  the agent ssh uses for `github.com`);
- whether to add `Include config.d/agent-forge.config` at the top of
  `~/.ssh/config`, so that ssh reads forge's own file. It is not asked when an
  `Include` there already reads that file for every host
  (`Include config.d/*` at the top, or `Include ~/.ssh/config.d/*.config`
  under `Match all` or `Host *`) and forge's values are in effect. Settings
  placed before such an `Include` win over forge's (ssh keeps the first value
  it reads), so forge checks what `ssh -G` resolves for the alias, names each
  setting of yours that wins, and then asks;
- whether to link `~/.local/bin/forge` to the checkout, so `forge` works from
  anywhere (a refusal is asked again on every run);
- whether to turn Herdr App's telemetry off in
  `~/.config/herdr-app/settings.json` (`"telemetry": false`, the other settings
  of that file kept; a refusal is asked again on every run);
- while Herdr App runs, whether to copy the layout it shows, when the app ships
  that layout and it has no forge bar (a refusal is asked again on every run);
- the Claude token, once: run `claude setup-token` on your machine and paste
  the token it prints (it is not echoed). The token lasts a year, covers model
  requests only and is revocable in claude.ai.

In between it does, in order:

1. checks the prerequisites;
2. creates and starts the Lima VM from `ansible/lima/forge.yaml` (plain mode:
   no shared folder, no port forwarding besides SSH on `127.0.0.1:60022`, or
   a free port if that one is taken; workspaces live inside the VM);
3. writes the host's inventory, once, and runs the playbook from the checkout
   (see the table below);
4. writes the SSH alias `forge-local` to `~/.ssh/config.d/agent-forge.config`,
   a file that is forge's own, with forge's own `known_hosts`
   (`~/.config/agent-forge/known_hosts`);
5. gives the host your git identity (`user.name`, `user.email`), the one the
   agents' commits carry;
6. stores your Claude token on the host, unless it is already there
   (`~/.config/agent-forge/claude-token`, mode 600); every new container gets
   its own copy, as a file only the agent can read;
7. runs `forge setup` there: forge's Incus objects, the egress proxy and its
   allowlist when Incus is recent enough (see
   [Strict egress mode](#strict-egress-mode));
8. builds `agent-base` (about 10 minutes) when it is missing or older than the
   checkout's image inputs;
9. turns Herdr App's telemetry off, if you say yes: it is a setting of your
   machine's app, not of the host; and, if the layout Herdr App shows is one it
   ships, copies it so that the forge bar can anchor there (see
   [the forge mod](#see-the-project-take-a-hand));
10. prints a summary and opens herdr (the TUI).

What step 3 writes and replays, under `~/.config/agent-forge/hosts/<name>/`
(`<name>` is `forge-local` for the local VM):

| What forge install changes | Written | Your edits | Replayed |
|---|---|---|---|
| `inventory.yml`, the host's inventory | Once, at the first install | Kept | The playbook runs again on every `forge install` of a finished host, and on a resume after a failure when either inventory changed since the last deployment (for a cloud host, the playbooks of the host and of its relay) |
| `relay-inventory.yml`, the relay's inventory (a cloud host has a relay) | Once, at the first install | Kept | Same as the host's inventory: the playbooks (the relay's too) run again, whichever of the two files you edited, including after a run that failed at the relay step |

After editing an inventory, run `forge install` again (`forge install --host
<name>` for a remote host).

A run that fails stops with the step to fix; run `forge install` again and it
resumes. `forge install` refuses a `forge-local` Lima VM or a `Host` entry it
did not create, and says what to remove.

With a touch-to-use hardware key, a first install asks for about a dozen
touches: one per SSH connection. Once installed, one touch opens a connection
that every later command reuses for 8 hours after its last use
(`forge install --ssh-persist 2h` changes the duration). `forge team up` and
`forge team sync`, which forward your agent, open their own connection: one
touch each.

#### What `forge install` changes on your machine

| Path | What | Mode | Asked |
|---|---|---|---|
| `~/.config/agent-forge/hosts.json` | The hosts this machine installed | 0600 | No |
| `~/.config/agent-forge/hosts/<name>/` | Per host: `inventory.yml`, the generated inventory, and for a cloud host `relay-inventory.yml`, its relay's, both written once (your edits are kept; they apply when you run `forge install` again, `forge install --host <name>` for a remote host, which replays the playbook), and `forge-key.pub`, the public half of your GitHub key | 0700; 0600 and 0644 | No |
| `~/.config/agent-forge/known_hosts` | forge's own `known_hosts`: the hosts' keys, for the alias and for Ansible | Written by ssh | No |
| `~/.local/share/agent-forge/collections` | The Ansible collections the playbook needs | Written by `ansible-galaxy` | No |
| `~/.ssh/config.d/agent-forge.config` | forge's own SSH file: one block per host, rewritten on every run | 0600; 0700 for a directory forge creates | No |
| `~/.ssh/forge-cm/` | The sockets of the shared SSH connections (see `ControlMaster` below) | 0700 | No |
| `~/.ssh/config` | One line at the top, `Include config.d/agent-forge.config`, and a blank line before your own first line, only when no `Include` there reads forge's file for every host with forge's values in effect. Nothing else changes | Kept; 0600 if forge creates it | Yes |
| `~/.config/herdr-app/settings.json` | `"telemetry": false`, the file's other settings kept; a file that is not a JSON object is left alone | 0644 if forge creates it | Yes |
| `~/.local/bin/forge` | A link to the checkout's `cli/forge` | A link | Yes |

forge creates `~/.config/agent-forge` 0700. A `~/.ssh/config.d/agent-forge` that
an earlier forge wrote (it starts with forge's header line) counts as forge's
own, and is removed once ssh reads the new file: until then it keeps the alias
working. Any other file of that name stays.

forge's SSH file, for `forge-local`:

```
# Managed by forge install: edits are overwritten.

Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.config/agent-forge/known_hosts
  IdentityFile ~/.config/agent-forge/hosts/forge-local/forge-key.pub
  IdentitiesOnly yes
  ForwardAgent yes
  ControlMaster auto
  ControlPath ~/.ssh/forge-cm/%C
  ControlPersist 8h
```

- forge writes your home's full path where this shows `~`.
- `HostKeyAlias` and `accept-new`: the VM's port and host key change when it
  is recreated, so its key is pinned under a stable name. A remote host's
  block has neither: OpenSSH asked about its key at the first connection.
- `IdentityFile` names the public half of your GitHub key, which stays in
  your agent; `IdentitiesOnly` offers only that key.
- An `IdentityAgent` line comes before `ForwardAgent` when your ssh uses
  another agent than `SSH_AUTH_SOCK`'s for `github.com`.
- `ControlMaster`, `ControlPath`, `ControlPersist`: one connection per host,
  shared by forge's commands and herdr, opened by the first and kept for the
  time `ControlPersist` says (`forge install --ssh-persist` sets it). While it
  lives, a program running under your account can open sessions on the host
  without a touch. Signatures with your forwarded agent still ask for one each.
- `ForwardAgent yes`: the host clones and fetches your repositories with your
  agent. Containers never get it. forge's own commands turn it off, except
  `forge team up` and `forge team sync`, which keep out of the shared
  connection: OpenSSH forwards the agent through it only if the command that
  opened it did.

The tools write their own files: Lima keeps the VM in `~/.lima/forge-local`
(and its SSH key, which the inventory uses, in `~/.lima/_config`), and
Ansible its own in `~/.ansible`.

#### To undo

Fetch the work you want first: the local VM's workspaces live inside it.

```bash
limactl stop forge-local                 # if it is running
limactl delete forge-local
limactl prune                            # Lima's cache of downloaded images, for every VM
rm -r ~/.config/agent-forge ~/.local/share/agent-forge
rm ~/.ssh/config.d/agent-forge.config
rm ~/.local/bin/forge                    # if it is forge's link
```

`~/.config/agent-forge` also holds `known_hosts.old`, which `ssh-keygen -R`
leaves when forge forgets a VM's keys. Then remove what forge added to your
own files, if it did: the `Include config.d/agent-forge.config` line at the
top of `~/.ssh/config` (and an `Include config.d/agent-forge` line left by a
pre-release run, with `~/.ssh/config.d/agent-forge` if it is still there),
and `"telemetry": false` in `~/.config/herdr-app/settings.json` if you
said yes. Herdr App's machines named `forge-local-…` go with
`hc machine rm <name>`. A remote VM is deleted at your provider. `~/.lima/_config` and `~/.ansible` belong to
Lima and Ansible, which may use them for other things.

### 3. Set up a project

A host serves one **project**: its repositories, a number of execution
containers (the **executors**), and a folder of tickets. It lives in the host's
`~/.config/agent-forge/config.json`, next to the settings of
[Configuration](#configuration):

```json
{
  "project": {
    "repositories": {
      "web": { "repo": "acme/widgets" },
      "api": { "repo": "acme/widgets-api" }
    },
    "executors": { "count": 2, "memory": "2GiB" },
    "tickets": { "base": "~/.local/share/agent-forge/tickets", "prefix": "T" }
  }
}
```

That is three containers: `agent-control`, the **control container**, where
the orchestrator runs as its own user (`forge-orch`) and keeps the ticket base;
and `agent-executor-1` and `agent-executor-2`, which each hold a clone of every
repository under `/workspace/<repository>`. One host serves one client: never
put two clients' repositories in the same project. Give the executors a
`memory`: without one, each container gets the profile's 75% of the host's
memory, and a few of those add up to more than the host has. These 2 × 2 GiB,
plus the control container's profile limit, are what `forge team converge`
adds up, and it warns when they exceed the host's memory minus what the host
keeps for itself (640 MiB by default). Create them from your machine:

```bash
forge team up
```

It checks that your `hc` is the pinned version, converges the project on the
host (the mirrors of each repository, with your forwarded SSH agent; the
missing containers, created; the stopped ones, started; every container's
files, the orchestrator included, brought up to date), then adds each
container as a machine of Herdr App, named `<host>-<container without agent->`
(for example `forge-local-executor-1`). Open Herdr App: every container is a
machine, and an executor's terminal shows its current mission. A machine of a
container that left the configuration is removed at the next `forge team up`;
machines you added yourself are never touched. `forge team up` is also what
starts the host's containers again after the VM was stopped. `forge team
converge` never deletes a container: lowering `count` leaves the extra
executors, reported, for you to delete once their work is fetched.

Each repository has two bare mirrors on the host: the **origin mirror**, a copy
of GitHub that `forge team sync <repository>` refreshes (it needs your SSH
agent), and the **agents' mirror**, which holds the branches the executors
hand back. Inside an executor, `origin` is the first and `team` the second,
both read-only.

Executor settings: `count` (1 to 16), `memory`, `cpu`, `strict` (their egress
is [strict](#strict-egress-mode)), `plugins` (Claude Code plugins,
`<name>@claude-plugins-official`) and `env` (a [`.env`](#executors-have-a-env)
file). A repository takes `lfs` (see [Large files](#rules-for-getting-work-back)).
`gitIdentity` (`{"name": …, "email": …}`) is the commits' identity, the host's
otherwise.

#### Write tickets

The ticket base is a folder on the host (`project.tickets.base`), mounted into
the control container. It is plain Markdown: one folder per ticket, named by
its id (`<prefix>-<n>`, such as `T-1`), with a `ticket.md` and one file per
sub-task under `subtasks/`. Each file is a header of `key: value` lines, a
blank line, then the text:

```
T-1/ticket.md
id: T-1
title: Reject an empty password
status: dev
priority: 2
repositories: web:main

The login form accepts an empty password. …

T-1/subtasks/1.md
id: T-1.1
repository: web
position: 1
rank: 1
status: ready
kind: implementation
fixes:
reason:
branch:
pr:

Refuse an empty password in the form's validation, with a test.
```

A ticket's `status` is one of `todo`, `spec`, `dev`, `qa`, `human-review`,
`pr-review`, `done`, `cancelled`; `priority` goes from 1 (most urgent) to 4,
0 for none; `repositories` lists `<repository>:<base branch>`. A sub-task's
`status` is `ready`, `in-dev` or `done`; `position` is its place in its
repository's stack, `rank` its place in the ticket.

The orchestrator looks at the tickets in `dev`, most urgent first. For each, it
takes the sub-task of lowest `rank` that is not `done`; when that one is
`ready` and an executor is free, it sets it `in-dev` and hands it to the
executor as a **mission**: a fresh Claude Code session in the repository's
clone, on a branch `agent/<sub-task>` (`agent/T-1.1`). The first sub-task of a
repository starts from the ticket's base branch (`origin/main`); the next one
is stacked on the branch of the one before it (`agent/T-1.1`). The executor
commits, has its branch reviewed by a sub-agent, then runs `forge-team done`:
the host checks that the branch has commits beyond its base, copies it to the
agents' mirror and records it; the orchestrator sets the sub-task `done`,
frees the executor, and moves on. When every sub-task of the ticket is `done`,
the ticket goes to `qa` (see QA below). Several tickets advance in parallel,
one executor each. A ticket lists one repository for now: one with several
gets no QA. The pull requests of a ticket come in a later part: `forge ship`
still ships one sub-task's branch.

#### Open a ticket with the Pilot

You create a ticket by writing its `ticket.md`, with the `status: todo`, the
repositories and what you want. Then, from your machine:

```bash
forge pilot T-1            # --fresh: in a new session of the Pilot (between two tickets)
```

It refreshes the origin mirrors with your forwarded SSH agent, brings the
Pilot's clones up to date from them, starts the **Pilot** if its session does
not run, and tells it you open `T-1`. The Pilot
is a Claude Code session in the control container (its `agent` terminal: open
it in Herdr App, or with `forge open`); `forge team up` starts it too. It
reads the code in its own clones, asks you its questions in rounds, each with
the answer it proposes, and writes three files in the ticket's folder:
`spec.md` (the spec), `answers.md` (your answers) and `split.md` (the split it
proposes). Once you agree with the spec and the split, it creates the
sub-tasks, in order, and sets the ticket `dev`: the orchestrator takes it from
there. Nothing goes to development before you agree. Each mission gets a
read-only copy of these files (`/etc/forge/mission/` in the executor), and the
developer reads them before the code.

Only you write into the Pilot's session (`forge pilot`, and what you type):
no developer and no orchestrator message reaches it. It reaches the tickets
only through a few verbs of the orchestrator (read a ticket, write its mission
files, create its stack, answer a request), never the files themselves.

#### Questions

A developer with a doubt that blocks it first asks a sub-agent of its own
container, `spec-reader`, which reads the mission files and the code and
answers with its source (a passage of the spec, a file and line), or says the
spec does not settle it. It never guesses. When it settles the question, the
developer goes on, and its report lists the question, the answer and the
source. When it does not, the question goes to you: the developer commits its
work in progress and runs `forge-team ask`, the host takes its branch back,
and the orchestrator opens a **request** in the ticket, releases the executor
and sets the sub-task `ready`. The ticket then waits (no mission, no `qa`),
while its executor takes other tickets. A waiting request is a file
`requests/<n>.md` in the ticket's folder, without its `requests/<n>.answer.md`;
it may carry the answer the developer recommends. Answer it by telling the
Pilot (it shows the request and writes your answer, in your words), or by
writing that answer file yourself. At its next turn the orchestrator hands the
sub-task out again, as a mission that resumes, with every answer given so far.
Nothing a developer writes reaches the control container.

A developer ends its mission with a report (what it did, what it checked, what
stays doubtful, the questions settled without you), which the ticket keeps as
a comment: its terminal does not.

#### QA

When every sub-task of a ticket is `done`, a free executor tests the top of its
stack, which holds the whole ticket: a **QA** mission, on a detached commit,
that runs the project's checks and exercises what the ticket changes, as a user
would, then reports a verdict and a list of defects. QA takes free executors
before development does: finishing a ticket comes before starting one. Each
defect becomes a **fix**, a sub-task on the branch of the sub-task it belongs to
(or, when it belongs to none, a new sub-task on top of the stack); the ticket
goes back to `dev`. Once a fix is done, the sub-tasks above it are **rebased**
one by one, each by a mission that replays its own commits onto the branch
below, then the QA runs again. Before any QA, a stack whose base moved (a
commit on `main`) is rebased first. A clean QA sends the ticket to
`human-review`. The QA's report is kept in the ticket.

#### Your review

`forge team status` lists the tickets under way and says which wait for an
answer; a ticket in `human-review` waits for you. `forge fetch` brings its
branches to your clone. Tell the Pilot your review (`forge pilot <ticket>`):
it sorts each point with you (a fix of a sub-task, a new sub-task, or a new
ticket for what does not hold this one), and creates them only once you
agree. Any fix sends the ticket through development, the rebases and the QA
again before it comes back to you.

#### Executors have a `.env`

`"env": "<path on the host>"` on `project.executors` names a dotenv file;
`forge team converge` pushes it into each executor
(`/home/aiuser/.config/forge/env`, mode 600) and removes it when the key goes.
`forge-agent`, which starts the agent, exports its variables to the agent's
process only, never to the container's other programs. Use it for a tool's
token or settings.

```
# one KEY=VALUE per line; `#` comments; an optional `export `
DEMO_GREETING=bonjour
```

The file is parsed, never executed: a value is the rest of the line as text (one
pair of surrounding quotes is removed), with no `$` expansion, no escapes and no
multi-line value, so `$(…)` stays literal. `CLAUDE_CODE_OAUTH_TOKEN`, `HOME`,
`PATH`, `USER` and every `FORGE_…` name are refused. The file must exist and not
be readable by group or others (`chmod 600`), or `converge` stops. **Its values
reach the agent and every command it runs, in clear.**

#### See the project, take a hand

```bash
forge team status          # each container: its mission (dev, rebase or qa), its session; the orchestrator's state; the tickets (--json for a program)
```

Under the table, `TICKETS` lists the tickets under way (from `spec` to
`pr-review`), most urgent first, with how many answers each waits for
(`tickets: unavailable` when the orchestrator does not answer). Then
`PROBLEMS` lists what the orchestrator could not do at its
last turn (an assign the host refused, an unreadable ticket, a free executor
whose state is unknown), read from the orchestrator itself;
`orchestrator's problems: unavailable` when it does not answer.

The orchestrator decides alone. When you need to step in, `forge team assign`
and `forge team release` are your hand on an executor, without the
orchestrator and without its checks on the tickets (the host still refuses a
busy executor, or a sub-task another executor holds):

```bash
forge team assign agent-executor-1 T-1.1 --repository web <<'EOF'
Refuse an empty password in the form's validation, with a test.
EOF
forge team release agent-executor-1
```

`--repository <name>` and `--base <ref>` (`origin/<branch>`, or
`agent/<sub-task>` to stack) say where the sub-task works and what its branch
starts from. Each one left out comes from the branch's record when the
sub-task was handed out before; else the repository is the project's only one
(with several, `--repository` is required) and the base is `origin/main`.
Both commands are journaled under the caller `human`, refusals included. A
release stops the session; the branch and the clone stay, and a later mission
of the same sub-task resumes them.

`forge install` also copies a **forge mod** into Herdr App's mods directory
(`~/.config/herdr-app/mods/forge/`, replaced at each run). It is a one-line bar
at the bottom of Herdr App (a mod runs only where it is shown): how many
executors work, wait or are free on each installed host, an orchestrator that
is not active, a host that does not answer; it also names each agent's space
after its container. It reads `forge team summary --json`, one call at a time,
at most every 30 seconds.
The bar needs a layout of its own: Herdr App ships its layouts (`main`, …) and
takes no new block in them. When the layout shown is one of those, `forge install`
offers to copy it (`herdr-app do layout.clone '{"name":"main","as":"forge"}'`,
asked while Herdr App runs): the copy is yours, and the app never updates it
again. Restart Herdr App if the bar does not appear by itself.
Check the mod with `herdr-app check ~/.config/herdr-app/mods/forge`.

`forge open` still opens the herdr TUI on the host, for as long as it is kept.

### 4. Get the work back

On your machine, in your own clone of one of the project's repositories (not in
the VM):

```bash
forge fetch
```

The first run asks the host which repository of the project this clone is,
adds a git remote named after it (`forge-web`) that points at the host's
agents' mirror, and says so, then fetches the `agent/*` branches the executors
handed back, without tags. The host serves the mirror and never runs git in an
agent's workspace. `forge fetch` also refreshes `origin` and lists each
sub-task with its commit count and the branch it started from:

```
Fetching forge-web…
Fetching origin…
agent/T-1.1  3 commits on origin/main
agent/T-1.2  2 commits on agent/T-1.1
```

If the project has no such repository, it says so, naming the host. A
single-agent remote from before teams (`agent-acme-widgets`) is left in the
clone, and said once.

Review the branch against that base, then ship it:

```bash
git log -p origin/main..forge-web/agent/T-1.1
forge ship T-1.1
```

A stacked sub-task is reviewed against the one it started from:
`git log -p forge-web/agent/T-1.1..forge-web/agent/T-1.2`.

`forge ship <sub-task>` re-signs the agent's commits that are not on GitHub yet
with your own git signing configuration, pushes `agent/<sub-task>` and opens
its pull request (or finds the one that exists). It fetches again first, then
lists every commit it will sign, sub-task by sub-task, and asks once before
signing: the agent may have committed since your review. It replays the
commits in a temporary worktree, so your checkout is never touched, and runs no
git hook there: the tree is the agent's. It never force-pushes: if GitHub's
`agent/<sub-task>` moved since the fetch, it stops and asks you to run `forge
ship` again, and a conflict stops it at the commit it names. Each signature
may need a touch of your key. A sub-task whose pull request is already merged
ships new commits only after a confirmation, as a new pull request.

A stacked sub-task ships its whole chain, bottom first: shipping `T-1.2`,
based on `agent/T-1.1`, pushes `agent/T-1.1` then `agent/T-1.2`, and the pull
request of `T-1.2` targets `agent/T-1.1`.

`forge ship` needs the GitHub CLI, installed and logged in on your machine
(`gh auth login`). `--host <name>` picks the forge host when you have several.

### The local VM day to day

- `limactl stop forge-local` / `limactl start forge-local`. Agents stop with
  the VM; after a start, `forge team up` starts the containers again, and the
  orchestrator hands the missions out again (a lost session is resumed on its
  branch).
- To start over: fetch every branch you want first (workspaces live in the
  VM), then `limactl delete forge-local`. The next `forge install` offers to
  forget the old VM and installs a new one.

## Remote host

The same install, on a VM that you create:

1. **The VM.** Ubuntu 26.04, at least 2 vCPU, 4 GB of memory and a 40 GB disk
   (more for several agents), with an admin account that has passwordless
   sudo and that your key can log in to (`ubuntu` on most cloud images). Let
   SSH (port 22) through the provider's firewall.
2. **The install**, from a checkout, with the VM's address:

   ```bash
   ./cli/forge install --remote 203.0.113.10
   ```

   The prerequisites are the local ones, without Lima. It asks:
   - the host's name, `forge-<name>` (as `forge-acme`), which is also its SSH
     alias;
   - the admin account (default `ubuntu`);
   - the exposure: `public` for a cloud VM, `lan` for a machine on your
     network;
   - your forge user on the host (default: your login on this machine);
   - the key the admin account accepts: your GitHub key, or a private key
     file.

   Then it follows the steps of the local install. The first connection shows
   OpenSSH's own host-key question: check the fingerprint with your provider
   before you answer. If that first connection never succeeds, the next
   `forge install --host forge-acme` offers to retry or to forget your
   answers. An admin account with a sudo password, or other playbook options:
   see "Installing by hand" in `ansible/README.md`.

`forge team up --host forge-acme` builds its project, `forge open --host forge-acme` opens herdr on it, and
`forge fetch --host forge-acme` fetches its work (step
[4](#4-get-the-work-back)). With several hosts installed, `forge open` asks which one. `forge install`
with no option goes to `forge-local` when it is listed, and asks which host
only when just remote hosts are listed.

## Daily use

### Herdr App

Each container is a machine of Herdr App, named by `forge team up`. An
executor's terminal is its own `hc` session on the host: it keeps running when
you close the app, and in remote mode while your laptop sleeps (in local mode,
while the VM runs). Herdr App reaches a container through `forge hc-via`, which
runs `forge hc-exec` on the host over your shared SSH connection: a byte pipe
that carries no secret, and that serves only the project's containers.

### Commands

Run on your machine, from the checkout (or through the `~/.local/bin/forge`
link):

| Command | What it does |
|---|---|
| `forge install [--remote <address>] [--host <name>]` | Install or update a host: the local VM by default, a new remote VM with `--remote`, an installed host with `--host` |
| `forge open [--host <name>]` | Open the herdr TUI on a host |
| `forge team up [--host <name>]` | Converge the project on the host (with your SSH agent forwarded), then add each container as a Herdr App machine |
| `forge team assign <executor> <sub-task> [--repository <name>] [--base <ref>]`, `release <executor>`, `status [--json]`, `sync <repository>` | The same commands as on the host, over SSH; `assign` reads the instruction on stdin |
| `forge team summary --json` | Every installed host's executors, one line of JSON (what the Herdr App bar reads) |
| `forge fetch [--host <name>]` | In your clone: fetch the executors' branches from the agents' mirror and list the sub-tasks (needs no `gh`) |
| `forge ship <sub-task> [--host <name>]` | In your clone: re-sign, push and open the PR; needs `gh auth login` |

Run on the host, over `ssh`:

| Command | What it does |
|---|---|
| `forge team converge` | Create the missing containers of the project, start the stopped ones, bring every container's files and the orchestrator up to date, and list them; a container the configuration no longer declares is reported and left alone |
| `forge team assign`, `release`, `status`, `sync` | Give an executor a sub-task (your hand, without the orchestrator), free it, show each container's mission and session and the orchestrator's state, refresh a repository's origin mirror |
| `forge list` | Every container: repository, mode, egress, state, image build |
| `forge stop [<owner/repo>] [--force]` | Stop a container; refused while a task has uncommitted changes, unless `--force`. Commits are not checked: fetch them first |
| `forge delete [<owner/repo>] [--force]` | Delete a single-agent container, with the same guard. Its workspace and the host's mirror stay |
| `forge egress [<owner/repo>] [strict\|open]` | Show or switch a stopped container's egress |
| `forge egress log [<owner/repo>]` | The egress proxy's recent requests |
| `forge image build` | Rebuild `agent-base` |
| `forge completion bash` | Bash completion (already installed on the host by Ansible) |

A bracketed argument left out is asked for, as a numbered menu.

`forge start`, `forge attach`, `forge resume` and `forge finish`, and the herdr
tabs, popups and key bindings that went with them, are gone, and so are the
teams that replaced them (see [Release notes](#release-notes-the-ticket-driven-model)).
A host set up before keeps its single-agent containers, which `forge list`,
`stop`, `delete` and `egress` still manage; `forge setup` removes the old
key-bindings block once from the host's herdr config.

### Executors and the host

Each container of the project gets a channel to the host: a Unix socket,
`/var/lib/forge/api.sock` in its container, in a directory of root. In an
executor only `aiuser` (the agent) can open it; in the control container only
the orchestrator's user, `forge-orch`, can, and the agent's own user cannot read
the orchestrator's state or the ticket base. The host side is `forge api
serve`, a systemd user service of the forge user that Ansible installs and
`forge team converge` restarts.

The orchestrator assigns, releases and reads the executors' state through it.
An executor has two verbs, through the command `forge-team`:

| Command | What it does |
|---|---|
| `forge-team done` | The mission is finished: the host checks that `agent/<sub-task>` has commits beyond its base, copies it to the agents' mirror and records it |
| `forge-team status` | The mission the executor holds, or none |

The host knows who calls by the socket the request arrived on, never by what
it says. Every request that changes something, accepted or refused with its
reason, is a line of `~/.local/share/agent-forge/api/journal.jsonl` (readable
by the forge user only), and so are `forge team assign` and `release`, under
the caller `human`. A mission that holds the Claude token is refused.

### Rules for getting work back

- **Never run git yourself in `~/workspaces/<container>` on the host,** and do
  not `cd` there with a git-aware prompt. The agent controls that repository,
  hooks and `.git/config` included, and host git would run its commands as
  you. Fetch and ship from your machine, as in step 4.
- **Review agent code before running it on your machine.** Checking out an
  agent branch and running its scripts (`npm install`, test runners) runs the
  agent's code there.
- **Large files:** a repository with `"lfs": true` gives the executors its Git
  LFS files as real content: the host fetches the objects of the tip of every
  branch into the origin mirror with your forwarded SSH agent (`forge team converge`
  and `forge team sync`; it needs the `git-lfs` package, which the playbook
  installs), and the container reads them from that mirror, with no network
  and no credential. The first fetch can be large, and every copy counts: the
  mirror's `lfs/objects`, then the container's `.git/lfs/objects` and its
  working tree. The content is there for the tip of each branch; an older commit or
  a tag can give pointers. A repository without `lfs` gives pointers. Adding or changing an LFS file
  is not supported yet (the objects would not reach GitHub through
  `forge ship`). A clone takes `lfs` when it is made: changing it later does not
  convert an existing clone (delete the executor, and its workspace, once its
  work is fetched, then `forge team converge`).
- **Submodules:** not set up inside containers. The host mirrors the
  repository alone, so `git submodule update --init` fails for a relative URL
  (`../other.git` resolves to `/forge/other.git`, which does not exist), for
  an SSH URL (`git@github.com:…`, even to a public repository) and for a
  private repository (no SSH key nor GitHub credential in the container). A
  public HTTPS URL may work, egress permitting. Scripts that rely on a missing
  submodule fail in the container; the agent has to work around them.

Inside an executor, `origin` is a read-only mirror the host refreshes (with
`forge team sync <repository>`): the agent can `git fetch origin`, never push.

### Strict egress mode

By default a container reaches the internet, but not private, link-local,
CGNAT or multicast ranges (your LAN, the cloud metadata service, the host, the
other containers). Strict mode is per container: it reaches only the domains
on your allowlist, through a filtering proxy (`forge-proxy`) that
`forge setup` manages, and it fails closed: a program that ignores the proxy
reaches nothing.

- **The allowlist** is `~/.config/agent-forge/egress-allowlist` on the host,
  one domain per line (`example.com`, or `.example.com` for its subdomains
  too). `forge setup` creates it with Claude Code's own domains active and
  common ones (GitHub, npm, PyPI, Docker Hub) commented out, each with what
  it lets a hijacked agent do. Edit it, then run `forge setup` to apply it.
- `"strict": true` on `project.executors` makes the executors strict from
  their first boot.
- `forge egress <owner/repo> strict` or `open` switches a stopped container
  (`forge stop` first); `forge egress` alone shows it.
- `forge egress log` shows what was allowed and refused: use it to find the
  domain to add.
- Docker in a strict container pulls through the proxy; builds and containers
  get no proxy unless you pass `HTTPS_PROXY` to them.
- Strict mode needs Incus 7.0.2 or newer on the 7.0 LTS line, or 7.5.0 or
  newer. Zabbly's lts-7.0 channel, which the playbook installs from, has
  published 7.0.2 since October 2026, so a host provisioned now has it. On an
  older host, `forge setup` prints a notice and skips the strict objects, and
  a strict executor is refused:

  ```
  NOTICE: Incus 7.0.1 is too old for strict mode, which needs 7.0.2 or later on the 7.0 LTS line ...
  ```

  Re-run the playbook (see [Updating](#updating)) to upgrade Incus, then
  `forge setup`.

### Docker, Compose and the browser

- **Docker and Compose** run rootless inside every container, as the agent's
  own unprivileged user, for repositories that need a database or other
  services. `pre-bash.sh` blocks `--privileged`, host namespaces and bind
  mounts outside `/workspace`.
- **Chrome DevTools MCP** is configured in every container. The agent drives
  headless Chrome to check a running app: navigation, screenshots, console
  and network.

### The image

`forge list` shows `behind` in the BUILD column when a container was created
from an older `agent-base` than the latest build. After `forge image build`,
existing containers keep their image until recreated: delete the container
(`incus --project agent-forge delete <container> --force`, its workspace is
kept), then `forge team converge`.

## Updating

From your machine, in the agent-forge checkout:

```bash
git pull
./cli/forge install
```

For a remote host, `forge install --host forge-acme`. On a finished host,
`forge install` updates it: the playbook (which deploys the checkout's
`forge` and upgrades Incus within its channel), `forge setup`, and the image
build when the image's inputs changed (it asks when it cannot tell).

## Configuration

Both files live on the host and are optional; `forge setup` reads them.

- **`~/.config/agent-forge/config.json`**, with its defaults:

  ```json
  {
    "network": { "ipv4Address": "10.77.0.1/24" },
    "storagePool": "default",
    "limits": { "cpu": null, "memory": "75%", "processes": 10000, "rootDisk": "50GiB" }
  }
  ```

  - `network.ipv4Address`: the bridge's address, a /27 or wider inside
    `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`;
  - `limits`: per container. `cpu` is `null` (no limit), a number or a CPU
    set; `memory` a size or a percentage of the host's; `rootDisk` is a guard
    rail, not a hard limit.

  - `project` (optional, `null` by default): the project of
    [step 3](#3-set-up-a-project).
    - `repositories`: at least one, keyed by a name of lowercase letters,
      digits and single dashes (`web`, `api-2`), each `{"repo": "owner/repo",
      "lfs": false}`;
    - `executors`: `count` (1 to 16, required), `memory` (a size; the
      profile's limit otherwise), `cpu`, `strict`, `plugins`, `env`;
    - `tickets`: `base` (an absolute path or `~/…` on the host, a folder of its
      own, default `~/.local/share/agent-forge/tickets`; forge refuses one that
      holds your home, its config, its mirrors, workspaces or memories) and
      `prefix` (the tickets' id prefix, default `T`);
    - `gitIdentity`: `{"name": …, "email": …}`, the commits' identity.

    `forge team converge` never deletes a container: lowering `count` leaves
    the extra executors, reported, for you to delete.

    A config that still declares `teams` or `pilot` is refused: they are gone
    (see the [release notes](#release-notes-the-ticket-driven-model)).

  An unknown key or an invalid value stops forge with the file and the key.
- **`~/.config/agent-forge/egress-allowlist`**: see
  [Strict egress mode](#strict-egress-mode).

## Release notes: the ticket-driven model

The teams of agents (a lead, developers, a reviewer, a pilot that talked to the
leads) are replaced, in place, by a project driven by tickets: a control
container whose orchestrator reads a ticket base, and generic executors that
take one sub-task at a time. Nothing keeps both alive.

- **Gone:** the `teams` and `pilot` keys (a config that holds them is refused,
  with the path to follow); the roles and their capabilities and `talkTo`; the
  API's `message`, `ask-human` and team `assign`/`release` verbs, and
  `forge-team message|assign|release|ask`; the Inbox, `forge answer`,
  `forge team question|answer|watch|inbox` and the Herdr App mod's inbox,
  notifications and `forge.inbox`, `forge.watch` and `forge.sync` commands (the
  bar stays); `forge task-base <container>`; the reference roles `lead`, `dev`
  and `reviewer`, with the `split-request` and `review-branch` skills.
- **Kept:** `forge team up`, `converge`, `status` and `sync` (now
  `sync <repository>`), `forge fetch` and `forge ship` (a task is now a
  sub-task, such as `T-1.2`); `forge team assign` and `release`, as your hand
  on an executor; `forge notify` (the memory watchdog's notice, typed into an
  executor's session). The API's journal keeps its file and its ids.

To move a host from teams to a project:

1. **Ship every task first, with the old forge.** From each repository's
   clone, `forge fetch`, then `forge ship <task>` for every task you want to
   keep, and pull any work still uncommitted in a container. The team mirrors
   and the team containers are not read by the new model.
2. **Change the config on the host.** Remove `teams` and `pilot` from
   `~/.config/agent-forge/config.json`, declare a `project`, and delete the
   team containers (`incus --project agent-forge delete <container> --force`;
   their workspaces under `~/workspaces` stay until you remove them).
3. **Update forge** (`git pull`, then `forge install`, see
   [Updating](#updating)): it runs `forge setup` and builds the image, now
   with `forge-orch`.
4. **Create the project's containers:** `forge team up`.

Until `teams` and `pilot` are gone from the config, every host command
(`forge setup`, `forge install`, the API service) stops on that refusal.

## Security model

| Threat | What stands in the way |
|---|---|
| An agent escapes its container | Unprivileged container, seccomp, capability drops, Incus' AppArmor profile. It lands in the host VM, not on your machine |
| A container reaches your LAN, the cloud metadata service, the host or another container | The `forge-egress` network ACL rejects private, link-local, CGNAT and multicast ranges; IPv6 is off on the bridge |
| An agent sends code or tokens out | Accepted in the default open mode. Strict mode limits egress to your allowlist |
| An agent publishes to GitHub | No GitHub credential in containers, and `origin` is a read-only mirror; only `forge ship`, on your machine, pushes |
| An agent drives other agents' terminals | Each container has its own `hc` core; the host's `forge hc-exec` serves only the project's containers, from your SSH session, never from a container |
| An agent abuses the channel to the host | An executor's socket answers three verbs, `ask`, `done` and `status` (`ask` and `done` hand the mission back, nothing more); only the control container's, owned by the orchestrator's user, can assign or release; every request read field by field, a mission that holds the Claude token refused, every change in a journal |
| An agent edits the tickets | The ticket base is mounted in the control container only, under the orchestrator's user's home, which the agent's user cannot enter. The Pilot's session reaches it only through the orchestrator's few verbs, on a local socket executors do not have; nothing a developer writes enters the control container: a question becomes a request in the ticket, for you |
| An agent turns forge's own writes against it | A mission's writes never go as root into a folder the agent's user owns: a session's instruction is written by that user, from stdin; the mission files' copy is under `/etc/forge`, owned by root. (`incus file push` follows a symbolic link planted in the path and gives the target the owner it is asked for.) Not yet for `forge team converge`, which still pushes `CLAUDE.md`, the kit, `settings.json` and the credentials as root into the agent's home: la-fabrique-ai/runtime#196. |
| An agent reads your Claude token | The token is a file in the agent's own container (mode 600, a directory only the agent can read) and in your host's home, exported to the agent's process alone; it covers model requests only and is revocable in claude.ai. An agent can use it, so treat it as the agent's |
| SSH brute force on the host | Keys only, fail2ban (not in local mode), a connection rate limit (`public`), an optional source restriction |
| Your forwarded agent is abused on the host | Containers never receive it; a hardware key asks for a touch per use |
| A program on your machine opens sessions on the host | While the shared SSH connection lives (8 hours after its last use by default), a program under your account can open sessions without a touch; signatures with the forwarded agent still ask. `forge install --ssh-persist` shortens it |

Known limits:

- **Local mode:** the Lima VM can reach your machine's localhost and your LAN
  (containers cannot). An agent that escaped its container into the VM could
  too.
- **DNS:** a container can still tunnel data through DNS queries to the
  bridge, in both modes.
- **Strict mode** does not inspect TLS: an allowed domain that accepts uploads
  (a package registry, an API with another key) is still a way out.
- **Escape sequences:** agent output reaches Herdr App and your terminal
  (window titles, clipboard).
- The forge user on the host is root-equivalent through Incus (one user per
  VM).

## Troubleshooting

- **A container was half provisioned** (provisioning stopped midway):
  `forge team converge` reports it and leaves it alone. Delete it
  (`incus --project agent-forge delete <container> --force`; the mirror and any
  workspace stay) and run `forge team converge` again.
- **Provisioning says the security hook refuses a harmless command:** the
  image predates a change to it. Run `forge image build`, then recreate the
  container.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`** after recreating a remote VM
  at the same address: a host forge installed keeps its key in forge's own
  file. Remove the old key, then record the new one yourself:
  `ssh-keygen -R 203.0.113.10 -f ~/.config/agent-forge/known_hosts` (the VM's
  address), then `ssh forge-acme true` once in a terminal. Check the
  fingerprint OpenSSH shows against your provider's console and answer yes:
  the alias and the playbook's admin connection read the same file, and
  nothing else records the key. Then `forge install --host forge-acme`. For
  the local VM, `forge install` handles it when it recreates the VM.
- **The host cannot clone** (`Permission denied (publickey)` or
  `Error connecting to agent`): the agent is not forwarded. Check
  `ForwardAgent yes` and `IdentityAgent` in your SSH config, and that you are
  attached: with no client attached, the host has no agent.
- **`forge team up` refuses your hc:** your `hc` is missing, older than
  forge's minimum, of a line after 0.x, or prints a version forge cannot
  read. Do what the message says (update herdr-core from https://herdr.dev,
  or update forge for a newer line), then run it again: the machines are
  added at that second run.
- **`herdr --remote` fails the first time:** run it in a real terminal; it
  asks before installing herdr on the host.
- **A clone stops on `smudge filter lfs failed`** (a repository with Git LFS
  files, without `lfs`): the container was provisioned by an older
  forge, whose git-lfs configuration downloads LFS objects the mirror does not
  hold. Fix it once on
  the host with
  `incus --project agent-forge exec <container> -- su - aiuser -c 'git lfs install --skip-repo --skip-smudge'`,
  or recreate the container (the workspace is kept).
- **A repository whose default branch is not `main`:** give it as the base of
  the ticket's repository (`repositories: web:develop`): a ticket's first
  sub-task starts from `origin/<base>`.
- **`forge setup` warns that forge runs directly on this machine:** you ran it
  outside a VM. Use the Lima VM: nothing would stand between an escaped agent
  and your machine.

## Developing agent-forge

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and install the
  secret-scanning pre-commit hook once with `npm run hooks:install`.
- `npm test` (unit, contract and bash tests), `npm run check` (types),
  `npm run test:ansible` (the playbook's unit tests) and
  `ansible-lint ansible/`.
- `FORGE_INTEGRATION=1 npm run test:integration` runs against a real,
  throwaway Incus.
- An agent can develop agent-forge on its own AWS VM, as a contributor: see
  [docs/contributor-model.md](docs/contributor-model.md).
- `ansible/tests/vm-test.sh` provisions a fresh machine twice, verifies it,
  reboots it and verifies again: `--lima` for a throwaway Lima VM, `--host`
  for a fresh cloud VM, or a VM on an Incus host with KVM. See
  `ansible/README.md`.
- Designs and plans live in `docs/superpowers/`.

## License

Copyright (C) 2026 the agent-forge contributors.

agent-forge is free software, licensed under the GNU Affero General Public
License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
