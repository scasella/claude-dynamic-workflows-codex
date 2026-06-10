# Fleet: concurrent workflows, one supervisor

Two variants hunt the **same goal** on **different bets** — `hunt-deep` (one
long-lived investigator, steered between rounds on a warm thread) and
`hunt-wide` (independent sweeps over evidence angles + refute-by-default
verification). They run **concurrently in this directory**, and a supervisor —
a human in a second terminal, or Claude itself via `/codex-workflows --multi` —
runs the loop: poll, answer, steer, kill, fork, synthesize.

Nothing here is fleet-*specific* machinery: it's the ordinary runner plus three
conventions — one directory per fleet, `--interactive` on every run, and
`human()` checkpoints at the steerable junctures.

## 1 · Launch (both in the background)

```bash
cd examples/fleet
RUNNER=../../runner

node $RUNNER/bin/run-workflow.js hunt-deep.workflow.js \
  --frontier --auto-effort --interactive --budget 1200000 1>deep.result.json 2>deep.log &
node $RUNNER/bin/run-workflow.js hunt-wide.workflow.js \
  --frontier --auto-effort --interactive --budget 3500000 1>wide.result.json 2>wide.log &
```

Each gets its own journal under `.workflow-journal/` (distinct scripts →
distinct journals; same-script variants would add `--run-id <name>`). Pass
`--args '{"goal":"…"}'` to point both at your actual symptom.

> **Budget sizing:** agents that *read a repo or corpus* cost **~500k tokens
> each regardless of effort tier** (input dominates — measured: 4 low-effort
> sweeps = 2.1M). Size read-heavy fan-outs by that, not `--plan`'s per-effort
> estimate. Tripping a ceiling is recoverable — `--resume` replays completed
> agents *and journaled gate answers* free — but costs a supervision round-trip.

## 2 · Supervise

```bash
node $RUNNER/bin/fleet.js status .          # --json for a parseable digest
# watching alongside? in-place terminal redraw, or a browser dashboard:
node $RUNNER/bin/fleet.js status . --watch
node $RUNNER/bin/fleet.js status . --watch --html fleet.html --open
```

```text
fleet: 2 runs — 2 running  ⚠ 1 needs attention

▶ fleet-hunt-deep — running 3m12s · phase Investigate (1/2) · 1 done + 1 running · 412k tok / 1.2M budget
  ⚠ waiting 41s on [human:round1#0] “Deep investigator, round 1: …FINDING: connection pool
    re-created per request… Directive for round 2?”  choices: continue|stop  default: stop
    → fleet.js answer --journal …/hunt-deep.workflow.jsonl --id 'human:round1#0' --answer '<text>'
▶ fleet-hunt-wide — running 3m05s · phase Sweep (1/3) · 2 done + 2 running · 388k tok / 1.5M budget
```

React to what the digest surfaces:

```bash
# A checkpoint is a steer channel — free text IS the directive:
node $RUNNER/bin/fleet.js answer --journal .workflow-journal/hunt-deep.workflow.jsonl \
  --id round1 --answer 'pool lead is plausible — verify it against the staging config before going deeper'

# A choice gate takes the choice:
node $RUNNER/bin/fleet.js answer --journal .workflow-journal/hunt-wide.workflow.jsonl \
  --id scope --answer high-only

# Stalled or dead-end run? Kill its process (fleet status shows the pid), then either
# harvest what's journaled or resume it later — completed work replays at 0 tokens:
node $RUNNER/bin/run-workflow.js hunt-wide.workflow.js --resume --frontier --auto-effort --interactive

# Fork a run that's onto something: copy the journal, rerun an edited variant against
# the copy — the unchanged prefix replays free; sessionful workers re-attach WARM:
cp .workflow-journal/hunt-deep.workflow.jsonl .workflow-journal/hunt-deep-fork.jsonl
node $RUNNER/bin/run-workflow.js hunt-deep-fork.workflow.js \
  --journal .workflow-journal/hunt-deep-fork.jsonl --resume --frontier --auto-effort --interactive
```

Stepping away? Launch with `--notify-cmd` and a pending gate **pushes** to you
instead of waiting to be polled (the event JSON arrives in `$WORKFLOW_EVENT`):

```bash
… --notify-cmd 'osascript -e "display notification \"workflow gate pending\" with title \"fleet\""'
```

Unanswered gates **never hang** the fleet: `hunt-deep` defaults to `stop`
(don't spend unsupervised), `hunt-wide` to `all` (the thorough default). The
supervisor's answers are journaled, so a `--resume` replays them instead of
re-asking — and the same gates stay human-answerable in the `--gui` cockpit.

## 3 · Harvest

```bash
node $RUNNER/bin/fleet.js status . --json   # states, per-run tokens, results
cat deep.result.json wide.result.json       # the variants' returns
node $RUNNER/bin/summarize-run.js . --list  # per-run cost breakdowns
```

Synthesize across variants: where they **agree** you have convergent evidence
from independent harnesses; where they conflict, the refuted/killed side is a
finding too. To size everything first: both scripts are `--plan`-safe (the
checkpoints answer themselves with their defaults; no tokens spent).

The `/codex-workflows --multi` skill mode runs this entire loop for you —
Claude compiles the variants, launches them, answers the gates with its full
conversation context, and writes the cross-variant synthesis.
