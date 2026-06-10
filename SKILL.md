---
name: codex-workflows
description: >-
  Run a dynamic-workflow script on a local Codex App Server — orchestrate many
  Codex / GPT agents (the agent / parallel / pipeline / phase / budget DSL)
  instead of Claude subagents, for codebase audits, large migrations, and
  multi-agent review or research. Give it one or two rough sentences and it
  compiles the right harness for you; add --multi for a supervised fleet of
  concurrent workflows. Manual-invoke only via /codex-workflows.
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

`RUNNER` below means the bundled runner directory: **`runner/` relative to this
skill's base directory** (shown when the skill loads). For a classic skills-dir
install that is `~/.claude/skills/codex-workflows/runner` — the literal paths in
the examples below assume it; substitute your base directory if this skill is
installed as a plugin. It is dependency-free Node ≥ 18.

## Default rough-intent mode

**One or two rough sentences is enough.** You do not need to hand this skill a
fully-engineered spec — describe what you want (e.g. `/codex-workflows Harden this
goal before I run it`) and the skill compiles it into an operational harness itself:
it classifies the job, picks the smallest workable scale, an archetype, and a
harness pattern, builds a task contract, composes phases, casts personas, applies
the quality/epistemic standards, authors the script, picks safe run settings, and
runs it — **stating its assumptions** as it goes.

Operating rules in this mode:

- The rough intent is the contract. Make reasonable assumptions for anything left
  unspecified and **state them**; do not interrogate the user with follow-ups.
- Choose the **smallest useful harness**, not the largest possible one (see the
  *Anti-overbuild rule*).
- **Do not emit a giant prompt for the user to paste back.** Compile and proceed to
  authoring/running. (The one exception is `prompt-only` mode — see *Mode detection*.)
- This **replaces any external "metaprompt"**: the expansion now happens inside the
  skill. The whole *Compiling rough intent into a workflow* section below is that
  compiler.

## Default execution checklist

Every run, in order (the sections below expand each step):

1. **Preflight** Codex once (`handshake.js`); note the latest frontier model.
2. **Compile** the rough intent: classify the job → scale → archetype → pattern
   (name the failure mode it prevents) → task contract. **State your assumptions.**
3. **Author** the script into the repo (`./<name>.workflow.js`).
4. **Settings:** `--frontier` · effort by scale (`--effort medium` for a
   `quick_harness`, `--auto-effort` for `standard`/`deep`) · `--sandbox read-only`
   unless it must write · a bounded `--budget` · strict schemas (`additionalProperties:false`).
5. **Size it** — run `--plan` first for any expensive or complex workflow.
6. **Run** on the Codex runner (never the native `Workflow` tool).
7. **Surface** — inline ASCII map + `summarize-run` highlights; cite the script,
   journal, viewer, report, and run-summary paths (see *Output behavior*).

## Mode detection

Read the mode from the user's phrasing, then behave accordingly:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **default** (rough-intent) | 1–2 rough sentences | Compile internally → author → run. State assumptions. |
| **`--multi`** (fleet) | the `--multi` flag, or "fleet" / "several workflows at once" | Compile a **fleet plan** (2–4 concurrent variant workflows, similar and/or diverse), launch them in the background, and **supervise**: poll `fleet status`, answer gates, steer, kill, fork, then synthesize. See *Fleet mode*. |
| **`prompt-only`** | "prompt-only", "just the invocation", "don't run it" | Emit a complete `/codex-workflows` invocation/spec (the A–L structure below) and **STOP** — do not author or run. |
| **`write-only`** | "write it but don't run", "author only" | Author the workflow script, print its path, stop before running. |
| **`run-existing`** | a script path or saved-workflow name is given | Skip compilation; run that script/name through the runner. |
| **`quick`** | "quick", "small", "cheap" | Bias to a `quick_harness` (2–5 agents). |
| **`deep`** | "deep", "thorough", "exhaustive" | Allow a larger / `deep_harness`; justify the size. |
| **`no-write`** | "don't write files", "just tell me" | Return final JSON/Markdown only; no report/source files; `--sandbox read-only`. |

Two precedence rules: if the user gives a **script path or saved name**, run it
(don't recompile). If the user gives a **detailed spec**, honor it as written but
still apply the safety + run defaults below. Otherwise it's rough intent → compile.

In **`prompt-only`**, the invocation you emit follows the same A–L structure the
skill builds internally: **A** name · **B** purpose · **C** task contract · **D**
inputs / context reconstruction · **E** phases · **F** personas · **G** anti-wrapper
standards · **H** outputs · **I** run settings · **J** safety / epistemics · **K**
final-response format · **L** productization. Then stop — do not run.

## The loop

In default rough-intent mode, do steps 1–2 **silently** and state your assumptions
before authoring. The mechanics below — handshake, the run command, the inline map —
are unchanged; steps 2 and 4 are where rough intent gets compiled.

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

2. **Compile** the rough intent into a workflow (see *Compiling rough intent into a
   workflow*): classify the job → pick the scale → pick the archetype → pick the
   pattern and name the failure mode it prevents → build the task contract → compose
   the phases → cast the personas → apply the standards. **State the resulting
   assumptions** to the user before authoring.

3. **Author** a workflow script from that compile (see *Authoring*). Write it into
   the user's project so they can read and rerun it — `./<name>.workflow.js`, or
   `workflows/<name>.workflow.js` / `examples/harness-zoo/<name>/` for a reusable
   harness. Scripts are plain JavaScript using only the injected globals (no imports).

4. **Choose run settings** (see *Run defaults*): `--frontier`, the effort flag for
   the chosen scale (`--auto-effort` for a standard/deep harness, `--effort medium`
   for a quick one), a read-only sandbox unless the run must write, and a bounded
   `--budget`. For an expensive or complex workflow, **`--plan` first** — a no-token
   dry run that counts agents per phase/effort and estimates a `--budget`.

5. **Run** it — **always pass `--frontier`**, plus the effort flag for the chosen
   scale: `--auto-effort` for a standard/deep harness (it scales each agent's effort
   to its layer's parallel width, so lone synthesis/judge gates think hardest), or
   `--effort medium` for a quick harness (see *Effort*). `--frontier` pins every
   agent to the latest frontier model (see *Model*):
   ```bash
   node ~/.claude/skills/codex-workflows/runner/bin/run-workflow.js <script.js> --frontier --auto-effort [other flags]
   #   quick_harness:  … <script.js> --frontier --effort medium [other flags]
   ```
   Progress streams on **stderr**; the workflow's return value prints as JSON on
   **stdout**. Capture stdout for the result (`… 1>/tmp/result.json`) when it's
   large. To **watch the run live**, add `--tui` (live ASCII map in a new terminal
   window) and/or `--gui` (live HTML viewer in the browser) — see *Running → Live
   monitoring*.

6. **Surface** the result to the user (see *Output behavior*) — summarize it,
   mention the script path, and **render the run's ASCII map inline in this
   conversation** so they see the execution graph natively (no window to open):
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

   The run also prints a one-line cost/reliability recap when it finishes. For a
   fuller breakdown — tokens by phase, the costliest/slowest agents, and any red
   flags (many nulls, an un-staged huge fan-out, default-effort cost) — run
   `summarize-run` on the journal and fold the highlights into your reply (see
   *Summarize a run*).

**Do NOT call the native `Workflow` tool while using this skill.** Authoring the
script and running it through the CLI above is exactly what routes the work to
Codex; invoking the native tool would spawn Claude subagents instead.

## Fleet mode (`--multi`): launch, supervise, steer

When the user passes **`--multi`** (or asks for a fleet / several workflows at
once), **you are the operator of N concurrent runs** — not a fire-and-forget
launcher. You compile a fleet plan, launch every variant in the background,
then run a supervision loop: poll status, answer gates, steer drifting workers,
kill dead ends, fork promising leads, and synthesize at the end. The human sets
policy once (goal, total budget, risk tolerance); **you** make the mid-run
judgment calls the variants can't make for themselves.

### 1 · Compile the fleet plan

Decompose the intent into **2–4 variants** and state the plan (variants, what
each bets on, per-run budgets) before launching. Two axes, freely mixed:

- **Similar** — the *same* harness, different slices: split a big input across
  runs via `--args`, or attack the same question from different starting
  hypotheses/seeds. One script + per-run `--args` + **`--run-id`** (so the
  journals don't collide), or N copies of the script.
- **Diverse** — *different* harness shapes betting on different theories of the
  task: e.g. a `loop_until_dry` bug hunt vs an `adversarial_verification` sweep
  vs a `sessionful_controller_loop` investigation, all aimed at the same goal.
  One script per variant.

Split the user's overall budget across variants (status shows each run's
spend against its ceiling). **Size read-heavy fan-outs realistically:** an
agent whose job is *reading a repo/corpus* costs **~400–600k tokens
regardless of its effort tier** — the input dominates, so `--effort low`
does not make a sweep cheap, and `--plan`'s per-effort estimate undercounts
it (measured: four "low" sweeps = 2.1M, 525k each, vs a 150k/agent plan
estimate). At `xhigh` — which `--auto-effort` gives every sessionful worker's
turns (width 1) — a reading turn runs **~1–1.5M** (measured: a walkthrough
worker's first turn + one steer tripped a 2.5M ceiling). Budget ≈
`readers × 500k + xhigh reading turns × 1.2M + non-readers × the plan
estimate`, with headroom. A tripped ceiling is recoverable (`--resume` replays the
prefix free) but costs a supervision round-trip. Apply the *Anti-overbuild
rule* to the fleet too: 2 well-differentiated variants beat 4 redundant ones
— every variant must bet on something the others don't.

### 2 · Author for supervision

Every variant gets **supervisor checkpoints** — `human()` gates at the
junctures where an outside judgment can redirect the run:

```js
const directive = await human(
  `Round ${round} findings: ${summary}. Directive for next round?`,
  { id: `round${round}`, choices: ["continue", "stop"], default: "continue", timeoutMs: 240_000 })
if (directive === "stop") break
if (directive !== "continue") await worker.steer(directive)   // free text = a steer
```

This is the steer channel: a free-text answer **is** the directive, and the
script applies it (`session.steer(...)`, re-aiming the next round, narrowing
scope). Place gates between rounds, before expensive phases, and on
uncertainty. Defaults must be safe — an unanswered gate times out to its
default and the run degrades hands-off, never hangs. (This rides the journaled
`human()` channel, so a `--resume` replays answers instead of re-asking.)

### 3 · Launch — one directory per fleet, every run in the background

Variants share one directory (that's what `fleet status <dir>` supervises).
Launch each with `run_in_background`, **always with `--interactive`** (it
enables the answer channel headlessly):

```bash
node ~/.claude/skills/codex-workflows/runner/bin/run-workflow.js hunt-orm.workflow.js \
  --frontier --auto-effort --interactive --budget 1500000 1>hunt-orm.result.json
# same script, different slice → isolate with --run-id:
node …/run-workflow.js hunt.workflow.js --args '{"slice":"auth"}' --run-id auth --interactive …
```

### 4 · Supervise — the loop

Poll the fleet digest between other work (and promptly while gates may be
pending — they time out to defaults). For long unattended stretches, add
`--notify-cmd` at launch so a pending gate *pushes* instead of waiting to be
polled (e.g. append `$WORKFLOW_EVENT` to a file you watch, or a macOS
`osascript` notification):

```bash
node ~/.claude/skills/codex-workflows/runner/bin/fleet.js status <fleet-dir>   # --json to parse
```

(When the *user* wants to watch alongside you, add `--watch` for an in-place
terminal redraw, or `--html fleet.html --open` for a card-per-run browser
dashboard that auto-refreshes while runs are live.)

One line per run — state (running / completed / stopped / idle), phase + agent
progress, tokens vs budget — plus an ⚠ line per condition needing you. React:

| Signal | Your move |
|--------|-----------|
| ⚠ waiting on `[id]` "question" | Decide with your full conversation context, then `fleet.js answer --journal <J> --id '<id>' --answer '<choice or free-text directive>'` (`--answer-json` for structured) |
| ⚠ stalled (no activity past threshold) | Inspect its stderr/`--gui`; if hopeless, kill the background task, then rerun with `--resume` (completed agents replay at 0 tokens; sessionful workers re-attach to their threads **warm**) |
| A run chasing a dead end | Kill its task; note why, fold the negative result into the synthesis |
| A run onto something big | **Fork it**: copy the journal to a new name, point an edited/extended variant at it with `--journal <copy> --resume` — the unchanged prefix replays free and only the new direction spends tokens |
| ⚠ at/over budget · `stopped` | Decide: resume the most promising with a higher `--budget`, or harvest what's journaled (`summarize-run` shows where the tokens went) |

### 5 · Harvest and synthesize

When all runs are terminal: read each run's result (`<journal>.result.json` or
the stdout you captured), reconcile agreements/conflicts across variants, and
report **per-variant**: what it bet on, what it found, what it cost
(`fleet.js status --json` has tokens; `summarize-run` has the breakdown).
Negative results from killed runs are findings too. To **chain** fleets, feed
one run's `result.json` into the next launch's `--args-file` — composition
happens at this level, not inside scripts.

## Compiling rough intent into a workflow

This is the skill's internal recipe — the work an external metaprompt used to do.
Run these eight steps in order during loop step 2. Keep it lightweight: the output
is a small task contract and a phase plan, not a document.

### 1 · Classify the job

What kind of work is it? This points you at the archetype. One of: **analysis ·
ideation · verification · experiment design · bounded execution · drafting ·
productization · goal hardening · run summarization · harness design.**

### 2 · Pick the harness scale

| Scale | Agents | Use for |
|-------|--------|---------|
| `quick_harness` | 2–5 | goal hardening, assumption checks, small critiques, quick ranking, small claim verification |
| `standard_harness` | 6–20 | repo analysis, research triage, product-spec review, policy drafting, claim checking, idea generation |
| `deep_harness` | 20+ / loops | broad discovery, tournaments, large artifact coverage, bounded empirical execution — **only when explicitly requested or clearly needed** |

**Rule: choose the smallest harness that can reliably solve the task** (see the
*Anti-overbuild rule*).

**Effort by scale:** a `quick_harness` runs at a flat **`--effort medium`** (or
`--pin-effort medium`) — a small analytical run doesn't need layer-scaled effort.
`standard_harness` and `deep_harness` run at **`--auto-effort`** (lone gates get
`xhigh`, fan-outs floor at `high`). See *Run defaults* and *Effort*.

### 3 · Pick the archetype

| Archetype | When to use |
|-----------|-------------|
| `goal_lint` ✓ | harden a vague Codex/Claude `/goal` before an expensive agent run |
| `claim_check` / `proofpack` ✓ | verify claims in a post / README / report / memo / result / agent output against repo artifacts or sources |
| `research_result_triage` | decide whether an experiment / benchmark / result is real, overfit, useful, or worth continuing |
| `next_experiment_designer` | design concrete next experiments, falsification gates, and Codex `/goal`s |
| `eureka_forge` | surprising, high-upside ideas: diverse personas, forced recombination, hidden mechanisms, falsification |
| `industry_invention_studio` | net-new-to-industry products: real pain, workflow novelty, prototype speed, defensibility, anti-wrapper, distribution wedge |
| `repo_deep_read` | deep analysis of a repo: what it does, how it works, what's novel, what's brittle, what's buildable |
| `autoresearch_epoch` | **actually run** bounded empirical experiments/evals (not just design them) — explicit execution only |
| `product_spec_review` | turn an idea into an MVP spec, architecture, risks, prototype plan, first build `/goal` |
| `policy_or_grant_builder` | an advocacy, policy, grant, research, or memo work product |
| `manuscript_or_citation_audit` | manuscript revision, citation checking, claim-support review, journal-fit editing |
| `investment_deep_dive` | source-grounded financial analysis, scenario valuation, thesis critique, portfolio fit |
| `root_cause_lab` | diagnose a failure / bug / flaky test / broken workflow / failed experiment / confusing logs |
| `agent_rule_miner` | mine recurring agent failures, review comments, or corrections into durable `CLAUDE.md` / `AGENTS.md` / workflow rules |
| `run_summary` ✓ | summarize a workflow journal: cost, phase timing, tokens, cached / failed agents, reliability warnings |
| `harness_forge` | design the best workflow/harness for a rough task rather than solving it directly |

✓ = a concrete template ships today: `goal_lint` → `examples/harness-zoo/goal-lint/`,
`claim_check` → `examples/harness-zoo/claim-check/` (the trust loop's "after"),
`run_summary` → `summarize-run.js` (see *Summarize a run*). The rest are **shapes to
author** from the patterns below, not prebuilt files. Note that `harness_forge` and
the `goal_contract_compiler` pattern are the skill's **own** meta-operations — the
default rough-intent path *is* essentially those two.

### 4 · Pick the pattern + name the failure mode

Choose one or more patterns; **state in your final reply which pattern you used and
the failure mode it prevents.**

| Pattern | Failure mode it prevents | Typical shape |
|---------|--------------------------|---------------|
| `fan_out_and_synthesize` | premature convergence / single-view bias | parallel independent answers → one synthesizer |
| `adversarial_verification` | unsupported claims, self-deception | each finding gets independent refuters; default refuted if weak |
| `generate_filter_improve` | thin-wrapper ideation | generate many → filter → improve the survivors |
| `tournament_or_pairwise_judgment` | weak ranking (unreliable 1–10) | pairwise / bracket; preserve high-upside losers |
| `loop_until_dry` | agentic laziness, missing coverage | keep finding until N dry rounds; dedup vs all-seen; max-round guard |
| `classify_and_act` | mis-routing mixed inputs | classify each input → route to the right agent |
| `quarantined_triage` | untrusted-input risk | untrusted readers (read-only) kept separate from privileged/write agents |
| `root_cause_hypothesis_lab` | confident wrong diagnosis | evidence streams generate competing hypotheses, then refute them |
| `fresh_context_review_gates` | self-preferential judging | producers never judge their own work; reviewers get artifacts + rubric only |
| `bounded_empirical_epoch` | metric gaming, runaway cost | run evals with keep/discard rules + a hard budget/round cap |
| `goal_contract_compiler` | vague goals, missing artifacts/falsification | compile intent → objective, non-goals, allowed actions, success/failure, artifacts, stop |
| `sessionful_controller_loop` | babysitting, lost worker context, blind fan-out | spawn long-lived `agent.start` workers → `agent.waitAny` for the first → a **controller agent** decides accept / steer (same thread) / spawn / verify / stop → human only at checkpoints |

Full failure-mode vocabulary to draw from: **agentic laziness · vague goals ·
self-preferential judging · unsupported claims · context contamination · weak
ranking · premature convergence · thin-wrapper ideation · untrusted-input risk ·
overbuilding · missing artifacts · missing falsification · metric gaming · source
fabrication · file-edit collisions · runaway cost.**

### 4b · One-shot `agent()` vs sessionful workers

Most workflows use one-shot `agent()` — a fresh thread+turn per call, which is what
fights goal drift and self-preferential bias, and it's the only **resumable** form.
Reach for **sessionful workers** (`agent.start` / `agent.waitAny` / `session.steer`)
only when the job genuinely needs a worker to *keep its context across turns*:

**Use sessionful when** —
- a child worker may need **follow-up steering on the same context** (steer it, don't
  restart it from a cold prompt);
- the workflow benefits from **waiting for the first of several** long-running workers
  (`agent.waitAny`) and reacting, rather than blocking on all of them;
- a **controller loop** will inspect snapshots and decide accept / steer / spawn /
  verify / stop (the `sessionful_controller_loop` pattern);
- the task is **exploratory, long-running, or iterative** (investigation, debugging,
  incremental build-and-correct).

**Prefer one-shot `agent()` when** —
- the work is **one-shot** (a finding, a judgment, a synthesis);
- **independent fresh-context review** is the point (review gates, adversarial verify
  — a steered worker carries bias forward);
- the work is a **pure cacheable artifact** (sessions resume warm via
  `thread/resume`, but one-shot replay never depends on a persisted rollout);
- no follow-up steering is expected.

**Compile, don't babysit.** When you author a sessionful workflow, the human sets
**policy** (goal, budget, sandbox, **involvement mode**, stop/escalation triggers) —
they do *not* steer each child. A **controller agent** makes the semantic call; the
script enforces it; the human re-enters only at a checkpoint. Declare an involvement
mode and default to **`checkpointed`**:
- `hands_off` — never pause; safe defaults, mark uncertainty, avoid risky/destructive
  actions.
- `checkpointed` *(default)* — pause only at plan / write / budget / scope gates.
- `interactive` — pause at declared forks via the `human(question, { id, choices,
  default, timeoutMs })` global: with `--gui` the live viewer shows an answer card;
  with `--tui`/`--interactive` the human appends to `<journal>.answers.jsonl`. It
  resolves from `args.checkpointAnswers` / the journal (`--resume` never re-asks)
  before the live channel, and falls back to `default` on timeout — never hangs.

Never make the workflow block on live human input. When a decision truly needs a
human (scope, cost, risk, destructive action, value judgment), **return** a
structured checkpoint — `{ status: "needs_human", question, choices?,
recommendedDefault, reason, ledger, resumeInstructions }` — and stop. The pattern is
in `examples/sessionful-workers.workflow.js` and `references/authoring.md` →
*Sessionful workers*.

### 5 · Build the task contract

A small contract that guides the script. Define: **objective · non-goals ·
assumptions · allowed files/actions · forbidden files/actions · success criteria ·
failure criteria · required artifacts · stop condition · human-review triggers (if
any) · sandbox requirement** — and classify the workflow as **read-only**,
**report-writing**, or **execution-capable**. (This mirrors GoalLint's
`hardened_goal` schema — see `examples/harness-zoo/goal-lint/`.)

**Inputs & context reconstruction.** Tell agents which local files/dirs to inspect
to reconstruct project state — likely: `README.md`, `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `workflows/`, `examples/`, `reports/`, `results/`, `runs/`, `logs/`,
`docs/`, `experiments/`, `data/`, `.workflow-journal/`, and recent artifacts.
Require the workflow to **infer state and state its uncertainty**. If freshness or
external/current facts matter and there is no source/web access, require a
**source-gap report rather than fabrication**.

### 6 · Compose phases

Pick only the phases the chosen scale needs (a `quick_harness` may be just two):

| Phase | What it does |
|-------|--------------|
| Context reconstruction | reconstruct objective, assets, recent attempts, constraints, success criteria, uncertainty |
| Inventory | locate relevant files, reports, logs, journals, code paths |
| Diverse fanout | parallel agents with genuinely different cognitive roles (not superficial personas) |
| Discovery loop | loop-until-dry; dedup vs **all** seen items; hard max-round / budget guard |
| Cross-pollination | force recombination across pains / mechanisms / user types / primitives / wedges / failures / analogies |
| Adversarial verification | independent verifiers; **default to refuted/unsupported if evidence is weak** |
| Harsh critique | skeptics attack novelty, feasibility, self-deception, overbuild, thin-wrapper, metric gaming, source weakness |
| Tournament / pairwise | rank where 1–10 is unreliable; **preserve weird/high-upside losers separately** |
| Scoring | structured dimensions; prefer pairwise over 1–10 for subjective taste |
| Fresh-context review gate | producers don't judge themselves; reviewers get artifacts + rubric, not self-justification |
| Portfolio synthesis | select best outputs **by category**, not one winner |
| Goal writer | write strict Codex `/goal`s for the top 1–3 next actions |
| Report writer | `reports/<name>.md` when workspace-write is allowed, else Markdown in the final JSON |
| Run summary | for an existing journal: agents / cached / failed, tokens by phase, slowest / costliest, model·effort, warnings, a `--resume` hint |

### 7 · Cast personas

Use **functional** personas (each performs a specific operation) — never generic
"optimist / pessimist."

- **Ideation:** Falsifier · Signal Miner · Mechanism Theorist · Benchmark Surgeon ·
  Weird Analogist · Toolsmith · Workflow Anthropologist · Developer-Tool Founder ·
  Enterprise Buyer · OSS Maintainer · Eval Maximalist · Agent-Ops Engineer ·
  Historical Skeptic · Product Translator · Alien Reviewer · Bitter Reviewer ·
  Regulated-Workflow Designer · Skeptical Customer · Timing Critic · Wrapper Critic.
- **Verification:** Claim Extractor · Evidence Finder · Refuter · Source-Freshness
  Checker · Counterexample Finder · Methodology Reviewer · Artifact Auditor ·
  Reproducibility Reviewer.
- **Debugging / root cause:** Log Reader · Code-Path Tracer · Environment/Resource
  Investigator · Recent-Diff Reviewer · Hypothesis Generator · Hypothesis Refuter ·
  Minimal-Repro Designer · Fix-Scope Controller.

### 8 · Apply standards

**Anti-wrapper** (ideation / product archetypes): reject generic "AI assistant for
X" and "LLM + UI" unless there is a new workflow primitive / provenance / eval loop /
artifact graph / coordination / memory / trust mechanism / distribution wedge.
Reject "run more seeds / scale up / improve prompts / add RAG / make a dashboard"
unless tied to a non-obvious mechanism **and** a falsification test. Favor ideas
where the hard part is **evidence, workflow, eval, provenance, memory, coordination,
or trust** — not the model call — that **change a workflow** (not just automate a
task) and carry **hard-to-fake usefulness signals**.

**Epistemic discipline** (always): state assumptions; don't overclaim; separate
confirmed evidence from plausible inference; never fabricate current facts or source
support; preserve uncertainty; include adversarial review where claims could be
wrong; give falsification criteria for claims / experiments / hypotheses; no producer
self-judging; don't modify source unless explicitly requested; keep untrusted-input
readers separate from privileged/write agents; **treat missing metrics, artifacts,
or source evidence as failure or uncertainty — not success.**

### Anti-overbuild rule

Not every rough intent needs a fleet. Simple task → `quick_harness`. One-off
analysis → don't write files you weren't asked for. Use a `deep_harness` only when
breadth / loops / tournaments are clearly justified. Overbuilding is itself a
failure mode: don't turn "check my README for typos" into a 12-agent panel.

## Run defaults

Policy for every run (flag *syntax* and precedence live in *Running* and *Effort* —
this section is the policy, not the reference):

| Situation | Setting | Why |
|-----------|---------|-----|
| Always | the Codex runner, **not** the native `Workflow` tool | routes work to Codex/GPT, not Claude subagents |
| Always | write the script into the repo | reproducible and rereadable |
| Model | `--frontier` | one frontier model for every agent (see *Model*) |
| Effort — `quick_harness` | `--effort medium` (or `--pin-effort medium`) | a small analytical run doesn't need layer-scaled effort; a flat, cheaper tier suffices |
| Effort — `standard` / `deep` | `--auto-effort` | scales effort to layer width; lone synthesis/judge gates get `xhigh`, fan-outs floor at `high` |
| Default sandbox | **`--sandbox read-only`** (pass it explicitly) | the runner's own default is `workspace-write` — don't rely on it |
| Writing a report / running experiments / requested edits | `--sandbox workspace-write` | only when the run must write |
| Never (unless explicitly requested **and** justified) | `--sandbox danger-full-access` | unsandboxed |
| Cost | a bounded `--budget`, sized via `--plan` | hard ceiling; `--plan` estimates it |
| Expensive / complex run | **`--plan` first** | no-token dry run before the live run |
| Structured output | JSON schemas with `additionalProperties: false` | strict and parseable |
| After the run | viewer via `view-run.js --open`; summary via `summarize-run.js` or `--summary` | inspect cost / shape |

Three facts to encode correctly, since they're easy to get wrong:

- **No workflow linter exists** — the only pre-flight is **`--plan`**. Use it.
- **No `--concurrency` flag exists** — concurrency is fixed at `min(16, cores−2)`.
  Don't recommend one; if a run is resource / eval-bound, lower the fan-out width
  in the script instead.
- **`--summary` prints inline; `summarize-run.js --out PATH` writes a file** — use
  the latter when you need a run-summary *path*. The HTML viewer is a *file* from
  `view-run.js --open`; `--gui` is a *live window*, not a saved artifact.

**Productization** (for reusable harnesses): parameterize with `args`; avoid
hardcoded one-off paths; add a short README/usage note for a `harness-zoo` workflow;
name it for future install into `.claude/workflows/`; keep the script plain
JavaScript using only the injected globals (no imports / fs — agents do all I/O).

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

**For a standard or deep harness, pass `--auto-effort`** (a small `quick_harness`
runs at a flat `--effort medium` instead — see *Harness scale selector*). The runner
reads each layer's parallel width (the number of thunks in a `parallel()`, or items
in a `pipeline()` stage) and sets effort automatically:

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
backstop, or drop everything a tier with `--pin-effort medium`. For a small
`quick_harness`, flat **`--effort medium`** is the right default (cheaper, uniform);
the layer-aware policy matters most for multi-phase standard/deep runs.

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
- `human(question, { id, choices, default, timeoutMs })` → a **declared
  checkpoint fork** (the answerer can be a human *or* a supervising agent):
  resolves from `args.checkpointAnswers` / the journal first, then the live
  channel (`--gui` answer card, `fleet.js answer`, or the answers sidecar), else
  the default on timeout — never hangs unattended. Journaled (`--resume` never
  re-asks); not an agent. In fleet mode this is the **steer channel** — author
  gates whose free-text answers the script applies (see *Fleet mode*).
- `args` → the value passed via `--args` / `--args-file`.
- `budget` → `{ total, spent(), remaining() }` (token accounting).
- `workflow(ref, args?)` → run another script inline (one level). `ref` is a
  `{ scriptPath }`, a path string, or a saved-workflow **name** resolved from
  `.claude/workflows/` then `~/.claude/workflows/`.
- `agent.start(prompt, opts?)` → an **`AgentSession`** (long-lived worker; returns
  before the turn finishes). `agent.waitAny(sessions, opts?)` → the first actionable
  one. `session.steer(msg, {wait})` runs a follow-up turn **on the same thread**;
  `session.wait/poll/cancel/close`. Sessions resume **warm** on `--resume`
  (`thread/resume` re-attaches the persisted thread; completed turns replay free); use
  sessions for steerable/iterative work (see *4b · One-shot vs sessionful workers*).

Key `agent()` opts: `schema` (JSON Schema → Codex `outputSchema`, result parsed),
`model` (Claude ids/aliases auto-map to a Codex model), `agentType` (loads
`.claude/agents/<name>.md` as the system prompt), `systemPrompt`, `effort`
(usually omit — let `--auto-effort` scale it to layer width; see *Effort*),
`sandbox` (`read-only` | `workspace-write` | `danger-full-access`), `isolation:
'worktree'`, `cwd`, `personality`, `retries`, `label`, `phase` (group/attribute
this agent — set it inside concurrent `pipeline`/`parallel` stages), `timeoutMs`.

Read **`references/authoring.md`** for the full guide and the standard quality
patterns (adversarial / **majority refute-by-default** verify, judge panel,
**loop-until-dry**, **fresh-context review gate**, multi-modal sweep), and
**`examples/`** for runnable templates — `hello`, `review`, `bug-hunt`
(loop-until-dry + majority verify), `review-gates` (producer ≠ reviewer), and the
**sessionful** demos `sessionful-workers`, `warm-context-interrogation` (load once,
ask many), `flaky-bug-perturbation` (hold + perturb live state), `hedged-take-first-win`
(race + cancel), `lead-following-research`, `stateful-dialogue`, `agent-foreman`.

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
  --interactive    enable the human() answer channel headlessly — answered via
                   fleet.js answer (a supervising agent) or the answers sidecar
  --run-id NAME    suffix the default journal/sidecars so concurrent runs of the
                   SAME script don't collide (fleet mode)
  --notify-cmd C   run shell command C (detached, best-effort; event JSON in
                   $WORKFLOW_EVENT) when a gate goes pending / the run ends;
                   implies --interactive
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
  --auto-effort`. Both need journaling (not `--no-journal`). The `--gui` viewer
  updates **in place** (no reload/flicker), shows each running agent's **streaming
  output** in the drawer, and settles to the finished run automatically.

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
  **Read-heavy agents break the per-effort estimate**: an agent that reads a
  repo/corpus costs ~400–600k *even at `--effort low`* (input dominates) — cost
  those at ~500k each no matter the effort tier.
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
  that: pin every agent with `--frontier` (or `--pin-model gpt-5.5`) — see
  *Model*. (`--model` is only the *fallback* default; a per-call `model` in the
  script overrides it, so it does NOT guarantee one model for every agent.)
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

## Output behavior

When you surface the result (loop step 6), the final reply should include, as
relevant to the archetype:

- a concise **executive summary**;
- the **archetype and harness pattern** chosen, and the **failure mode** it prevents;
- the **assumptions** you made compiling the rough intent;
- the **strongest outputs** — top findings / ideas / experiments / claims /
  hypotheses — each with *why it matters*, *why it's non-obvious*, the *evidence for*
  it, the *evidence against or weakening* it, and *what would falsify* it;
- the **single best next action**;
- generated Codex **`/goal`** prompts, if relevant;
- **uncertainty and source gaps**, if relevant;
- **safety notes**, if relevant;
- **paths**: workflow script, journal, viewer, report/output artifacts, run summary.

Keep confirmed evidence separate from plausible inference, and don't overclaim —
missing metrics / artifacts / evidence are uncertainty, not success.

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
`--open` launches it. When a run directory holds **several** journals, all three
tools (`view-run`, `map-run`, `summarize-run`) default to the **most recently
modified** one; pass **`--list`** to see them all and **`--journal PATH`** to pick a
specific one. Offline/self-contained (data embedded). Per-agent **tokens,
time, model, and effort** (recorded by the runner) show per agent, per phase, and
per run; add **`--watch`** for a live monitor that updates **in place — no reload,
no flicker** (theme / view / selected node / open drawer / scroll / zoom all
survive each update). Two views, toggled top-right:

- **◇ Map** (default) — the execution map: orchestrator → one row of parallel
  agents per phase → barrier merges → **result**. Each node shows its model / time /
  tokens; click any for a **docked inspector** (the map stays visible behind it)
  with its full result — and a *running* agent **streams its partial output** there
  live. The **result** node shows the workflow's actual return value. Wide phases
  fold into an aggregate node you **expand inline** (running agents are never
  hidden); not-yet-started phases show a "pending" placeholder. Opens at a readable
  100%; `F`=fit whole graph, `0`=reset, scroll zooms toward the cursor, drag pans.
- **☰ Tree** — a dense `Run → Phase → Agent` inspector: phase **progress bars** with
  inline per-agent time / tokens / model, and the run's actual result at the top.

A **Dark / Light** toggle (top-right) switches themes; the light/cream theme is a
clean diagram style (black orchestrator/result nodes, white agent nodes, dark
arrows). Both views render results generically: tables for arrays-of-objects,
color swatches for palettes, severity/effort badges, 1–10 score pills, and a
raw-JSON toggle per agent.

It works for **any** run: barrier/phase or pipeline shapes, flat label-less runs
(grouped under one phase), huge fan-outs (phases over ~12 agents fold into an
aggregate node you expand inline; the Tree shows all), journal-only runs with no
script (no model chips), and string/null results. `runner/test/view-run.test.js`
smoke-renders all these shapes.

## Summarize a run

For a **cost / performance / reliability** report instead of a visual — what the
run cost, where the time and tokens went, and whether anything looks off — point
`summarize-run` at the journal (or run dir):

```bash
node ~/.claude/skills/codex-workflows/runner/bin/summarize-run.js <project-dir>
#   --json        structured (the summary object)        --markdown   paste-ready
#   --out PATH    write to a file                         --include-result  preview the return value
```

It reports agents (total / completed / null / cached / interrupted), agents·
tokens·agent-time **by phase**, the **top 10 costliest and slowest** agents, a
**model & effort** breakdown, **budget usage** (when the run recorded a ceiling),
and **cache hit rate** on a resumed run — plus warnings (missing metrics, many
nulls, interrupted agents, a single huge fan-out, default-effort cost). It's
**read-only** (never touches the journal) and handles older journals that predate
the per-agent metric fields. Use it to answer "how much did that cost / what was
slow / did it all complete?" Paste the text report inline, or `--markdown` for a
table. `run-workflow … --summary` prints the full report inline at the end.

## References

- `references/authoring.md` — full DSL + standard quality patterns.
- `references/runner-readme.md` — architecture, the Codex protocol mapping,
  faithfulness vs. the native runtime, and limits.
- `references/fleet-protocol.md` — the sidecar file contract behind fleet
  supervision (states, questions/answers, notify), for supervising or
  producing runs outside this runner.
- `examples/` — runnable templates: `hello`, `review`, `bug-hunt` (loop-until-dry +
  majority refute-by-default), `review-gates` (fresh-context review gate),
  `deep-research`, `tournament-sort`, `triage`, `classify-route`.
