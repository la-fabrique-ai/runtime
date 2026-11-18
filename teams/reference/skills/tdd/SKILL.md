---
name: tdd
description: "Use when your task adds or changes a behaviour, before writing the implementation."
---

# Test first

1. Read the repository's `CLAUDE.md` for its test conventions (where tests live, how big they are, what not to test) and follow them over any habit of yours.
2. Red: write the smallest test that expresses the new behaviour. Run it alone and watch it fail for the right reason.
3. Green: write the least code that makes it pass. Run the same test file again.
4. Refactor with the test green, then repeat for the next behaviour.
5. In the loop, run only the single test file. Run the whole suite once at the end, and the type check if the repository has one.
6. Run one heavy command at a time.

Report: the tests you added, the red you saw first, the final result of the suite.

Never: write the implementation first, edit a test to make it pass, or add tests the repository's conventions rule out.
