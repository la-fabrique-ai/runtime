---
name: diagnose
description: Use when a test fails, a command errors or the behaviour is unexpected, before changing code to fix it.
---

# Diagnose before fixing

1. Reproduce the failure with the shortest command you can. If you cannot reproduce it, say so.
2. Read the whole error, not its last line.
3. List your hypotheses. Check them one at a time, each with a command or a read that can prove it wrong.
4. For searches through logs and code, ask a `scout` sub-agent rather than reading broadly yourself.
5. Check whether the failure also exists on `origin/main` (a detached checkout in your clone). If it does, it is not yours: report it to the Lead with the command that shows it, and do not fix it in passing.
6. Fix the cause you proved, then re-run the failing command and the checks around it.
7. After three failed hypotheses, stop and report blocked with what you tried and what you saw.

Report: the cause, the proof, the fix; or blocked, with the trail.

Never: change code on a guess, silence a failing test, or fix an unrelated failure inside your branch.
