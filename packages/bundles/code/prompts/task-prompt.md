# Task prompt

You are running a code task through a multi-agent review pipeline. The task
description, the project's conventions (its `CLAUDE.md` if present), and the
relevant senior-pattern references have been gathered for you.

Work the task end to end:

- Honor the project's existing structure, style, and constraints.
- Make the smallest change that fully satisfies the task.
- Write or update tests for the behavior you change.
- Leave the working tree in a buildable, lint-clean, type-clean state.

Downstream reviewers will check your work for correctness, security,
performance, and style. Address their blocking findings before the final gate.
