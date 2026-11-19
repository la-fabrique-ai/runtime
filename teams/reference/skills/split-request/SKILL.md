---
name: split-request
description: "Use when you receive a request or a design to deliver, before assigning any developer."
---

# Split a request into sub-tasks

1. Get the facts you need from `scout` sub-agents (where the code lives, how parts connect). Do not read many files yourself.
2. Cut the work into sub-tasks that each deliver alone: one pull request each. A sub-task that needs another's code stacks on it (step 4).
3. Make each instruction self-contained, since the developer sees nothing else: the goal, the files or modules involved, the constraints, what to verify, what not to do.
4. Order dependent sub-tasks one after another, with the same developer: when B needs A's code, B starts from A's branch. Once A is reviewed with nothing blocking and its developer released, give B to that developer with `forge-team assign <developer> <B> --from <A>`: forge creates `agent/<B>` from `agent/<A>` (it refuses `--from` for anyone else, who does not have A's branch), and B's pull request stacks on A's. You do not wait for A to be merged. Independent sub-tasks run in parallel, each from `origin/main`.
5. Never create more sub-tasks at once than there are free developers (`forge-team status`).
6. Give each a short lowercase-dash task name, for example `add-login-form`.
7. Write the split in `~/notes.md`: sub-task, developer, state, branch.
8. When the repository commits its designs, the first sub-task commits the design file. The developer cannot read the Pilot's files: put the design's full text in that sub-task's instruction.
9. Assign with `forge-team assign <developer> <task>` (plus `--from <task>` for a dependent one), the instruction on stdin.

Do not message the Pilot mid-request: it releases you as soon as you report. Your one report comes when the work is ready: the sub-tasks, who has each, and which stack on which (the human ships a stack from its bottom).

Never: write the code yourself, assign a vague instruction, or start two sub-tasks in parallel when one needs the other.
