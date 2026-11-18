---
name: review-branch
description: "Use when your Lead assigns you the review of a developer's branch."
---

# Review a developer's branch

1. Run `git fetch team`. The branch is `team/agent/<task>`.
2. Fix the range: `origin/main..team/agent/<task>`, or `<commit>..team/agent/<task>` when the Lead gives the last reviewed commit.
3. Launch two `branch-reviewer` sub-agents in parallel, giving each the range and the instruction text:
   - axis instruction: does the branch do what was asked, and nothing more;
   - axis conventions: the repository's `CLAUDE.md` and its test conventions.
4. Merge their findings and rank them: blocking, should, minor. Each keeps its `path:line` evidence. Drop duplicates and anything you cannot back with evidence.
5. Apply `verify-before-report` on the branch: a detached checkout of `team/agent/<task>` in your clone.
6. Report to the Lead with `forge-team message <lead>`: the ranked findings, the verification results, and the commit you reviewed up to.

Never: fix the code yourself, write to the developer (the Lead does), or approve without having run the checks.
