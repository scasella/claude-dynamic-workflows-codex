# The fleet protocol — sidecar contract for supervisable runs

Fleet supervision (`fleet status` / `fleet answer`, the dashboard, the `--multi`
skill mode) is not coupled to this runner's internals. It is a **file
contract**: a run is supervisable if it writes a handful of sidecar files next
to a journal, and steerable if it polls one more. This document specifies that
contract precisely enough to implement a new producer (another runner, a raw
`codex` session wrapper, any long-running agent job) or a new consumer (a
different dashboard, a notifier, an autoscaler).

Everything here is what `runner/bin/run-workflow.js` writes and
`runner/src/fleetStatus.js` / `runner/src/runModel.js` read today;
`runner/test/fleet.test.js` exercises the contract end-to-end with no model
behind it — which is itself proof that the producer is swappable.

## Layout and naming

A *run* is identified by its **journal path**:

```
<run-dir>/.workflow-journal/<name>.jsonl          # the journal (identity)
```

Every sidecar derives from the journal path with `.jsonl` stripped (call that
prefix `B`):

| File | Direction | Lifecycle | Purpose |
|---|---|---|---|
| `B.jsonl` | producer → | append-only, survives runs | completed work (resume + accounting) |
| `B.meta.json` | producer → | rewritten at each start | run identity: pid, start time, budget, policy |
| `B.result.json` | producer → | written on success | the run's return value |
| `B.events.jsonl` | producer → | truncated at each start | lifecycle stream (running/done) |
| `B.progress.json` | producer → | rewritten while streaming | latest partial output per agent |
| `B.questions.json` | producer → | rewritten on change | asked checkpoints, pending + resolved |
| `B.answers.jsonl` | → producer | append-only | the supervisor's inbound channel |

A directory is a **fleet**: consumers treat every `*.jsonl` under
`<dir>/.workflow-journal/` as a run, excluding `*.events.jsonl` and
`*.answers.jsonl`. Producers running the same script concurrently must
disambiguate the journal name (this runner: `--run-id` → `<name>--<id>.jsonl`).

**Discoverability rule:** create the journal file (empty is fine) at startup,
not on first result — otherwise a just-launched run is invisible to `fleet
status`.

## The files

### `B.meta.json` — run identity (object, rewritten at start)

```json
{
  "pid": 4242, "startedAt": 1765400000000,
  "script": "/abs/path/to/script", "runId": "alpha" ,
  "budget": 1500000, "budgetMeter": "total",
  "model": "gpt-5.5", "autoEffort": true, "pinEffort": null,
  "sandbox": "read-only", "interactive": true
}
```

`pid` + `startedAt` are the load-bearing fields — they drive the state machine
below. Everything else is reporting. Extra fields are fine; consumers ignore
what they don't know.

### `B.result.json` — the return value (any JSON, written once on success)

Its **mtime** matters: a result older than `meta.startedAt` belongs to a
previous run and must not be read as this run's completion.

### `B.jsonl` — the journal (append-only JSONL)

One object per completed unit; the **latest entry per `key` wins** (a resumed
run may re-record). Three key namespaces:

```jsonc
{"key":"<hash>#<occ>",      "label":"sweep:auth", "result":…, "phase":"Sweep",
 "model":"gpt-5.5", "effort":"high", "tokens":512000, "ms":93000}      // one-shot agent
{"key":"sess:s1#2",         "label":"investigator", "result":…, "session":true,
 "sessionId":"s1", "turn":2, "status":"completed", "threadId":"…",
 "promptHash":"…", "tokens":…, "ms":…}                                 // session turn
{"key":"human:scope#0",     "label":"scope", "result":"high-only", "human":true,
 "question":"…", "source":"live"}                                       // answered gate
```

Only `key`, `label`, `result` are required. `tokens`/`ms`/`phase`/`model`/
`effort` feed status and summaries; `human:` entries let a resumed run replay
answers instead of re-asking.

### `B.events.jsonl` — lifecycle stream (append-only, truncated per run)

```jsonc
{"t":1765400001000, "type":"start",   "id":"<key>", "label":"…", "phase":"…",
 "model":"…", "effort":"…"}                       // kind/sessionId/turn for session turns
{"t":…, "type":"end",     "id":"<key>", "tokens":…, "ms":…, "status":"completed"}
{"t":…, "type":"cached",  "id":"<key>"}            // replayed from the journal, 0 tokens
{"t":…, "type":"question","id":"human:scope#0", "question":"…"}
{"t":…, "type":"answered","id":"human:scope#0"}
```

A `start` with no matching `end`/`cached` ⇒ that unit is **running**. Events
are observability only — never identity.

### `B.progress.json` — streaming heartbeat (object, throttled atomic rewrite)

```json
{ "<agent key>": "…latest partial output text (bounded tail)…" }
```

Two jobs: live viewers preview in-flight output, and — critically for
supervision — its **mtime is a liveness signal**. Lifecycle events are silent
between an agent's start and end, which can be minutes; a producer that
streams MUST touch this file (or the journal) periodically or it will read as
stalled.

### `B.questions.json` — the checkpoint surface (array, atomic rewrite)

```json
[{ "id": "human:scope#0", "qid": "scope",
   "question": "Verify all 8, or narrow?", "choices": ["all","high-only"],
   "default": "all", "askedAt": 1765400090000,
   "answered": false }]
```

Append on ask; on resolution set `answered: true` plus `answer` (or
`timedOut: true` if the default was used). `id` must be unique per ask;
`qid` is the human-friendly handle (consumers resolve a bare `qid` to the
pending `id` when unambiguous).

### `B.answers.jsonl` — the inbound channel (append-only)

```json
{"id": "human:scope#0", "answer": "high-only", "at": 1765400123000, "via": "fleet-cli"}
```

The producer polls this file (~500 ms here) and resolves the matching pending
question; **last entry per `id` wins** (a supervisor may revise before
pickup). Only `id` and `answer` are read — extra fields are annotations.
`answer` is any JSON value. Writers must validate against *currently pending*
questions (no pre-answering, no re-answering a resolved gate) — both
`fleet answer` and the viewer's `--serve` endpoint enforce this.

**Steering convention:** a free-text answer to a checkpoint *is* a directive.
The script decides what it means (apply via `session.steer`, re-aim a loop,
narrow scope). This is deliberate: steering rides the journaled answer
channel, so a `--resume` replays it deterministically — never inject turns
into a run behind its script's back.

## The state machine (consumer side)

Derived, never guessed — `inspectRun()` in `runner/src/fleetStatus.js`:

| State | Condition |
|---|---|
| **completed** | `result.json` exists ∧ (`startedAt` absent ∨ result mtime ≥ `startedAt`) |
| **running** | `meta.pid` is alive |
| **stopped** | meta exists, pid gone, no fresh result — killed / crashed / budget-tripped ⇒ *resumable* |
| **idle** | journal only (no meta — a historical run) |

Two flags on a running run:

- **waiting** — has a pending question (`answered: false`). A run waiting on
  its supervisor is *not* stalled, however long it waits.
- **stalled** — no pending question ∧
  `max(last event t, progress mtime, journal mtime, startedAt)` is older than
  the threshold (120 s default).

## The push channel

Polling is optional if the producer offers a notify hook. This runner's
`--notify-cmd CMD` runs `/bin/sh -c CMD` detached and best-effort with the
event JSON in `$WORKFLOW_EVENT`:

```jsonc
{"event":"question", "id":"human:scope#0", "qid":"scope", "question":"…",
 "choices":[…], "default":"…", "journal":"/abs/…jsonl", "script":"/abs/…"}
{"event":"end", "status":"completed|budget_exceeded|failed", "journal":"…", "script":"…"}
```

Those two moments — a gate going pending (it times out to its default!) and a
run ending — are the only ones a supervisor must hear about out-of-band.

## Minimum viable producer

Feature support degrades gracefully by file. To make any long-running job
supervisable, in order of value:

1. **`B.jsonl` (touched at start) + `B.meta.json`** (`pid`, `startedAt`) →
   appears in `fleet status` with a correct running/stopped state.
2. **`B.result.json`** on success → completion + the result in the digest.
3. **`B.questions.json` + poll `B.answers.jsonl`** → answerable gates; the
   full supervisor loop (`fleet answer`, the dashboard's answer cards, the
   `--multi` skill mode) now works against your producer.
4. **`B.events.jsonl` + `B.progress.json`** → live agent counts, stall
   detection, streaming previews.
5. Journal entries with `tokens`/`ms`/`phase` → budgets and cost reporting.

Compatibility rule for everyone: **add fields, never repurpose them; treat a
missing file as "feature absent", not an error.**
