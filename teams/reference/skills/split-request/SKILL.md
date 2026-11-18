---
name: split-request
description: "Use when you receive a request or a design to deliver, before assigning any developer."
---

# Split a request into sub-tasks

1. Get the facts you need from `scout` sub-agents (where the code lives, how parts connect). Do not read many files yourself.
2. Cut the work into sub-tasks that each deliver alone from `origin/main`: one pull request each.
3. Make each instruction self-contained, since the developer sees nothing else: the goal, the files or modules involved, the constraints, what to verify, what not to do.
4. Order dependent sub-tasks one after another: assign the next only when the previous is reviewed. Independent ones can run in parallel.
5. Never create more sub-tasks at once than there are free developers (`forge-team status`).
6. Give each a short lowercase-dash task name, for example `add-login-form`.
7. Write the split in `~/notes.md`: sub-task, developer, state, branch.
8. When the repository commits its designs, the first sub-task commits the design file.
9. Assign with `forge-team assign <developer> <task>`, the instruction on stdin.

Report to the Pilot: the sub-tasks, who has each, and the order.

Never: write the code yourself, assign a vague instruction, or stack a task on another developer's branch.
