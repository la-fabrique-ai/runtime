---
name: qa
description: "Use when your mission is a QA ([forge] mission qa <ticket>): test the whole stack of a ticket against its spec, then report a verdict and its defects."
---

# QA of a ticket

Your clone is on the top of the ticket's stack, on a detached commit: it holds every sub-task of the ticket. You test it as a user of the ticket would. You change no file and commit nothing.

1. Read the mission files first, under `/etc/forge/mission/` (`spec.md`, `answers.md`, `split.md`, those that exist), then the mission's "Questions already answered". They say what the ticket must do. Then read the mission's stack: one line per sub-task, from the bottom up.
2. Run the project's checks (tests, type checks, lint), as its `CLAUDE.md` says, one at a time: this container has a memory limit. A check that fails is a defect, unless it also fails on the base of the stack (say so in your report).
3. Exercise what the ticket changes, as a user would: start the project's services when it has some (`docker compose up`), drive the browser when there is a UI (the Chrome DevTools MCP server), call the API when there is one. Follow the spec's cases one by one, then the edges it names.
4. A defect is something the spec asks for and the stack does not do, or something the stack breaks that worked before. Never a preference, a style, or a choice the spec leaves open. When the spec does not settle whether something is right, it is not a defect: say it in your report, under what stays open.
5. Give each defect to the sub-task whose commits introduced it. A sub-task's own commits are `git log team/agent/<sub-task below>..team/agent/<sub-task>` (for the bottom one, from the stack's base); run `git fetch team` first. When a defect belongs to no single sub-task (it comes from how they fit together, or from nothing any of them did), it is transverse: its sub-task is `null`.
6. Write each defect so that it stands alone: what is wrong, how to see it (the command, the page, the input), and what the spec says instead (quote it). The developer of the fix gets only that text and the mission files.
7. Write two files outside the clone (for example under `/tmp`):
   - the free report, in Markdown: what you ran and what you saw, check by check; what stays open;
   - the structured report, JSON, exactly one of:
     - `{"verdict":"ok","defects":[]}`
     - `{"verdict":"ko","defects":[{"subtask":"<sub-task id or null>","text":"<the defect, standing alone>"}]}`

     At most 50 defects; one defect per problem, never several unrelated problems in one.
8. Then run: `forge-team done --qa-report-file <the JSON file> --report-file <the Markdown file>`. The host checks the JSON field by field; read its refusal, fix the file, run it again.

Never: change or commit a file of the clone, report a defect you did not see yourself, or fix the code yourself.
