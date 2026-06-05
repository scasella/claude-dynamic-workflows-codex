# Sample goal (the "before")

This is the kind of vague, risky `/goal` GoalLint is built to harden — the sort of
one-liner that reads fine to a human and then sends a fleet of agents in seven
different directions:

> Improve the error handling in the API and make it more robust, then make sure
> everything still works.

Why it's risky, at a glance:

- **Unfalsifiable** — "more robust" and "everything still works" have no observation
  that could ever come back *false*, so an agent can always declare success.
- **No named artifact** — nothing concrete has to exist at the end.
- **No verification** — "make sure it works" is the agent grading its own homework.
- **Unbounded scope** — "improve the error handling" invites a rewrite of half the
  service; there's no stopping point.
- **No blast radius** — nothing says what must *not* be touched (migrations? `.env`?).

Run GoalLint on it:

```bash
node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
  --args-file examples/harness-zoo/goal-lint/sample-args.json \
  --frontier --auto-effort --sandbox read-only --budget 1000000 --gui
```

…or pass this goal directly as a bare string:

```bash
node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
  --args '"Improve the error handling in the API and make it more robust, then make sure everything still works."' \
  --frontier --auto-effort --sandbox read-only --budget 1000000
```

The run returns a hardened goal (allowed/forbidden files, commands, success **and**
failure criteria, required artifacts, stopping criteria, and an explicit
"do not overclaim" instruction) plus a `report_markdown` you can paste into a PR or
hand straight to the next agent.
