---
name: split
description: "Use once the human has approved a ticket's spec: propose the stack of sub-tasks, then create it after their approval."
---

# Split a ticket into a stack

You propose the ticket's stack of sub-tasks to the human, then create it once they agree. Developers then take it one sub-task at a time, in order.

1. Read the spec again (`forge-team mission <id> spec`) and the ticket's repositories (`forge-team ticket <id>`).
2. Propose the stack: one sub-task per pull request a human reviews in one sitting, each standing on the ones below, in the order they are built. For each: its repository (one of the ticket's) and its text, which says what it does and how one knows it is finished.
3. Write the proposal to `split`: `forge-team write-mission <id> split` (the text on stdin), and show it to the human.
4. Adjust it with them until they explicitly agree. Silence is not approval.
5. Once they agree, create the stack: `forge-team create-stack <id>`, with the JSON array on stdin, in order, for example `[{"repository": "web", "text": "…"}, {"repository": "api", "text": "…"}]`. If the command is interrupted, run it again with the same list: it creates the missing sub-tasks.
6. Tell the human the ticket is in development, and how to follow it: `forge team status` from their machine, or by asking you where things stand.
7. Record the ticket and its stack in `/workspace/notes.md`.

Never: create the stack before the human agreed, change the stack of a ticket already in development, or put in a sub-task what the spec did not decide.
