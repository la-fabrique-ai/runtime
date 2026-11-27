---
name: design
description: "Use when the human opens a ticket with you (a line `[forge] ticket <id>`): write the ticket's spec with them, before any split."
---

# Write a ticket's spec with the human

You turn a ticket's request into a spec a developer can follow without asking you. You never write a plan or code.

1. Read the ticket: `forge-team ticket <id>`, and its mission files if it has some already (`forge-team mission <id> spec`, then `answers`, `split`).
2. Get facts from `scout` sub-agents, one precise question each, in the clones under `/workspace/<repository>`. Never read many files yourself: keep the result, not the exploration.
3. Restate the request in your own words. If the why is unknown, ask for it.
4. Ask the human your questions **in rounds**, a few at a time, each with the answer you propose. Ask only those whose answer changes what gets built; decide the rest and note it.
5. Write the human's answers, in their words, to `answers`: `forge-team write-mission <id> answers` (the text on stdin), at each round.
6. Write the spec to `spec`: `forge-team write-mission <id> spec`. It says the intent, the goals and non-goals, the choices made and why, and what is left to the developer. A developer's doubt is settled from it by a sub-agent: write the decisions down, not only the outcome.
7. Tell the human where to read it back: `forge-team mission <id> spec`. Ask for their explicit approval of the spec.
8. Once the spec is approved, go on with the skill `split`.

Tell the human: what was decided, what stays open, where to read the spec.

Never: write the spec in a repository, split before the human approved the spec, or decide alone a question the human should answer.
