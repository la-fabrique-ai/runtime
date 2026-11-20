---
name: split-request
description: "Use when you receive a request or a design to deliver, before assigning any developer: split it into pull requests a human can review well."
---

# Split a request into sub-tasks

A sub-task is one developer's piece of work and gives one pull request, which the developer builds in successive commits a human reads one by one. The goal is a careful human review of each pull request, not small tasks: split only when one pull request would be too big for that review, and stack (step 4) to keep dependent work split.

1. Get the facts you need from `scout` sub-agents (where the code lives, how parts connect). Do not read many files yourself.
2. Keep the request in one sub-task while its pull request stays reviewable in one sitting: one concern, a diff a human reads at once (as a rough guide, a few hundred changed lines, tests included). Split it when it would not, or when it mixes concerns: each sub-task then gives one such pull request, and a sub-task that needs another's code stacks on it (step 4). Each sub-task costs you an assignment, a review and a release: do not split further than the review needs.
3. Make each instruction self-contained, since the developer sees nothing else: the goal, the files or modules involved, the constraints, what to verify, what not to do.
4. Order dependent sub-tasks one after another, with the same developer: when B needs A's code, B starts from A's branch. Once A is reviewed with nothing blocking and its developer released, give B to that developer with `forge-team assign <developer> <B> --from <A>`: forge creates `agent/<B>` from `agent/<A>` (it refuses `--from` for anyone else, who does not have A's branch), and B's pull request stacks on A's. You do not wait for A to be merged. Independent sub-tasks run in parallel, each from `origin/main`.
5. Never create more sub-tasks at once than there are free developers (`forge-team status`).
6. Give each a short lowercase-dash task name, for example `add-login-form`.
7. Write the split in `~/notes.md`: sub-task, developer, state, branch, base.
8. When the repository commits its designs, the first sub-task commits the design file. The developer cannot read the Pilot's files: put the design's full text in that sub-task's instruction.
9. Assign with `forge-team assign <developer> <task>` (plus `--from <task>` for a dependent one), the instruction on stdin.

Ask while you work, without waiting for the answer when you can go on:
- what the Pilot knows better (the request's context, the client's other repositories, which it reads): a message to the Pilot whose summary starts with `Question :`;
- what only the human can decide: `forge-team ask`.

Report to the Pilot once, when the work is ready: a message whose summary starts with `Rapport :`, the only message the Pilot releases you on. The body: the sub-tasks, who has each, which stack on which (the human ships a stack from its bottom).

Never: write the code yourself, assign a vague instruction, or start two sub-tasks in parallel when one needs the other.
