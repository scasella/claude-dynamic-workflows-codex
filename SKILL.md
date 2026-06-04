---
name: codex-workflows
description: >-
  Run a dynamic-workflow script on a local Codex App Server — orchestrate many
  Codex / GPT agents (the agent / parallel / pipeline / phase / budget DSL)
  instead of Claude subagents, for codebase audits, large migrations, and
  multi-agent review or research. Manual-invoke only via /codex-workflows.
disable-model-invocation: true
---

# Codex Workflows

Run a Claude Code dynamic-workflow script against a local **Codex App Server**.
The authoring surface is identical to native dynamic workflows — `export const
meta` plus a body using `agent()`, `parallel()`, `pipeline()`, `phase()`,
`log()`, `args`, `budget`, `workflow()` — but every `agent()` call runs as one
Codex (GPT) thread+turn instead of a Claude subagent.

**Manual-invoke only.** Claude does not auto-trigger this skill
(`disable-model-invocation: true`); it runs only when the user types
`/codex-workflows` or explicitly asks for a Codex workflow. Once invoked, follow
the loop below — the work runs on Codex/GPT agents. If the user actually wanted
Claude subagents, say so and point them at the native Workflow tool.

`RUNNER` below means the bundled runner directory:
`~/.claude/skills/codex-workflows/runner` (also at `runner/` relative to this
skill). It is dependency-free Node ≥ 18.

## The loop

1. **Preflight** — once per session, or whenever a run fails to connect, confirm
   Codex is reachable and authed:
   ```bash
   node ~/.claude/skills/codex-workflows/runner/test/handshake.js
   ```
   It prints `state: ready` and the available models. If it fails, tell the user
   to run `codex login` (the runner needs a logged-in `codex` CLI on PATH).
   From that list, note the **latest frontier model** — the newest, strongest
   general model (highest `gpt-5.x`/successor that is not a `-mini`/`-spark`
   variant; `model/list` flags it `isDefault` and its description calls it the
   strongest). Today that is `gpt-5.5`. Every agent in the run uses it (see
   *Model*).

2. **Author** a workflow script (see *Authoring*). Write it into the user's
   project so they can read and rerun it — e.g. `./<name>.workflow.js`. Scripts
   are plain JavaScript using only the injected globals (no imports).

3. **Run** it — **always pass `--frontier` and `--auto-effort`**: `--frontier`
   pins every agent to the latest frontier model (see *Model*); `--auto-effort`
   scales each agent's thinking effort to its layer's parallel width, so critical
   single-agent gates think hardest (see *Effort*):
   ```bash
   node ~/.claude/skills/codex-workflows/runner/bin/run-workflow.js <script.js> --frontier --auto-effort [other flags]
   ```
   Progress streams on **stderr**; the workflow's return value prints as JSON on
   **stdout**. Capture stdout for the result (`… 1>/tmp/result.json`) when it's
   large. If the user wants to **watch the run live**, add `--tui` (live ASCII map
   in a new terminal window) and/or `--gui` (live HTML viewer in the browser) — see
   *Running → Live monitoring*.

4. **Surface** the result to the user — summarize it, mention the script path, and
   **render the run's ASCII map inline in this conversation** so they see the
   execution graph natively (no window to open):
   ```bash
   node ~/.claude/skills/codex-workflows/runner/bin/map-run.js --journal <journal> --no-color
   ```
   (`<journal>` is the path the run logged as `✎ journal: …`, default
   `.workflow-journal/<name>.jsonl`.) Paste that output into your reply inside a
   ```` ```text ```` block — it's the orchestrator → phase layers → agent grid →
   result DAG with per-agent model/effort/tokens/time and a one-line result snippet
   per agent. **Always use `--no-color`** inline (raw ANSI would render as garbage
   in chat). For **live, in-session** monitoring, run the workflow with
   `run_in_background` and re-render this snapshot a few times while it's in flight
   (running agents show as `⠋ … running…`); for a smooth live *window* instead, add
   `--tui`/`--gui` (see *Running → Live monitoring*).

**Do NOT call the native `Workflow` tool while using this skill.** Authoring the
script and running it through the CLI above is exactly what routes the work to
Codex; invoking the native tool would spawn Claude subagents instead.

## Model: one frontier model for every agent

Use a **single model — the latest frontier model — for every agent in the run.**
Do not mix models, and do not downgrade "cheap" or "simple" stages to a smaller
or older model. The frontier model is the one identified at preflight (newest,
strongest, `isDefault`; currently **`gpt-5.5`**) — never `gpt-5.4`/`gpt-5.2` or a
`-mini`/`-spark` variant.

Enforce it with **`--frontier`** (always pass it): the runner auto-detects the
latest frontier model from `model/list` and pins **every** agent to it,
**overriding any per-call `model`** a script sets. This is a hard guarantee — even
if a script asks for `gpt-5.4`, `--frontier` forces it to the frontier and logs
the override. (To pin a specific model instead, use `--pin-model gpt-5.5`.)

Also good practice, though `--frontier` makes it non-essential: don't set a
per-call `model` in scripts — leave `model` out of every `agent()` opts object.

Need to bound cost? Lower effort (see below) and set `--budget` — do not switch models.

## Effort: scale thinking to layer width

Thinking effort is the second dial (after model). The principle: **the fewer
agents run in parallel at a step, the more pivotal each one is, so the harder it
should think.** A lone agent in its layer is almost always a critical *gate* — a
consolidation, a judge/synthesis, a final report — where one weak output sinks the
whole run; it earns maximum reasoning. A 12-wide persona fan-out is the opposite:
each agent is one voice among many, and redundancy covers individual misses.

**Always pass `--auto-effort`.** The runner reads each layer's parallel width
(the number of thunks in a `parallel()`, or items in a `pipeline()` stage) and
sets effort automatically:

| Parallel agents in the layer | Effort  | Typical role |
|------------------------------|---------|--------------|
| **1** (lone)                 | `xhigh` | consolidate / judge / synthesize / report — critical gate |
| **2+** (any fan-out)         | `high`  | floor — wide fan-outs still think hard |

So in a forge-style run, the `consolidate`, `portfolio-judge`, and `report-writer`
agents automatically get `xhigh`; every fan-out — the 3–4-wide pain/mechanism/
recombination waves *and* the 12-persona / 8-critic layers alike — gets `high`.
The floor is `high`; the policy never drops to `medium`. No per-agent bookkeeping.

Precedence (highest first): **`--pin-effort E`** (force every agent to `E`) →
a script's **per-call `effort`** → **`--auto-effort`** layer policy → flat
**`--effort E`** → Codex config default. Because per-call effort overrides the
policy, **do not hand-set `effort` in scripts** — leave it out and let
`--auto-effort` govern; reserve a per-call `effort` for a rare, deliberate
exception (e.g. forcing `xhigh` on one unusually hard agent *inside* a wide
layer).

Bound cost without touching the model: keep `--auto-effort` but add a `--budget`
backstop, or drop everything a tier with `--pin-effort medium`. The old flat
`--effort medium` still works as a fallback when you don't pass `--auto-effort`,
but the layer-aware policy is strictly better for multi-phase runs.

## Authoring (quick reference)

A script is a JS module that starts with a pure-literal `meta` and then uses the
injected globals. Top-level `await` and a top-level `return` (the workflow's
result) are supported.

```js
export const meta = {
  name: 'audit-auth',
  description: 'Check every route for missing auth',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],   // titles match phase() calls
}

phase('Scan')
const findings = await pipeline(
  args.files,                                               // args = value passed via --args
  (file) => agent(`Audit ${file} for missing auth checks.`, { schema: FINDINGS, label: file }),
  (res, file) => parallel(res.findings.map((f) => () =>     // verify each as soon as its scan lands
    agent(`Adversarially confirm: ${f.title} in ${file}. Default to refuted if unsure.`,
          { schema: VERDICT }).then((v) => ({ ...f, verdict: v })))),
)
return findings.flat().filter(Boolean).filter((f) => f.verdict?.real)
```

Globals:
- `agent(prompt, opts?)` → the agent's final text, or (with `opts.schema`) the
  parsed object, or `null` if interrupted. **This is the only global that calls a
  model.**
- `parallel(thunks)` → barrier fan-out; a thunk that throws becomes `null`
  (so `.filter(Boolean)`).
- `pipeline(items, ...stages)` → per-item staging, no barrier; a stage that
  throws drops that item to `null`. Stages get `(prev, originalItem, index)`.
- `phase(title)` / `log(msg)` → progress (stderr).
- `args` → the value passed via `--args` / `--args-file`.
- `budget` → `{ total, spent(), remaining() }` (token accounting).
- `workflow(ref, args?)` → run another script inline (one level). `ref` is a
  `{ scriptPath }`, a path string, or a saved-workflow **name** resolved from
  `.claude/workflows/` then `~/.claude/workflows/`.

Key `agent()` opts: `schema` (JSON Schema → Codex `outputSchema`, result parsed),
`model` (Claude ids/aliases auto-map to a Codex model), `agentType` (loads
`.claude/agents/<name>.md` as the system prompt), `systemPrompt`, `effort`
(usually omit — let `--auto-effort` scale it to layer width; see *Effort*),
`sandbox` (`read-only` | `workspace-write` | `danger-full-access`), `isolation:
'worktree'`, `cwd`, `personality`, `retries`, `label`, `phase` (group/attribute
this agent — set it inside concurrent `pipeline`/`parallel` stages), `timeoutMs`.

Read **`references/authoring.md`** for the full guide and the standard quality
patterns (adversarial verify, judge panel, loop-until-budget, multi-modal sweep),
and **`examples/`** for runnable templates (`hello.workflow.js`,
`review.workflow.js`).

## Running

```
run-workflow <script.js>
  --args JSON | --args-file PATH   value exposed to the script as `args`
  --frontier       pin ALL agents to the auto-detected latest frontier model (recommended; overrides per-call model)
  --pin-model M    pin ALL agents to model M (overrides per-call model)
  --model M        fallback model when not pinned; Claude ids/aliases auto-map
  --effort E       none|minimal|low|medium|high|xhigh; flat fallback; unset → Codex config default
  --auto-effort    scale effort to layer width: 1→xhigh, 2+→high (floor) (recommended; overrides --effort)
  --pin-effort E   force ALL agents to effort E (overrides per-call effort)
  --sandbox S      read-only | workspace-write | danger-full-access  (default workspace-write)
  --budget N       token ceiling backing budget.total / budget.remaining()
  --budget-meter M what budget.spent() counts: total (default) | output (native pool)
  --plan           dry run: count agents per phase/effort + estimate a --budget (no tokens)
  --tui            open a LIVE ASCII map of the run in a new terminal window
  --gui            open a LIVE HTML viewer of the run in your browser (--monitor = both)
  --retries N      transient-error retries per agent (default 3)
  --resume         reuse prior results from the journal (skip unchanged agents)
  --journal PATH | --fresh | --no-journal
```

- **Live monitoring (`--tui` / `--gui`)** — when the user wants to *watch* the run,
  add `--tui` and/or `--gui`. The runner auto-opens a live monitor that tracks the
  journal + event stream as the run progresses, showing **every agent (running +
  done)** with constant updates: `--tui` opens the ASCII execution map in a new
  terminal window; `--gui` opens the self-contained HTML viewer in the browser;
  `--monitor` opens both. They run alongside the workflow (which still prints its
  result JSON to stdout as usual), so pass them in addition to `--frontier
  --auto-effort`. Both need journaling (not `--no-journal`).

- **Cost** — a run can spawn many agents and use real tokens. Keep the single
  frontier model (see *Model*) and bound cost with `--auto-effort` (already
  cheaper on wide layers) plus a `--budget` backstop — **not** by downgrading to a
  smaller model. To squeeze further, `--pin-effort low`. Use `--sandbox read-only`
  unless agents must edit files.
- **Sizing `--budget`** — it is a *hard ceiling that throws mid-run*, not an
  advisory: size it for the **whole fan-out**, not one agent. Run **`--plan`**
  first — a no-token dry run that counts agents per phase/effort and prints an
  estimated `--budget` (a lower bound for fan-outs sized from agent output). Rule
  of thumb: medium-effort frontier (`gpt-5.5`) spends **~0.3–0.5M tokens/agent**
  (reasoning included), so an N-agent run wants `--budget ≈ N × 500k` with
  headroom. (A 35-agent run blew past an 8M ceiling after only ~17 agents.)
  Tripping it isn't fatal — the CLI prints a ready-to-paste `--resume` command
  with a higher ceiling, and the cached agents replay at 0 tokens.
- **Effort (important)** — prefer **`--auto-effort`**, which sets each agent's
  effort from its layer's parallel width (1→`xhigh`, 2+→`high`; the floor is
  `high`; see *Effort*). Otherwise the runner only sends an effort when you set one (per-call
  `effort` or `--effort`); when **nothing** is set, each agent inherits the Codex
  config default — `model_reasoning_effort` in `~/.codex/config.toml`, currently
  `xhigh` — so an effort-less workflow runs **every** agent at the highest tier
  (slow and token-heavy across a fan-out). So for any multi-agent run, pass
  `--auto-effort` (best) or at least a flat `--effort`; never leave effort
  unspecified.
- **Resume** — every run journals each completed `agent()` result. If a run is
  interrupted or trips `--budget`, rerun with `--resume` (and the **same**
  model + effort flags + sandbox) — completed agents return from cache (0 tokens)
  and only the rest run. The effective effort is part of each agent's cache
  identity, so toggling `--auto-effort`/`--pin-effort` between runs re-runs the
  agents whose effort changed. `--fresh` discards the journal.

## Behaviors to know

- **Isolation** — the script runs in a locked-down `node:vm` context: it can only
  coordinate agents, with no `process`/`fetch`/`require`/`import()`/`fs`/timers.
  The *agents* do all file/command I/O (via the Codex sandbox). Don't write a
  script that tries to read files itself — have an `agent()` do it.
- **Model mapping** — a script that requests `claude-opus-4-8` or a bare
  `opus`/`sonnet`/`haiku` is remapped to an available Codex model. Don't rely on
  that: set the frontier model explicitly with `--model gpt-5.5` (see *Model*)
  and keep it identical for every agent.
- **Determinism** — `Math.random()`, `Date.now()`, and argless `new Date()` are
  blocked inside scripts (they'd desync resume). Pass values via `args`.
- **Per-turn timeout, and "failed" ≠ "did nothing"** — each `agent()` turn must
  finish within **600s** (`codexAgent.js` default; raise it per-call with
  `timeoutMs` for a heavy agent). A single *monolithic* agent — huge input + long
  output + a file write — is the usual culprit and trips
  `Timed out waiting for app-server notification`. Two takeaways: (1) split heavy
  synthesis/report stages or bump their `timeoutMs`; (2) a timed-out/"failed" run
  may have **already written files and journaled completed agents** — inspect the
  workspace and `.workflow-journal/<name>.jsonl` *before* redoing work, then
  `--resume` to finish (or assemble the final artifact from the journal results).
- **Limits** — up to `min(16, cores−2)` agents run concurrently; 1,000 per run.

## When not to use

- The user wants **Claude** subagents → use the native Workflow tool, not this.
- A single quick task that doesn't need fan-out → just do it directly.
- The user wants the in-app `/workflows` progress UI or to save a `/command` —
  that's the native feature; this skill is a standalone Codex-backed runner.

## View a past run

Every completed run leaves a journal at `<project>/.workflow-journal/<name>.jsonl`.
To inspect it as a polished GUI, generate a self-contained HTML viewer:

```bash
node ~/.claude/skills/codex-workflows/runner/bin/view-run.js <project-dir> --open
```

For a terminal-native view (no browser), render the run as an **ASCII map** —
add `--watch` to redraw it live as the run progresses:

```bash
node ~/.claude/skills/codex-workflows/runner/bin/map-run.js <project-dir> [--watch]
```

It auto-finds the journal and the `*.workflow.js` script in that dir (or pass
`--journal PATH` / `--script PATH` / `--out PATH`), writes `<name>.run.html`, and
`--open` launches it. Offline/self-contained (data embedded). Per-agent **tokens,
time, model, and effort** (recorded by the runner) show per agent, per phase, and
per run; add **`--watch`** to rebuild the HTML live as a run progresses. Two views,
toggled top-right:

- **◇ Map** (default) — the execution map: orchestrator → one row of parallel
  agents per phase → barrier merges → result, with connectors. Click any agent
  node for a slide-in drawer with its full result. It **opens at a readable 100%**,
  centered/top-anchored; scroll-wheel zooms toward the cursor, drag empty space to
  pan, and the bottom-right `− / + / ⤢ Fit` controls (keys `F`=fit whole graph,
  `0`=reset to 100%, `+`/`−`) let you frame the whole run or zoom into a cluster.
- **☰ Tree** — a `Run → Phase → Agent` sidebar with a detail pane (the dense,
  read-everything layout).

A **Dark / Light** toggle (top-right) switches themes; the light/cream theme is a
clean diagram style (black orchestrator/result nodes, white agent nodes, dark
arrows). Both views render results generically: tables for arrays-of-objects,
color swatches for palettes, severity/effort badges, 1–10 score pills, and a
raw-JSON toggle per agent.

It works for **any** run: barrier/phase or pipeline shapes, flat label-less runs
(grouped under one phase), huge fan-outs (phases over ~12 agents collapse to a
"+N more" node in the map; the Tree shows all), journal-only runs with no script
(no model chips), and string/null results. `runner/test/view-run.test.js` smoke-
renders all these shapes.

## References

- `references/authoring.md` — full DSL + standard quality patterns.
- `references/runner-readme.md` — architecture, the Codex protocol mapping,
  faithfulness vs. the native runtime, and limits.
- `examples/hello.workflow.js`, `examples/review.workflow.js` — runnable templates.
