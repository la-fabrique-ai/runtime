---
name: review-branch
description: "Use when your Lead assigns you the review of a developer's branch."
---

# Review a developer's branch

1. Run `git fetch origin && git fetch team`. The branch is `team/agent/<task>`.
2. Fix the base: `origin/main`, or `team/agent/<A>` when the Lead says the task is stacked on task A (it started with `--from <A>`), so that only the task's own commits are reviewed, not A's.
3. Fix the range. First round: list the commits with `git log <base>..team/agent/<task>` and the changes with three dots, `git diff <base>...team/agent/<task>` (from the merge base, so the base's own newer commits do not show up). Later rounds: `<commit>..team/agent/<task>`, when the Lead gives the last reviewed commit. If `git merge-base --is-ancestor <commit> team/agent/<task>` fails (the developer rebased), review the whole branch again as in the first round.
4. Launch two `branch-reviewer` sub-agents in parallel, giving each the base, the range and the instruction text:
   - axis instruction: does the branch do what was asked, and nothing more;
   - axis conventions: the repository's `CLAUDE.md` and its test conventions.
5. Merge their findings and rank them: blocking, should, minor. Each keeps its `path:line` evidence. Drop duplicates and anything you cannot back with evidence.
6. Apply `verify-before-report` on the branch: a detached checkout of `team/agent/<task>` in your clone.
7. Report to the Lead with `forge-team message <lead>`: the summary is one plain line (no backticks, `@`, `$`, `<`, `>` or brackets) saying blocking, should or minor counts and the verdict; the body, on stdin, holds the ranked findings, the verification results, and the commit you reviewed up to.

Never: fix the code yourself, write to the developer (the Lead does), or approve without having run the checks.
