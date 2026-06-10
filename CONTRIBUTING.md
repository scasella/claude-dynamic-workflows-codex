# Contributing

Thanks for your interest! This is a small, dependency-free project — easy to hack on.

## Layout

- `SKILL.md` — the Claude Code skill definition (what Claude reads when `/codex-workflows` runs).
- `runner/` — the standalone runner (Node, zero deps):
  - `src/` — the seam (`codexAgent.js` + `codexSession.js` for sessionful workers) + provider-neutral DSL (`runtime.js`), transport (`appServerClient.js`), and helpers (model mapping, agentTypes, journal, worktree, meter).
  - `bin/run-workflow.js` — CLI to execute a workflow script.
  - `bin/view-run.js` — the run-viewer generator (`--serve` adds the interactive cockpit endpoint).
  - `bin/fleet.js` — fleet supervision: `status` (multi-run digest) + `answer` (the human()/checkpoint channel; `src/fleetStatus.js` is the pure logic).
  - `test/` — `offline.js` (unit), `codex-session.test.js` (session driver + chaos), `view-run.test.js` / `view-run.live.test.js` / `map-run.test.js` / `summarize-run.test.js` (viewer + summary robustness across run shapes), `serve.test.js` (cockpit channel), `fleet.test.js` (fleet status/answer + the agent-supervisor loop), `goal-lint.plan.test.js` / `claim-check.plan.test.js` (harness-zoo dry runs), `examples.plan.test.js` (every bundled workflow stays `--plan`-safe), `handshake.js` (live Codex connectivity).
- `references/` — `authoring.md` (workflow-script DSL) and `runner-readme.md` (architecture / Codex protocol mapping / faithfulness).
- `examples/` — runnable templates and a bundled `demo/` run.
- `bin/codex-workflows.js` — the npx/git-install dispatcher (`run` / `fleet` / `view` / `map` / `summarize` / `doctor`).
- `scripts/sync-skill.js` — one-command sync of the skill surface to `~/.claude/skills/codex-workflows` (`npm run sync-skill`).
- `.claude-plugin/` — plugin + marketplace manifests (the repo installs directly as a Claude Code plugin).

## Develop

No build step. Requires Node ≥ 18.

```bash
npm test            # offline unit checks + viewer robustness (no Codex, no network)
npm run doctor      # check the local Codex App Server is reachable & logged in
npm run demo        # open the bundled sample run in the viewer
npm run sync-skill  # push your working tree to ~/.claude/skills/codex-workflows
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
