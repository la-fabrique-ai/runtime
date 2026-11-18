---
name: verify-before-report
description: "Use before you report a task as done or a review as finished: no claim without the command that proves it."
---

# Verify before you report

1. Find the checks the repository names: its `CLAUDE.md`, its scripts (`package.json`, a Makefile, CI files).
2. Run them one by one, on the final state of the work (the committed branch, or the checkout under review).
3. Put each command and its result in your report, in the form `command: result`. A result is what you saw, not what you expect.
4. Name the checks that cannot run in this container, with the reason (a missing tool, a missing service, no network).
5. If a check fails, the work is not done: fix it, or report the failure as it is.

Report: the list of commands with their results, then the checks you could not run.

Never: write "tests pass" without having run them in this session, or leave out a failing check.
