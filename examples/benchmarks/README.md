# Benchmarks

Measured evidence for the sessionful-worker claims — run them yourself; the
journal is the instrument (`summarize-run` reads it).

## warm-vs-cold — "load once, ask many"

Two arms answer the **same questions** about the **same corpus**:

- **Warm** — one sessionful worker ingests the corpus once (`agent.start`), then
  answers every question as a `steer` on its warm thread.
- **Cold** — a fresh one-shot `agent()` per question, each re-reading the corpus
  from scratch (the only option in the native one-shot DSL).

```bash
node runner/bin/run-workflow.js examples/benchmarks/warm-vs-cold.workflow.js \
  --frontier --effort medium --sandbox read-only
node runner/bin/summarize-run.js .          # By-phase + Sessionful workers tables
```

### Measured result (2026-06-09 · codex 0.137.0 · gpt-5.5 · effort medium · corpus `runner/src`, ~3.3k lines · 3 questions)

| | tokens | wall time |
| :--- | ---: | ---: |
| **Warm** — ingest (one-time, turn 0) | 329k | 80s |
| **Warm** — each question (steer, marginal) | **~69k** | **~6s** |
| **Cold** — each question (full re-read) | **~219k** | **~97s** |
| **Warm** — arm total (1 ingest + 3 steers) | 535k | 99s |
| **Cold** — arm total (3 agents) | 656k | 290s agent-time |

Per question, after the one-time ingest, the warm worker was **~3× cheaper in
tokens and ~16× faster** — it answers from context instead of re-reading. On
totals the warm arm broke even at the **second** question and was ahead by the
third (535k vs 656k). Both arms produced correct, file-citing answers
(spot-checked: both located retry/backoff in `codexAgent.js`).

Two honest notes:

- **One question → use a one-shot.** The ingest dominates at N=1 (~398k warm — the
  329k read plus one ~69k answer — vs a single cold question that re-reads and
  answers in one shot, here 179k–289k depending on the question). Sessions win when
  you'll ask *again* — which is the point.
- The steers' ~69k/turn is mostly the thread's **re-billed (largely cached)
  input**; raw token counts therefore *understate* the warm advantage in dollar
  terms, since cached input is billed far below fresh input. The wall-clock gap
  (6s vs 97s) needs no such caveat.

Numbers vary with corpus size, model, and effort — the relative shape (flat
cheap steers vs linear re-reads) is the durable result. Re-run with your own
`--args '{"scope":"…","questions":[…]}'` to measure your case.
