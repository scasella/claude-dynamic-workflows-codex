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
  agent(prompt, opts) ─► src/codexAgent.js   ◄── THE SEAM (one-shot: 1 thread, 1 turn)
  agent.start(...)    ─► src/codexSession.js ◄── sessionful: 1 thread, MANY turns
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
| `agent.start(prompt)`         | `thread/start` + first `turn/start`, returns before completion |
| `session.steer(msg)`          | another `turn/start` on the **same** `threadId` (a follow-up turn) |
| `session.cancel()`            | `turn/interrupt` → await `turn/completed{status:interrupted}` |
| `agentType: 'x'`              | loads `.claude/agents/x.md` → `developerInstructions`      |
| `model` (Claude id or alias)  | remapped to an available Codex model via `model/list`      |
| `effort`                      | `effort` on thread + turn                                  |
| sandbox / permissions         | `approvalPolicy:"never"` + `sandbox` (default `workspace-write`) |
| transient errors              | retry with exponential backoff; app-server auto-reconnect  |
| `budget.spent()`              | summed `thread/tokenUsage/updated` totals (cumulative per thread) |
| `parallel` / `pipeline`       | unchanged — pure JS scheduling                             |

### Sessionful workers (`agent.start` / `agent.waitAny` / `session.*`)

`agent()` is one thread + one turn. `agent.start()` opens a thread and begins the
first turn but **returns before it finishes**, so a workflow can spawn long-lived
workers, `agent.waitAny([…])` for the first to become actionable, and `steer()` a
worker with **follow-up turns on the same thread** (it keeps its context — Codex
threads are multi-turn, exactly like the SDK's `thread.run()`-again). See
[`authoring.md` → *Sessionful workers*](authoring.md#sessionful-workers-long-lived-steerable)
for the full API, the controller pattern, and the human interaction model
(`hands_off` / `checkpointed` / `interactive`). Key runner facts:

- **Concurrency:** a turn holds one semaphore slot from start to settle, so a
  *detached running worker still counts against* `min(16, cores-2)`. `agent.start`
  blocks if the cap is saturated (like `agent()`), then returns once a slot frees.
- **Budget:** every start/steer gates on `--budget` (same `BUDGET_EXCEEDED`); each
  turn's tokens are the per-thread cumulative delta.
- **Resume:** sessions resume **warm**. Each turn is journaled under
  `sess:<workerId>#<turn>` with the worker's `threadId`; on `--resume` the runtime
  calls `thread/resume` to re-attach the persisted thread, replays the journaled
  completed-turn prefix free (`cached` events, 0 tokens), and runs only new turns on
  the warm context. Replay is conditional on the re-attach succeeding (otherwise all
  turns re-run live — no fake thread resurrection) and positional (same script, same
  session call order). A resumed thread's prior-run token history is baselined out of
  the meter (`markResumedThread`), so budgets bill only this run's spend.
- **Finalization:** `runWorkflowSource` closes any sessions left open in a `finally`
  (cancels active turns, removes worktrees). `isolation:'worktree'` persists across
  steers, cleaned only on `close()`/finalization.
- **Events:** session turns emit the same `start`/`end` lifecycle events as `agent()`
  (with extra `kind:"session"`, `sessionId`, `turn`, `status` fields), so `map-run` /
  `view-run` / `summarize-run` keep working.
- **Seam:** the runtime takes a `startSession` option (default
  `codexSession.startCodexSession`) so offline tests drive sessions with a fake
  driver — no app-server, no tokens.

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
node bin/run-workflow.js ../examples/hello.workflow.js

# offline unit checks (no app-server)
node test/offline.js
```

CLI options:

```
run-workflow <script.js>
  --args JSON         value exposed to the script as `args`
  --args-file PATH    same, read from a file
  --budget N          token ceiling backing budget.total / budget.remaining()
  --budget-meter M    what budget.spent() counts: total (input+output, default) | output
  --plan              dry run: count agents per phase/effort + estimate a budget (no model)
  --tui               open a live ASCII map of the run in a new terminal window
  --gui               open a live HTML viewer of the run in your browser  (--monitor = both)
  --model M           fallback model (Claude ids/aliases auto-mapped); omit for config default
  --frontier          pin ALL agents to the auto-detected latest frontier model (overrides per-call model)
  --pin-model M       pin ALL agents to model M (overrides per-call model)
  --effort E          none|minimal|low|medium|high|xhigh (flat fallback)
  --auto-effort       scale effort to each layer's parallel width: 1->xhigh, 2+->high (floor)
  --pin-effort E      force ALL agents to effort E (overrides per-call effort)
  --sandbox S         read-only | workspace-write | danger-full-access
  --retries N         transient-error retries per agent (default 3)
  --resume            reuse prior results from the journal (skip unchanged agents)
  --journal PATH      journal location (default .workflow-journal/<script>.jsonl)
  --fresh             discard the journal before running
  --no-journal        disable journaling entirely
  --summary           print the full cost/performance/reliability report at the end
  --no-summary        silence the short end-of-run recap (printed by default)
```

### Layer-width effort (`--auto-effort`)

`parallel()` and `pipeline()` publish how many agents run side-by-side in the
current layer via an `AsyncLocalStorage` store (`runtime.js`); `agent()` reads it
(default `1` for a lone, un-fanned-out call) and, when `--auto-effort` is on,
maps width → effort with `effortForLayerWidth`:

| layer width | effort  |
| ----------- | ------- |
| 1           | `xhigh` |
| 2+          | `high`  |

The rationale: a lone agent is a critical gate (consolidation / judge / report)
where one weak output sinks the run, so it thinks hardest; every fan-out floors
at `high` (the policy never drops to `medium`). The context propagates across awaits and through the
vm-hosted thunks, so a queued or deeply-awaited agent still sees the width of the
layer that spawned it. Effort precedence (highest first): `--pin-effort` →
per-call `opts.effort` → `--auto-effort` → `--effort` → Codex config default. The
*effective* effort is folded into each agent's journal identity, so toggling the
policy between runs busts only the agents whose effort changed.

### Resume journal

Every run records each completed `agent()` result to a journal, keyed by a hash
of its identity (prompt + output-affecting opts) plus occurrence index. Re-run
with `--resume` and unchanged agents return instantly from cache (0 tokens);
edited prompts/opts miss and re-run. This is the runner's analogue of native
`resumeFromRunId` — and it makes a mid-run failure (or a tripped `--budget`)
cheap to recover from: bump the limit, `--resume`, and only the unfinished work runs.
On a `--budget` trip the CLI prints a paste-ready `--resume --budget <2×>` command.

### Per-agent metrics & the viewers

Alongside each result, the journal records non-identity attribution: the agent's
**phase** (`opts.phase`, else the ambient `phase()`), **effort**, resolved
**model**, **tokens** (total and output-only), and **wall time** — captured in
`codexAgent.js` (host clock + the `thread/tokenUsage/updated` total for that
thread) and folded in by `runtime.js`.

Both viewers read the same model. `src/runModel.js` (`locateRun` + `buildRunModel`)
turns a journal (+ optional script) into the structured run model — phases, agents
with phase/model/effort/tokens/ms, and totals — preferring the journal's per-agent
fields and falling back to script regex for older journals. On top of it:

- **`bin/view-run.js`** — the HTML viewer. Renders token totals and time per agent,
  per phase, and per run (the data the native `/workflows` view shows). `<dir>
  --watch` rebuilds the HTML as the journal grows so an open tab tracks a live run
  (auto-refreshes every 2s).
- **`bin/map-run.js`** — an **ASCII execution-graph (DAG)** in the terminal: an
  orchestrator node-box (with a monochrome `✓✓⠋··` progress strip) → a flow arrow
  into each phase layer → branch edges (`├─` / `╰─`) to a **fixed-column agent
  grid** (`AGENT MODEL EFFORT TOKENS WALL` header; running rows share the columns —
  spinner status, `--` tokens, elapsed in `WALL` — so done/running scan as one
  table) → a **1–2 sentence result snippet** (via `agentSnippet`) under each node →
  **semantic barriers** (`┄ barrier · Gather → Synthesize ┄`) → a result node-box.
  All widths derive from one `frameW`; text is display-width-safe (wide/combining
  chars), so it stays aligned in `--no-color`. `+N more` collapses big fan-outs;
  `<dir> --watch` redraws in place on an alternate screen (snippets auto-drop if the
  frame would overflow the terminal height). The polish came from a Codex
  multi-persona workflow — see `polish-ascii-map.workflow.js`.

### Live observability (the event stream)

Completed agents come from the journal, but a live run also wants to show what's
**running**. So when journaling is on, the runner writes a sidecar event stream
next to the journal — `<name>.events.jsonl` — appending `{t, type, label, phase,
model, effort, tokens, ms}` on each agent `start` / `end` / `cached` (emitted by
`runtime.js` via an `onEvent` sink; truncated fresh per run; best-effort, never
blocks the run; disabled by `--no-journal`). It's purely observational — separate
from the resume journal, so it never affects identity/hashing.

`runModel.js` (`readEvents` + `liveState`) turns it into live state: agents with a
`start` not yet matched by an `end` are **running**, plus run wall-clock
(`runStartedAt`..`lastEventAt`) and done/running counts. `map-run.js --watch` merges
those running agents into the map — they show under their phase the instant they
start, with a spinner and live elapsed (`⠴ global-ranking  3.6s running…`), and an
animated footer (`⠴ 42s · 2 done · 1 running`). The HTML viewer can consume the
same stream; today it renders completed agents and `--watch`-rebuilds.

### Budget metering (`--budget-meter`)

`budget.spent()`/`remaining()` count **total** tokens (input+output+reasoning) by
default — a conservative cost bound, and what the `--plan` estimate and the
budget-sizing rule of thumb assume. Pass `--budget-meter output` to count only
output+reasoning, matching the native runtime's output-token pool, for scripts
whose `budget`-driven loops were written against that semantics.

### Run summary report (`bin/summarize-run.js`)

A run leaves a journal (and, when journaling is on, an event sidecar); `summarize-run`
distills them into a **cost / performance / reliability** report. `src/runSummary.js`
(`summarizeRun` + `renderSummaryText` / `renderSummaryMarkdown`) builds it on top of
`buildRunModel`, so it inherits the same old-journal tolerance (phase/model/effort
recovered from the script when the journal predates the metric fields) and **never
writes the journal**.

```bash
node bin/summarize-run.js --journal .workflow-journal/<name>.jsonl   # or: <run-dir>
node bin/summarize-run.js <run-dir> --json        # structured (the summary object)
node bin/summarize-run.js <run-dir> --markdown    # paste-ready report
node bin/summarize-run.js <run-dir> --out r.txt   # write to a file
node bin/summarize-run.js <run-dir> --include-result   # also preview the return value
```

It reports total / completed / null / cached / interrupted agents, agents·tokens·
agent-time **by phase**, the **top 10 costliest** (tokens) and **slowest** (time)
agents, a **model & effort** breakdown, and **cache hit rate** on a resumed run.
Token totals separate the journal's **all-in** sum (across resumes) from the
**latest run's executed** tokens (agents that finished this run, matched by stable
id); **budget usage** (from the meta sidecar) bills the latest run when the event
sidecar is present, else the all-in total — and labels which. It also raises
warnings: missing metrics, many null results, interrupted agents, unphased /
unlabeled agents, a single phase with a huge fan-out, and agents left on the
(often-`xhigh`) Codex default effort.

When a run directory holds several journals, `summarize-run` — like `view-run` and
`map-run` — defaults to the **most recently modified**; **`--list`** shows them all
and **`--journal PATH`** selects a specific one.

What each source contributes (all optional except the journal):

- **journal** — completed agents (deduped by key), phase/model/effort/tokens/ms.
- **`<name>.events.jsonl`** — the most recent run's lifecycle, giving true
  **wall-clock per phase** (vs. the journal's sum-of-durations), **cached** replays,
  and **interrupted** agents (a `start` with no matching `end`).
- **`<name>.result.json`** — the workflow's return value, for `--include-result`.
- **`<name>.meta.json`** — run-level facts the journal can't carry (budget + meter,
  pinned model, effort policy, sandbox — plus `pid` / `startedAt` / `script` /
  `runId`, which `fleet status` uses to tell a live run from a finished or killed
  one), written once by `run-workflow` at startup (best-effort; runtime-only,
  git-ignored). Absent → the budget line is simply omitted.

`run-workflow` prints a short recap automatically when a run finishes (one line for
tiny runs, a small phase table otherwise); `--summary` prints the full report inline,
`--no-summary` silences it.

### Dry-run planning (`--plan`)

`--plan` executes the orchestration with `agent()` stubbed — it returns a JSON
Schema *skeleton* (objects filled, arrays empty) instead of calling a model — and
records each would-be agent's phase/effort/width to print a per-phase count and an
estimated `--budget`. Because skeleton arrays are empty, a fan-out sized from a
prior agent's output is **uncounted** (a lower bound); the CLI says so. Static
fan-outs (over `args`, fixed lists) count exactly.

### Live monitoring (`--tui` / `--gui`)

`run-workflow` can auto-open a live monitor that watches **this run's** journal +
event sidecar as it progresses — so you see every agent (running + done) update in
real time without a second command. It's spawned *before* the workflow starts (the
journal is pre-created) and runs alongside it:

- **`--tui`** opens the ASCII map (`map-run.js --watch`) in a **new terminal
  window** — it needs its own TTY for the alternate-screen redraw, so on macOS the
  runner uses `osascript` to open Terminal (elsewhere it prints the command). The
  window persists after the run; Ctrl-C there to close it.
- **`--gui`** spawns `view-run.js --watch --open`, which opens the **HTML viewer**
  in your browser and rebuilds it as the journal/events grow (the page
  auto-refreshes every ~2s). On completion the runner stops the watcher and writes
  a final static render so the page settles.
- **`--monitor`** does both. All need journaling (skipped under `--no-journal`).

Both viewers consume the same live model: `runModel.js`'s **`buildLiveRunModel`**
(= `buildRunModel` + `liveState`) merges started-but-unfinished agents as
`status:'running'`, so the HTML viewer now shows in-flight agents (amber, pulsing,
with elapsed) exactly as the ASCII map does. The workflow itself runs unchanged —
its result JSON still prints to stdout — so `--tui`/`--gui` compose with everything
else (`--frontier --auto-effort`, `--resume`, …).

`agent(prompt, { isolation: 'worktree', cwd: <repo> })` runs the Codex thread in a
detached `git worktree` at HEAD, so parallel agents that edit files don't collide.
The worktree is auto-removed if the agent left it clean, and **kept** (path logged)
if it made changes. Requires `cwd` to be inside a git repo (otherwise isolation is
skipped with a notice).

Progress goes to **stderr**; the workflow's return value is printed as JSON to
**stdout** (so `run-workflow wf.js | jq .` works).

### Fleet supervision (`bin/fleet.js`, `--run-id`)

Several runs can execute **concurrently** and be supervised from outside — by a
human in a second terminal, or (the intended operator) a supervising agent in a
loop. The pieces:

- **Isolation** — journals derive from the script name, so N concurrent runs of
  the *same* script need **`--run-id NAME`** (journal + every sidecar become
  `<base>--NAME.*`). Distinct variant scripts in one shared directory isolate
  naturally — and that shared directory *is* the fleet.
- **Discovery** — the journal file is touched **eagerly** at startup, so a
  just-launched run is visible to `fleet status` (and the viewers) before its
  first agent completes.
- **`fleet status [dir|journal ...] [--json] [--stall-after S]`** — one digest
  across every run found: a derived state machine (**completed** = a result
  sidecar fresher than this run's `startedAt` · **running** = the recorded pid is
  alive · **stopped** = started but pid gone with no fresh result, i.e.
  killed/crashed/budget-tripped → resumable · **idle** = journal only), phase +
  agent progress, tokens vs budget, **stall** detection (a live pid with no
  events past the threshold — unless it's waiting on a question, which is
  *waiting*, not stalled), and every **pending `human()` question** with a
  paste-ready answer command. `src/fleetStatus.js` is the pure logic (clock and
  pid-liveness injectable; see `test/fleet.test.js`). For a human watching:
  **`--watch`** redraws the digest in place every 2s until all runs are
  terminal, and **`--html PATH [--open]`** writes a self-contained card-per-run
  dashboard (auto-refreshes while any run is live; links each run's generated
  viewer page when present; `--watch --html` rewrites it each cycle).
- **`fleet answer --journal J --id ID --answer TEXT [--answer-json]`** — the
  write side of the supervisor channel: validates the id against the run's
  *currently-pending* questions (same rule as the `--serve` cockpit's endpoint —
  no pre-answering, no re-answering; a bare `qid` resolves if unambiguous) and
  appends to `<name>.answers.jsonl`, which the running workflow polls (~500ms).
  `--list` shows a run's asked/pending questions. Free-text answers are how a
  supervisor **steers**: author workflows with checkpoint gates whose answers
  the script applies (e.g. `session.steer(directive)`).
- **`--notify-cmd CMD`** (on `run-workflow`) — the push side: CMD runs detached
  (best-effort, `/bin/sh -c`, the event JSON in `$WORKFLOW_EVENT`) when a
  `human()` question goes pending — gates time out to their defaults, so an
  away supervisor needs the push — and when the run ends
  (`completed` / `budget_exceeded` / `failed`). Implies `--interactive`.
- **Fork** — copy a journal to a new name, point an edited variant at it with
  `--journal <copy> --resume`: the unchanged prefix replays at 0 tokens and
  sessionful workers re-attach to their threads warm; only the new direction
  spends. Kill + `--resume` (same journal) is the degenerate case.

`examples/fleet/` is a runnable two-variant fleet with the full supervision
transcript; the `/codex-workflows --multi` skill mode automates the whole loop.

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
`personality`, `isolation`, `retries`, `timeoutMs`, `label`, `phase`. Per-call `opts`
override the CLI `--model/--effort/--sandbox/--retries` defaults — except that
`--frontier`/`--pin-model` force the model and `--pin-effort` forces the effort
regardless of `opts`. A per-call `effort` overrides `--auto-effort` (so omit it
unless you deliberately want to escape the layer-width policy for one agent).

## Implemented vs. extension points

**Implemented & tested:** stdio transport + handshake, `thread/start`/`turn/start`,
final-message capture, native `outputSchema` structured output, `agent`,
`parallel`, `pipeline`, `phase`, `log`, `budget` (token metering + enforcement),
**per-call `opts.phase` grouping**, **per-agent metrics** (phase/effort/model/
tokens/time persisted to the journal, rendered by the viewer), **model translation
+ `model/list` preflight**, **`agentType`** resolution, **retry-with-backoff +
app-server reconnect**, an **isolated `node:vm` script sandbox** (no fs/shell/
process/fetch/import; non-deterministic builtins blocked), **`isolation:'worktree'`**,
the **resume journal** (`--resume`), the **named-workflow registry**
(`workflow("name")` → `.claude/workflows/` then `~/.claude/workflows/`),
**`--plan` dry-run estimation**, **`--budget-meter total|output`**, **`--watch`
live viewer**, the **`summarize-run` cost/performance/reliability report**
(text/json/markdown, with an automatic end-of-run recap), one-level
`workflow({scriptPath} | "name")` nesting, **sessionful workers** (`agent.start` /
`agent.waitAny` / `session.steer`/`wait`/`poll`/`cancel`/`close` — long-lived,
multi-turn, steerable Codex threads with per-turn budget/concurrency, lifecycle
events, runtime finalization, worktree persistence across turns, and warm-context
resume via `thread/resume`), and the CLI.
Validated end-to-end on real multi-phase runs (parallel schema reviewers feeding a
consolidator), including budget-stop-then-resume. See `examples/demo/` for a
bundled sample run.

**Extension points (not yet wired):**

- **One-shot thread forking** — `agent()` resume replays *results* (single stateless
  turns have no state worth forking). Sessions DO resume warm (`thread/resume`, see
  above); `thread/fork` (branching one warm worker into several) remains unexplored.
- **Direct worker steering from the viewer** — `human()` (built) covers *declared*
  forks: the workflow asks, the served live viewer (`view-run --serve`, auto with
  `--gui`) renders an answer card that POSTs to `/answer`, and the runner polls the
  `<journal>.answers.jsonl` sidecar. What remains unbuilt is UNdeclared steering —
  injecting a turn into a running worker the script didn't offer up — which would
  race the script's one-active-turn ownership; if ever added it needs a hand-off
  protocol, not just an endpoint.
- **Budget accounting across a resume** — totals are per process; `--budget-meter`
  selects total vs output (the native pool), but a `budget`-driven loop can still
  differ slightly across a resume since cached agents replay at 0 tokens.

## Pinning to a Codex version

Method names/shapes here were verified against the installed `codex` 0.135.0
(`src/codexVersion.js` → `VERIFIED_CODEX_VERSION`). The handshake preflight
(`npm run handshake`) prints the detected version and warns on drift. To re-verify
or regenerate bindings for another version:

```bash
codex app-server generate-json-schema --out ./schema
codex app-server generate-ts          --out ./schema-ts
```
