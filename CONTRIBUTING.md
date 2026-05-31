# Contributing

Thanks for your interest! This is a small, dependency-free project — easy to hack on.

## Layout

- `SKILL.md` — the Claude Code skill definition (what Claude reads when `/codex-workflows` runs).
- `runner/` — the standalone runner (Node, zero deps):
  - `src/` — the seam (`codexAgent.js`) + provider-neutral DSL (`runtime.js`), transport (`appServerClient.js`), and helpers (model mapping, agentTypes, journal, worktree, meter).
  - `bin/run-workflow.js` — CLI to execute a workflow script.
  - `bin/view-run.js` — the run-viewer generator.
  - `test/` — `offline.js` (unit), `view-run.test.js` (viewer robustness across run shapes), `handshake.js` (live Codex connectivity).
- `references/` — `authoring.md` (workflow-script DSL) and `runner-readme.md` (architecture / Codex protocol mapping / faithfulness).
- `examples/` — runnable templates and a bundled `demo/` run.

## Develop

No build step. Requires Node ≥ 18.

```bash
npm test          # offline unit checks + viewer robustness (no Codex, no network)
npm run doctor    # check the local Codex App Server is reachable & logged in
npm run demo      # open the bundled sample run in the viewer
```

If you touch `runner/bin/view-run.js`, run `npm test` — `view-run.test.js` renders
every run shape (flat, large fan-out, pipeline, single, mixed, empty, scripted) in a
fake DOM and will catch a regression in any of them.

## Gotchas

- `view-run.js` embeds its CSS and client app as `String.raw` template literals — **no
  backticks inside those strings** (a stray backtick closes the template and breaks the
  generator; the robustness test catches it).
- Workflow scripts run in an isolated `node:vm` context: no `fs`/`process`/`fetch`/timers,
  and `Math.random`/`Date.now`/argless `new Date` are blocked. The *agents* do I/O.

## Pull requests

Keep it dependency-free where possible. Run `npm test` before opening a PR. For changes
to the Codex protocol mapping, note the `codex` version you tested against.
