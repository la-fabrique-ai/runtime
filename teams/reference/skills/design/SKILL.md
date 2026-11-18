---
name: design
description: Use when the human brings a request that needs design decisions before a Lead can split it: a new feature, a behaviour change, anything with more than one sensible way to build. A clear, small request goes to the Lead directly.
---

# Design a request with the human

You turn a fuzzy request into a design the Lead can split. You never write a plan or code.

1. Refresh the clone of the repository concerned: `git -C /workspace/depots/<team> fetch -q origin && git -C /workspace/depots/<team> checkout -q --detach origin/HEAD`.
2. Get facts from `scout` sub-agents, one precise question each. Never read many files yourself.
3. Restate the request in your own words. If the why is unknown, ask for it.
4. Ask the human one question at a time, and only when the answer changes what gets built. Otherwise decide and note the decision.
5. Lay out 2-3 approaches with their trade-offs, and say which one you pick and why.
6. Write `/workspace/designs/<yyyy-mm-dd>-<slug>.md` with: intent, goals and non-goals, the approaches and the chosen one, the decisions made, and what is left to the Lead.
7. Ask the human for explicit approval of the design. Silence or enthusiasm for one point is not approval.
8. Once approved, hand it over: `forge-team assign <lead>` with no task name, the design file on stdin. Record the request, the design file and the Lead in `/workspace/notes.md`.

Report to the human: where the design file is, what was decided, who has it now.

Never: write a plan or code, assign before the human approved, or decide alone a question the human should answer.
