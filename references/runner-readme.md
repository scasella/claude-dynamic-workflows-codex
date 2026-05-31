# codex-workflows

Run **Claude Code dynamic-workflow scripts** against a **local Codex App Server**
instead of Claude subagents.

The workflow authoring surface is preserved verbatim — `export const meta` plus a
body using `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`,
`budget`, and `workflow()`. The **only** thing that changes is what backs
`agent()`: rather than spawning a Claude subagent, each call runs as one Codex
`thread` + `turn` over `codex app-server`, and returns the agent's final message
(or, with a `schema`, the parsed structured object).

So you "create the workflow as normal" — author it (or let Claude Code's Workflow
tool author + persist it), then execute that same script file here.

## How it works

```
workflow script (.js, unchanged)
        │  loaded by
        ▼
  src/runWorkflow.js ──► hosts the body in an AsyncFunction with injected globals
        │
        ▼
  src/runtime.js ──────► parallel / pipeline / phase / log / budget / workflow
        │                (provider-neutral; concurrency cap = min(16, cores-2))
        ▼
  agent(prompt, opts) ─► src/codexAgent.js   ◄── THE SEAM
        │
        ▼
  src/appServerClient.js ─► spawns `codex app-server --listen stdio://`
                            JSON-RPC: initialize → thread/start → turn/start
                            collects item/completed(agentMessage) → turn/completed
```

| Workflow concept              | Codex App Server mapping                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `agent(prompt)` → final text  | `thread/start` + `turn/start`, last `agentMessage.text`    |
| `agent(prompt, {schema})`     | `turn/start({ outputSchema })` → `JSON.parse(final text)`  |
| `agentType: 'x'`              | loads `.claude/agents/x.md` → `developerInstructions`      |
| `model` (Claude id or alias)  | remapped to an available Codex model via `model/list`      |
| `effort`                      | `effort` on thread + turn                                  |
| sandbox / permissions         | `approvalPolicy:"never"` + `sandbox` (default `workspace-write`) |
| transient errors              | retry with exponential backoff; app-server auto-reconnect  |
| `budget.spent()`              | summed `thread/tokenUsage/updated` totals                  |
| `parallel` / `pipeline`       | unchanged — pure JS scheduling                             |

## Requirements

- Node ≥ 18
- `codex` CLI on `PATH`, logged in (`codex login status` → "Logged in …")

## Usage

```bash
# cheap transport check (no model turn, no tokens)
npm run handshake

# run the example 2-agent workflow
npm run example
# or:
node bin/run-workflow.js examples/hello.workflow.js

# offline unit checks (no app-server)
node test/offline.js
```

CLI options:

```
run-workflow <script.js>
  --args JSON         value exposed to the script as `args`
  --args-file PATH    same, read from a file
  --budget N          token ceiling backing budget.total / budget.remaining()
  --model M           fallback model (Claude ids/aliases auto-mapped); omit for config default
  --frontier          pin ALL agents to the auto-detected latest frontier model (overrides per-call model)
  --pin-model M       pin ALL agents to model M (overrides per-call model)
  --effort E          none|minimal|low|medium|high|xhigh
  --sandbox S         read-only | workspace-write | danger-full-access
  --retries N         transient-error retries per agent (default 3)
  --resume            reuse prior results from the journal (skip unchanged agents)
  --journal PATH      journal location (default .workflow-journal/<script>.jsonl)
  --fresh             discard the journal before running
  --no-journal        disable journaling entirely
```

### Resume journal

Every run records each completed `agent()` result to a journal, keyed by a hash
of its identity (prompt + output-affecting opts) plus occurrence index. Re-run
with `--resume` and unchanged agents return instantly from cache (0 tokens);
edited prompts/opts miss and re-run. This is the runner's analogue of native
`resumeFromRunId` — and it makes a mid-run failure (or a tripped `--budget`)
cheap to recover from: bump the limit, `--resume`, and only the unfinished work runs.

### Worktree isolation

`agent(prompt, { isolation: 'worktree', cwd: <repo> })` runs the Codex thread in a
detached `git worktree` at HEAD, so parallel agents that edit files don't collide.
The worktree is auto-removed if the agent left it clean, and **kept** (path logged)
if it made changes. Requires `cwd` to be inside a git repo (otherwise isolation is
skipped with a notice).

Progress goes to **stderr**; the workflow's return value is printed as JSON to
**stdout** (so `run-workflow wf.js | jq .` works).

### Cross-project robustness

A persisted script written for Claude Code rarely needs editing to run here:

- **Model translation** — a script (or `agentType`) that asks for `claude-opus-4-8`,
  or a bare `opus`/`sonnet`/`haiku` alias, is mapped to the best available Codex
  model (queried once via `model/list`). Unknown/`inherit` → Codex config default.
- **`agentType`** — `agent(p, { agentType: 'reviewer' })` loads
  `.claude/agents/reviewer.md` (project scope first, then `~/.claude`) and uses its
  body as `developerInstructions` and its frontmatter `model` as a fallback.
- **Resilience** — transient Codex errors (rate limits, stream disconnects,
  connection failures) and a dropped app-server are retried with exponential
  backoff; the client reconnects automatically. Permanent errors (bad request,
  context-window, schema) fail fast.
- **Isolation** — the script runs in a `node:vm` context whose global holds only
  the injected workflow API + JS intrinsics. No `process`/`fetch`/`require`/
  `import()`/`fs`/timers are reachable from the script itself (agents do the I/O),
  matching the native "no direct filesystem or shell access" guarantee.
  `Math.random()`/`Date.now()`/argless `new Date()` are blocked (resume safety).

### `agent(prompt, opts)` options

`schema`, `model`, `agentType`, `effort`, `sandbox`, `cwd`, `systemPrompt`,
`personality`, `isolation`, `retries`, `timeoutMs`, `label`. Per-call `opts`
override the CLI `--model/--effort/--sandbox/--retries` defaults.

## Implemented vs. extension points

**Implemented & tested:** stdio transport + handshake, `thread/start`/`turn/start`,
final-message capture, native `outputSchema` structured output, `agent`,
`parallel`, `pipeline`, `phase`, `log`, `budget` (token metering + enforcement),
**model translation + `model/list` preflight**, **`agentType`** resolution,
**retry-with-backoff + app-server reconnect**, an **isolated `node:vm` script
sandbox** (no fs/shell/process/fetch/import; non-deterministic builtins blocked),
**`isolation:'worktree'`**, the **resume journal** (`--resume`), one-level
`workflow({scriptPath})` nesting, and the CLI. Validated end-to-end on real
multi-phase runs (parallel schema reviewers feeding a consolidator), including
budget-stop-then-resume. See `examples/demo/` for a bundled sample run.

**Extension points (not yet wired):**

- **`opts.phase` grouping** — the `phase()` global groups progress, but a per-call
  `agent(p, { phase: 'X' })` hint is currently ignored (cosmetic).
- **Named-workflow registry** — `workflow("name")` currently supports only the
  `{scriptPath}` form (no `.claude/workflows/` lookup).
- **Warm-context resume** — the journal replays *results*; it does not yet reuse
  Codex thread state via `thread/resume` / `thread/fork`.
- **Budget accounting** — totals sum input+output tokens per process (native counts
  output tokens, shared pool); a budget-driven loop differs slightly across a resume.

## Pinning to a Codex version

Method names/shapes here were verified against the installed `codex` 0.135.0. To
re-verify or regenerate for another version:

```bash
codex app-server generate-json-schema --out ./schema
codex app-server generate-ts          --out ./schema-ts
```
