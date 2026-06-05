# Authoring Codex workflow scripts

> You usually don't hand-author these: `/codex-workflows <one or two rough
> sentences>` compiles a workflow script for you (see `SKILL.md` → *Compiling rough
> intent into a workflow*). This reference is for understanding, tweaking, or
> writing one by hand.

A workflow script is plain JavaScript (not TypeScript) that the runner hosts in
an isolated context. It begins with a pure-literal `meta`, then a body that uses
the injected globals. Top-level `await` works, and a top-level `return` is the
workflow's result.

## Why a workflow (the failure modes it fixes)

A workflow moves the *plan* into code, so the orchestration — the loop, the
branching, the intermediate results — lives in script variables instead of one
agent's context window. That's what lets it apply a *repeatable quality pattern*,
not just run more agents. The three failure modes it's built to fix (from the
dynamic-workflows announcement) are worth keeping in mind, because each maps to a
pattern below:

- **Agentic laziness** — an agent declares a complex, multi-part job done after
  partial progress ("35 of 50"). Fix: the *script* owns the worklist and the
  loop, so coverage is structural — **loop-until-dry**, **pipeline over a fixed
  list**, **completeness critic**.
- **Self-preferential bias** — an agent prefers its own output when asked to judge
  it. Fix: a *separate* agent verifies — **adversarial / perspective-diverse
  verify**, **judge panel**, **tournament**.
- **Goal drift** — fidelity to the original objective erodes across many turns,
  especially after compaction. Fix: each agent gets a fresh, narrow context with
  the goal restated — **fan-out-and-synthesize**, **classify-and-act**.

If a task doesn't risk any of these, it probably doesn't need a workflow — do it
directly. Scale the machinery to the ask.

## `meta`

Must be the first statement and a **pure literal** (no variables, calls, or
interpolation). Required: `name`, `description`. Optional: `phases` (one entry
per `phase()` call; `title` should match the `phase()` string), `whenToUse`.

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep CI logs for retry markers' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
```

## Globals

### `agent(prompt, opts?) → Promise<string | object | null>`
The only global that calls a model. Runs `prompt` as one Codex thread+turn.
- Without `schema`: resolves to the agent's final message text (string).
- With `schema`: the turn is constrained by Codex `outputSchema`; resolves to the
  parsed object.
- Resolves `null` if the turn was interrupted. Throws on a hard failure (so
  `parallel`/`pipeline` turn it into `null`).

`opts`:
| opt | meaning |
| --- | --- |
| `schema` | JSON Schema (object root, `additionalProperties:false` recommended) → Codex `outputSchema`; result is `JSON.parse`d |
| `model` | **Leave unset in scripts.** Runs are pinned to one latest-frontier model with `--frontier`, which overrides any per-call `model` anyway. (If you do set it, Claude ids/aliases auto-map to a Codex model.) |
| `agentType` | name of a subagent in `.claude/agents/<name>.md`; its body becomes the system prompt, its frontmatter `model` a fallback |
| `systemPrompt` | explicit developer instructions (overrides `agentType` body) |
| `effort` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`. **Usually leave unset and run with `--auto-effort`**, which scales effort to each layer's parallel width (1→`xhigh`, 2+→`high` — the floor) so lone gate agents think hardest while every fan-out still gets `high`. A per-call `effort` *overrides* the policy, so set it only as a deliberate exception. Precedence: `--pin-effort` > per-call `effort` > `--auto-effort` > `--effort` > Codex config default (`model_reasoning_effort`, often `xhigh`). |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` (default `workspace-write`) |
| `isolation` | `'worktree'` → run in a detached git worktree at HEAD (parallel file-editing agents don't collide); kept if it leaves changes |
| `cwd` | working directory for the thread (default the runner's cwd) |
| `personality` | `none` \| `friendly` \| `pragmatic` |
| `retries` | transient-error retries (default 3) |
| `label` | display label in progress output |
| `phase` | phase this agent belongs to; **overrides the ambient `phase()`**. Persisted to the journal so the viewer groups it correctly even inside concurrent `pipeline`/`parallel` stages, where the global `phase()` races. Set it on agents you fan out per-stage. |
| `timeoutMs` | max wait for the turn (default 600000) |

### `parallel(thunks) → Promise<any[]>`
**Barrier** fan-out: awaits all thunks. A thunk that throws (or whose agent
errors) resolves to `null` — `.filter(Boolean)` before using. Use only when you
genuinely need all results together (dedup/merge, early-exit on zero, cross-item
comparison).

### `pipeline(items, ...stages) → Promise<any[]>`
**Default** for multi-stage work. Each item flows through all stages
independently — no barrier between stages, so item A can be in stage 3 while item
B is still in stage 1. Each stage callback gets `(prevResult, originalItem,
index)`. A stage that throws drops that item to `null` and skips its remaining
stages. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage.

Smell test: if you wrote `const a = await parallel(...); const b = transform(a);
const c = await parallel(b...)` and the middle transform has no cross-item
dependency, use a pipeline with the transform as a stage instead.

### `phase(title)` / `log(msg)`
Progress to stderr. Group agents under a phase; `log` emits a narrator line.

### `args`
The value passed via `--args '<json>'` or `--args-file`. Use it to parameterize a
saved workflow (file lists, a research question, config).

### `budget`
`{ total, spent(), remaining() }`. `total` is the `--budget` ceiling (or `null`).
`spent()` is tokens used so far; `remaining()` is `Infinity` with no budget. Once
spent reaches total, further `agent()` calls throw. Use for dynamic depth:
`while (budget.total && budget.remaining() > 50_000) { … }`.

### `workflow(ref, args?) → Promise<any>`
Run another script inline (one level only). `ref` is `{ scriptPath }`. Shares the
concurrency cap and budget.

## Standard quality patterns

These are why a workflow beats "more agents" — encode the pattern in code.

**Pipeline + adversarial verify** (review each finding as soon as it's found):
```js
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, schema: FINDINGS }),
  (review) => parallel(review.findings.map((f) => () =>
    agent(`Adversarially verify: ${f.title}. Default refuted=true if uncertain.`, { schema: VERDICT })
      .then((v) => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.real)
```

**Perspective-diverse verify** — give each verifier a distinct lens
(correctness, security, repro) instead of N identical refuters.

**Majority refute-by-default** — for a finding that has to be *right*, spawn N
independent skeptics (each told to refute, and to default to refuted when unsure)
and keep it only if the majority cannot refute it — stronger than a single
verifier. Runnable: `examples/bug-hunt.workflow.js`.

**Judge panel** — generate N independent attempts from different angles, score
with parallel judges, synthesize from the winner while grafting the best of the
rest. Beats one-attempt-iterated when the solution space is wide.

**Fresh-context review gate** — *no agent reviews its own work.* A producer
rationalizes its own choices, so split the roles: the producer drafts an
artifact, independent reviewers see ONLY the artifact + a rubric (not the task,
the producer's reasoning, or each other's reviews), and a final gate — neither
producer nor reviewer — rules go / revise / no-go and cites the reviews. Make it
the default for design / plan / implementation / PR review. Runnable:
`examples/review-gates.workflow.js`.

**Loop-until-dry** — for unknown-size discovery, keep spawning finders until K
consecutive rounds find nothing new; dedup against everything seen (a Set), not
just confirmed:
```js
const seen = new Set(); let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map((f) => () => agent(f.prompt, { schema: BUGS }))))
    .filter(Boolean).flatMap((r) => r.bugs)
  const fresh = found.filter((b) => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach((b) => seen.add(key(b)))
  // …judge fresh…
}
```
Always cap the rounds too (a runaway-loop backstop, and it bounds a `--plan`
dry run). Runnable: `examples/bug-hunt.workflow.js` (loop-until-dry into the
majority refute-by-default verify above).

**Loop-until-budget** — scale depth to `--budget`. Guard on `budget.total` (else
`remaining()` is `Infinity` and it runs to the 1000-agent cap):
```js
const out = []
while (budget.total && budget.remaining() > 50_000) {
  out.push(...(await agent('Find more issues.', { schema: ISSUES })).issues)
}
```

**Completeness critic** — a final agent that asks "what's missing — modality not
run, claim unverified, file unread?"; its answer becomes the next round.

**Classify-and-act (router)** — one classifier agent labels the task, then the
script branches to a specialized handler. Use it to give each branch a fresh,
goal-restated context (fights goal drift). *Codex note:* the native version routes
cheap branches to a smaller model; here, keep one model and let effort be the
lever (see below). Runnable: `examples/classify-route.workflow.js`.

**Tournament / pairwise-sort** — rank a list too big for one context by a
qualitative criterion: bucket it, rank each bucket in parallel, then a lone judge
k-way-merges the bucket orders. Bucket width bounds each agent's input.
Runnable: `examples/tournament-sort.workflow.js`.

**Triage + quarantine** — classify a batch in parallel, dedupe in plain code,
then a single router proposes actions from the *structured labels* — not the raw,
untrusted item text. Keep the classifiers `sandbox:'read-only'` so untrusted
content never reaches a write-capable agent (privilege separation shrinks the
injection surface). Runnable: `examples/triage.workflow.js`.

**Generate-and-filter** — spawn N candidate attempts, then filter by a rubric or a
verifier pass; a special case of the judge panel when you only need "good enough,"
not "the best."

**Deep verification / fan-out research** — identify every checkable claim, then
spin off one verifier per claim against the source; synthesize only what survives.
This is the shape of the bundled `/deep-research`. Runnable:
`examples/deep-research.workflow.js` (over a codebase; swap the reader prompts for
web search if your Codex has web tools).

## Codex-specific authoring notes

- **Agents do the I/O, not the script.** The script is sandboxed (no fs/shell). To
  read or write files, instruct an `agent()` to do it — e.g. *"Read src/auth.ts
  and …"*. With `sandbox: 'read-only'` an agent can read anywhere; with
  `workspace-write` it can edit within its cwd.
- **Schemas**: prefer an object at the root. OpenAI strict structured outputs
  require **every property to be in `required`** and `additionalProperties:false` on
  every object — the runner **auto-normalizes** this for you (recursively), so a
  forgotten `required` key won't 400 the turn. There is no "optional" in strict
  mode: for a field the model may leave empty, make it **nullable**
  (`type:['string','null']`) rather than omitting it from `required`. The result is
  parsed JSON; the runner also tolerates ```json fences as a fallback.
- **One model, effort is the lever.** Runs use `--frontier`, which pins a single
  latest-frontier model (e.g. `gpt-5.5`) and **overrides any per-call `model`** —
  so leave `model` out of `agent()` opts. This is a deliberate divergence from the
  native blog's "classify-and-route to Sonnet vs Opus": instead of *model* routing
  for cost, this re-host keeps one model and uses **thinking effort** as the dial
  (`--auto-effort` scales it to layer width; `--effort`/`--pin-effort`/`--budget`
  bound it). Mixing models or downgrading "cheap" stages is what produces
  inconsistent multi-model runs — don't.
- **Size the budget with `--plan` first.** A dry run executes the orchestration
  with `agent()` stubbed (no model, no tokens), counts agents per phase/effort,
  and prints an estimated `--budget`. Fan-outs sized from *agent output* (a
  `pipeline`/`parallel` over a previous agent's array) come back empty in a dry
  run, so the count is a **lower bound** — re-run `--plan` on a small `--args`
  slice for a tighter number.
- **Per-agent metrics are recorded.** Each completed `agent()` journals its phase,
  effort, resolved model, tokens, and wall time. `view-run.js` renders them
  (per-agent, per-phase, per-run); `view-run.js <dir> --watch` rebuilds the HTML
  live as a run progresses.
- **Effort scales to layer width — let `--auto-effort` set it.** Don't hand-set
  `effort` per agent. Run with `--auto-effort` and the runner reads each layer's
  fan-out width (thunks in a `parallel()`, items in a `pipeline()` stage) and
  picks effort: **1→`xhigh`** (a lone agent is a critical gate — consolidate,
  judge, synthesize, report — so it thinks hardest) and **2+→`high`** (the
  floor — every fan-out still thinks hard; the policy never drops to `medium`).
  This means you express importance *structurally* — a synthesis you want done
  well should be its own single-agent step, not buried inside a fan-out. Reserve
  a per-call `effort` (which overrides the policy) for a rare exception.
- **Determinism**: no `Math.random()`/`Date.now()`/argless `new Date()` in the
  script (blocked). Pass any timestamps/seeds via `args`; vary agent prompts by
  index, not randomness.
- **Scale to the ask.** "find any bugs" → a few finders, single-vote verify.
  "thoroughly audit" → larger finder pool, 3–5 vote adversarial verify, a
  synthesis stage. `log()` anything you cap or drop so it doesn't read as full
  coverage.
- **Heavy final stages are fragile.** A single report/synthesis agent that takes
  the whole run as input, emits a long body, *and* writes a file is the most
  common cause of a timed-out run (the 600s per-turn limit). Prefer: have the
  agent **return** the artifact as a `schema` string and write the file from a
  thin downstream step, keep its input trimmed, or raise its per-call
  `timeoutMs`. If it does time out, the file is often already written and earlier
  agents are journaled — assemble from the journal rather than re-running.
- **Fenced code inside agent-written markdown.** When an agent emits markdown that
  embeds triple-backtick blocks (e.g. a `/goal` containing ```bash fences) inside
  another fence, the inner fence closes the outer one and headings leak into the
  doc. Tell the agent to wrap such blocks in a **longer** fence (4–5 backticks)
  than anything they contain.
