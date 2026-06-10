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

## Sessionful workers (long-lived, steerable)

`agent()` is one-shot: one Codex thread, one turn, done. A **session** keeps the
thread open so you can run *follow-up turns on the same thread* — the worker keeps
its context. This is the seam for orchestration loops: spawn several workers, wait
for whichever is useful first, then **accept / steer / spawn / verify / stop**.

The sessionful API hangs off `agent` (not new globals):

### `agent.start(prompt, opts?) → Promise<AgentSession>`
Starts a thread and begins the first turn, then returns a handle **without waiting
for the turn to finish**. Same `opts` as `agent()` (`agentType`, `systemPrompt`,
`model`, `effort`, `sandbox`, `cwd`, `personality`, `schema`, `timeoutMs`, `phase`,
`label`, `isolation:'worktree'`). Effort resolves exactly like `agent()` (so under
`--auto-effort` a worker in a `parallel([…])` fan-out gets `high`, a lone start gets
`xhigh`). Holds a concurrency slot for the running turn — **a detached running
worker counts against the cap** until its turn settles.

### `agent.waitAny(sessions, opts?) → Promise<{ session, index, snapshot, pendingSessions, timedOut }>`
The main-thread primitive: resolves when the **first** session becomes *actionable*
(completed / interrupted / failed / cancelled), or when `opts.timeoutMs` elapses
(`timedOut:true`, `session:null`). `pendingSessions` lists the workers still running.
Already-finished sessions return immediately (lowest index first). This is "notify
me when any child worker finishes or needs attention."

### `AgentSession`
| member | meaning |
| --- | --- |
| `id` `label` `phase` `threadId` `currentTurnId` `status` | identity + live state (`status`: `starting`→`running`→`completed`/`interrupted`/`failed`/`cancelled`/`closed`) |
| `wait(opts?) → Promise<snapshot>` | await the current turn. `opts.timeoutMs` returns a `timed_out` snapshot **without cancelling** the turn (it keeps running) |
| `poll() → snapshot` | latest snapshot, synchronously (no waiting) |
| `steer(message, opts?) → Promise<snapshot>` | **a follow-up `turn/start` on the SAME thread** — the worker continues with its context. Per-turn overrides: `schema`, `effort`, `timeoutMs`, `label`. Thread-level settings (`cwd`, `sandbox`, instructions) are fixed at start and can't change. `{wait:false}` returns the running snapshot; default `{wait:true}` awaits it. Throws if a turn is already running (`wait()`/`cancel()` first) or the session is closed |
| `cancel() → Promise<snapshot>` | interrupt the active turn (`turn/interrupt`); returns a `cancelled` snapshot |
| `close() → Promise<void>` | cancel any active turn, remove the worktree (if `isolation`), mark closed |

`AgentSessionSnapshot`: `{ id, label, phase, threadId, turnId, status, result,
text, error, model, effort, tokens, ms }` — `result` is the parsed object (with
`schema`) or string; `tokens`/`ms` are **per-turn**.

```js
const a = await agent.start("Explore auth middleware. file:line findings only.", { label: "auth", sandbox: "read-only" })
const b = await agent.start("Explore route handlers. Missing auth checks only.",  { label: "routes", sandbox: "read-only" })

const first = await agent.waitAny([a, b], { timeoutMs: 180_000 })
if (first.snapshot?.status === "completed") {
  await first.session.steer("Narrow to the two highest-risk findings; list exact files to inspect next.", { wait: true })
}
const [finalA, finalB] = [await a.wait(), await b.wait()]
await a.close(); await b.close()
```

### The controller pattern (who decides?)

Don't make the human babysit workers. Split the decision rights:

- **Script** decides *mechanical/structural* actions — schema failed, timeout, round
  cap, budget cap, repeated nulls.
- **Controller agent** decides *semantic* steering — accept / steer / spawn / verify
  / stop / ask_human — from a worker's snapshot.
- **Human** decides *policy* — scope, cost, risk, destructive edits, value calls, or
  continuing past a budget/iteration cap.

```js
const decision = await agent(
  `You are the controller. Goal:\n${goal}\nPolicy:\n${JSON.stringify(policy)}\n` +
  `Latest worker snapshot:\n${JSON.stringify(first.snapshot)}\n` +
  `Decide: accept if done · steer if the same worker needs a focused correction · ` +
  `verify if an important claim is unchecked · ask_human only for scope/cost/risk/value · stop if low-value.`,
  { label: "controller", phase: "Control", schema: DECISION_SCHEMA },
)
if (decision.action === "steer") await target.session.steer(decision.steerMessage, { wait: true })
```

`examples/sessionful-workers.workflow.js` is the runnable intro (start → waitAny →
controller → steer → wait), and runs under `--plan`. Six more demos, one per
new-capability shape (all `--plan`-safe):
- `warm-context-interrogation` — *load once, ask many*: ingest a corpus once, then
  `steer` a stream of follow-ups on warm context.
- `flaky-bug-perturbation` — hold a reproduced failure (worktree) and `steer` through
  a perturbation playbook without rebuilding it.
- `hedged-take-first-win` — race N strategies, accept the first good one, `cancel` the
  rest (`waitAny` + `cancel`).
- `lead-following-research` — a controller `steer`s / `spawn`s / stops mid-run, chasing
  the strongest lead on warm context.
- `stateful-dialogue` — two long-lived agents with full memory, judged by a fresh cold
  agent (illustrates session vs. one-shot).
- `agent-foreman` — supervised autonomy: a foreman drives a live fleet and escalates
  only at declared forks (`needs_human`).

### Human interaction model

The human sets **mission + policy**; the script owns the loop; the controller steers;
the human re-enters only at declared checkpoints. Declare an **involvement mode**:

- `hands_off` — never pause; safe defaults, mark uncertainty, avoid risky/destructive
  actions.
- `checkpointed` — **the recommended default.** Pause only at plan / write / budget /
  scope gates.
- `interactive` — pause at declared forks and take the answer **live**, via the
  `human()` global (below). Built: the run keeps its warm workers while you answer.

### `human(question, opts?) → Promise<answer>`

A **declared fork**: the workflow pauses *here* (and only here) for a human answer.
`opts`: `{ id?, choices?, default?, timeoutMs? }`. Resolution order — first hit wins:

1. **`--plan`** → the default, immediately (a dry run never blocks);
2. **`args.checkpointAnswers[id]`** → the resume convention, answered up front;
3. **journal replay** (`--resume`) → a previously-given answer replays free;
4. **the live channel** → with `--gui`, the served viewer shows an answer card
   (choice buttons + free text) that POSTs back; with `--tui`/`--interactive`,
   append to the sidecar from any terminal:
   `echo '{"id":"human:<id>#0","answer":"yes"}' >> .workflow-journal/<name>.answers.jsonl`;
5. **the default** after `timeoutMs` (or immediately with no channel attached) —
   `hands_off` degradation: an unattended run never hangs.

Answers journal under `human:<id>#<occ>` (never an agent key), render as
checkpoints — not agents — in the viewer/summary, and replay on `--resume`, so an
answered run stays reproducible. Combine with sessionful workers for the cockpit
loop: ask, keep the fleet warm, steer with the answer.

```js
const scope = await human("Include internal admin-only routes?", {
  id: "scope", choices: ["include", "exclude", "separate_section"],
  default: "separate_section", timeoutMs: 600_000,
});
await oracle.steer(`Scope decided: ${scope}. Re-rank the findings accordingly.`);
```

For **unattended** runs (cron, CI), prefer the checkpoint-by-return shape — end the
run with a structured question and let the human resume:

```js
return {
  status: "needs_human",
  checkpointId: "scope-admin-routes",
  question: "Should this audit include internal admin-only routes?",
  choices: ["include", "exclude", "separate_section"],
  recommendedDefault: "separate_section",
  reason: "Workers disagree on whether admin-only endpoints are in scope.",
  ledger,
  resumeInstructions:
    "Rerun with --resume and --args '{\"checkpointAnswers\":{\"scope-admin-routes\":\"separate_section\"}}'",
}
```

The runtime doesn't interpret this object — it's an authoring convention. The CLI
prints the workflow's return value, so the human sees the question and resume hint.

### Limits & resume (read this)

- **Warm-context resume.** `agent()` stays resumable as before. Sessions resume
  **warm**: each turn is journaled under `sess:<workerId>#<turn>` with the worker's
  Codex `threadId`; on `--resume` the runtime calls `thread/resume` to re-attach the
  **persisted thread** (the server reloads its rollout from disk), replays the
  journaled *completed-turn prefix* free (0 tokens, `cached` events), and runs only
  the new turns — on the worker's full prior context. Two honesty rules: replay is
  **conditional on a successful re-attach** (a fresh thread never saw those prompts,
  so if the rollout is gone or codex predates `thread/resume`, every turn re-runs
  live — **no fake thread resurrection**); and replay is **positional**, like the
  one-shot occurrence counters — same script, same session call order. A worker's
  prior-run token history is baselined out of the meter, so budgets bill only this
  run. Workflows that need to pause for a human should still checkpoint-by-return
  (above) — that composes with warm resume: return `needs_human`, then `--resume`
  with the answer in `args` and steer the same warm worker onward.
- **One active turn per session.** `steer()` while a turn runs throws — `wait()` or
  `cancel()` first. (v1 doesn't queue turns.)
- **Finalization.** Sessions you leave open are closed automatically when the
  workflow returns or throws (active turns cancelled, worktrees cleaned). Closing
  explicitly is still good form.
- **Worktrees** (`isolation:'worktree'`) are created once and **persist across every
  steer**, removed only on `close()`/finalization.
- **No interactive "needs input" state.** Workers run `approvalPolicy:"never"`, so
  there's no mid-turn human-input request to surface; "actionable" means the turn
  ended.

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
