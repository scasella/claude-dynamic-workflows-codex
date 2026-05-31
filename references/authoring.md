# Authoring Codex workflow scripts

A workflow script is plain JavaScript (not TypeScript) that the runner hosts in
an isolated context. It begins with a pure-literal `meta`, then a body that uses
the injected globals. Top-level `await` works, and a top-level `return` is the
workflow's result.

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
| `effort` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`. If unset, the agent inherits the Codex config default (`model_reasoning_effort`, often `xhigh`) — set it explicitly on multi-agent runs to avoid running everything at the top tier |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` (default `workspace-write`) |
| `isolation` | `'worktree'` → run in a detached git worktree at HEAD (parallel file-editing agents don't collide); kept if it leaves changes |
| `cwd` | working directory for the thread (default the runner's cwd) |
| `personality` | `none` \| `friendly` \| `pragmatic` |
| `retries` | transient-error retries (default 3) |
| `label` | display label in progress output |
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

**Judge panel** — generate N independent attempts from different angles, score
with parallel judges, synthesize from the winner while grafting the best of the
rest. Beats one-attempt-iterated when the solution space is wide.

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

## Codex-specific authoring notes

- **Agents do the I/O, not the script.** The script is sandboxed (no fs/shell). To
  read or write files, instruct an `agent()` to do it — e.g. *"Read src/auth.ts
  and …"*. With `sandbox: 'read-only'` an agent can read anywhere; with
  `workspace-write` it can edit within its cwd.
- **Schemas**: prefer an object at the root with `additionalProperties:false` and
  explicit `required`. The result is parsed JSON; the runner tolerates ```json
  fences as a fallback but a clean object root is most reliable.
- **One frontier model for every agent.** Runs use `--frontier`, which pins a
  single latest-frontier model (e.g. `gpt-5.5`) and **overrides any per-call
  `model`** — so leave `model` out of `agent()` opts. Mixing models or
  downgrading "cheap" stages is what produces inconsistent multi-model runs;
  bound cost with `effort`/`budget` instead.
- **Determinism**: no `Math.random()`/`Date.now()`/argless `new Date()` in the
  script (blocked). Pass any timestamps/seeds via `args`; vary agent prompts by
  index, not randomness.
- **Scale to the ask.** "find any bugs" → a few finders, single-vote verify.
  "thoroughly audit" → larger finder pool, 3–5 vote adversarial verify, a
  synthesis stage. `log()` anything you cap or drop so it doesn't read as full
  coverage.
