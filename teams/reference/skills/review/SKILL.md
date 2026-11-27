---
name: review
description: "Use when the human gives you their review of a ticket in human-review or pr-review: sort each point with them, then create the fixes and the non-blocking tickets after their agreement."
---

# Take the human's review of a ticket

A ticket in `human-review` passed its QA and waits for the human's review; in `pr-review`, its pull requests are open. The human read the branches and tells you what they found. You turn it into sub-tasks, with their agreement.

1. Read the ticket again, never from memory: `forge-team ticket <id>` (its sub-tasks, its QA report, the developers' reports), then its mission files (`forge-team mission <id> spec`, `answers`, `split`).
2. Sort each point of the review with the human, one by one:
   - a **fix**: something a sub-task does wrong. Name the sub-task it belongs to (the one whose branch holds the code at fault);
   - a **new sub-task**: something the ticket lacks and no sub-task owns;
   - a **non-blocking point**: something that does not hold this ticket. It becomes a new ticket.
   When you cannot tell which sub-task a point belongs to, say so and ask: never guess.
3. Write each fix so that it stands alone: what is wrong, where (the file, the page, the command), and what is expected. The developer gets only that text and the mission files, not this conversation.
4. Show the whole list to the human (each fix with its sub-task, each new sub-task, each new ticket with its title) and wait for their explicit agreement. Silence is not agreement.
5. Then create them:
   - the fixes and the new sub-tasks, in one call: `forge-team create-fixes <id>`, with a JSON array on stdin, for example `[{"fixes": "T-1.2", "text": "…"}, {"fixes": null, "text": "…"}]` (`null`: a new sub-task on top of the stack). If the command is interrupted, run it again with the same list: it creates only what is missing;
   - each non-blocking point: `forge-team create-ticket <id>`, with `{"title": "…", "text": "…"}` on stdin. The new ticket starts in `todo`: it waits for the human like any other.
6. Tell the human the ticket is back in development: the fixes are made, the sub-tasks above are rebased, and the ticket passes its QA again before it comes back to them.
7. When the human validates the ticket with no change, create nothing. Tell them how its stack is shipped: `forge fetch` then `forge ship <sub-task>` from their machine, one sub-task at a time, from the bottom of the stack.
8. Record what was decided in `/workspace/notes.md`.

Never: create a fix the human did not agree to, put several unrelated points in one fix, or answer a point by changing the spec without saying so.
