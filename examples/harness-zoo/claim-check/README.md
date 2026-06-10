# ClaimCheck

**Extract the factual claims in a document — a README, a blog draft, a report, or an
agent's own output — and verify each one against the actual repository artifacts,
emitting a proof ledger of what holds up and what doesn't.**

ClaimCheck is a *fact-checker for documents*. It does **not** trust what the document
says; it pulls out the discrete, checkable claims, then runs one adversarial skeptic
per claim to read the real files, run the real commands, and rule each claim
**supported / unsupported / contradicted / plausible-unverified** — with citations,
a confidence, and a safer rewrite for the ones that don't hold. The deliverable is a
**proof ledger**, returned as structured JSON plus a paste-ready Markdown table —
never an edit to your project.

It's the **"after"** of the harness-zoo trust loop. Its sibling, [GoalLint](../goal-lint/),
is the **"before"**:

> **Harden the instruction before agents run; verify the claims after they write.**

---

## What it does

```
Extract → Verify (one skeptic per claim, in parallel) → Ledger
```

1. **Extract** — one reader pulls the discrete, independently checkable claims out of
   the document: the assertion in one sentence, where it appears, the concrete
   evidence that would prove or refute it, and what kind of claim it is. Opinions,
   aspirations, and vague statements go in `non_claims` (excluded, but noted for
   transparency). It never "fixes" the document — it inventories it. The fan-out is
   **capped at `maxClaims`** (default 12), with a `log()` note when it truncates — no
   silent caps.
2. **Verify** — one adversarial fact-checker per claim runs **in parallel**, each in a
   fresh, narrow context with only its single claim. Each is told to *refute*: read
   the relevant files, run the relevant read-only commands, cite exactly what it found
   (`file:line`, artifact names, the command + output), and rule:
   | Verdict | Means |
   | :--- | :--- |
   | **supported** | the evidence directly proves the claim |
   | **contradicted** | the evidence proves the claim **false** |
   | **unsupported** | looked, found no evidence either way (the default when proof should exist but doesn't) |
   | **plausible-unverified** | likely true but not checkable from here (needs network / external state) |
   When the verdict is anything but `supported`, the verifier proposes a
   **safer_rewrite** the evidence *would* support. (The runner controls the actual
   sandbox; run it `--sandbox read-only` so the skeptics read but never write.)
3. **Ledger** — one synthesizer counts the verdicts, builds the proof-ledger table,
   names the **riskiest claims** to ship as-is (contradicted first, then unsupported),
   lists the **top rewrites** to apply, and rules the document `holds-up`,
   `needs-revision`, or `unreliable`.

`2 + N` agents total (1 Extract + N verifiers + 1 Ledger), where N is the number of
checkable claims (≤ `maxClaims`).

---

## When to use it

A normal review panel **judges the work**; ClaimCheck **audits the document's
assertions** against reality. Reach for it **after** something has been written —
when believing a false claim is expensive.

Use ClaimCheck when:

- **An agent reports success.** Before you trust "I added the tests and they pass" or
  "the endpoint now handles errors," ClaimCheck pulls the claims out of the summary
  and checks each against the repo — catching the agent grading its own homework.
- **You're about to publish a README, changelog, or blog post.** Every "zero
  dependencies," "runs in under 100ms," "supports X" is a claim that can be wrong.
  ClaimCheck marks each one and hands you safer rewrites for the ones that don't hold.
- **A report cites the codebase.** Architecture docs and audit reports drift from the
  code. ClaimCheck re-grounds each claim in `file:line` evidence.
- **You inherited a document you didn't write.** The ledger tells you, claim by claim,
  how much of it you can actually trust.

**Reach for a normal panel instead when** you need the *work* reviewed (correctness,
design, security) rather than a *document's claims* verified, or when the document
makes no checkable assertions (pure opinion/aspiration).

---

## Input

Pass either a **bare string** document, or an **object**:

```jsonc
{
  "doc": "Inline document text to audit…",   // OR
  "docPath": "README.md",                     // a path the agents should read
  "focus": "dependencies and the test suite", // optional: prioritize these claims
  "maxClaims": 12,                            // optional: cap the verify fan-out (default 12)
  "claims": [                                 // optional: pre-seed extracted claims
    { "id": "C1", "claim": "…", "where": "…", "evidence_needed": "…", "kind": "factual" }
  ]
}
```

Provide **`doc` or `docPath`** (at least one). A **bare string** is taken as `doc`.

- **`focus`** nudges extraction toward the claims you care about.
- **`maxClaims`** caps the verify fan-out; ClaimCheck `log()`s when it truncates.
- **`claims`** lets a caller **pre-seed** the extracted claims (each a bare string or
  `{ claim, where?, evidence_needed?, kind? }`). When present, ClaimCheck **skips
  model extraction** and verifies those directly — useful when you already know the
  claims, and what makes the verify fan-out **countable in a `--plan` dry run** (the
  Extract agent returns an empty `claims` array in a dry run, so a normal run can't
  size the fan-out ahead of time). See [`sample-args.json`](sample-args.json) and
  [`sample-doc.md`](sample-doc.md).

---

## Run it

**Recommended** (read-only, with the live viewer):

```bash
node runner/bin/run-workflow.js examples/harness-zoo/claim-check/claim-check.workflow.js \
  --args-file examples/harness-zoo/claim-check/sample-args.json \
  --frontier --auto-effort --sandbox read-only --budget 1000000 --gui
```

ClaimCheck is a `2 + N`-agent **standard** harness, so it runs with
**`--auto-effort`**: the N parallel verifiers get `high`, while the lone gates —
Extract and the Ledger synthesis — get `xhigh`, since a weak output at either
single-agent gate would sink the whole audit. Keep it **`--sandbox read-only`** so the
skeptics read the repo but never edit it.

A **bare string** document works too:

```bash
node runner/bin/run-workflow.js examples/harness-zoo/claim-check/claim-check.workflow.js \
  --args '"This project has zero dependencies and runs on Node 18+."' \
  --frontier --auto-effort --sandbox read-only --budget 1000000
```

Via the skill, just describe it:

> `/codex-workflows fact-check examples/harness-zoo/claim-check/sample-doc.md against this repo and give me a proof ledger`

**Size it first** with a no-token dry run:

```bash
node runner/bin/run-workflow.js examples/harness-zoo/claim-check/claim-check.workflow.js \
  --args-file examples/harness-zoo/claim-check/sample-args.json --plan
```

Note the verify fan-out is sized from the Extract agent's output, which comes back
**empty in a dry run** — so `--plan` counts Extract + Ledger but **0 verifiers**
unless you **pre-seed `claims`** (as `sample-args.json` does, so the dry run counts
all of them). The token estimate is a deliberately **conservative upper bound**; real
runs typically spend a fraction, and `--budget` is just a ceiling (trip it and the CLI
prints a paste-ready `--resume`; finished agents replay free).

The workflow's return value prints as JSON on stdout (pipe it to `jq`); progress
streams on stderr. The `ledger_markdown` field is a ready-to-paste proof ledger.

---

## Output

```jsonc
{
  "verdict": "holds-up" | "needs-revision" | "unreliable",
  "document_summary": "…",
  "counts": { "supported", "unsupported", "contradicted", "plausible_unverified" },
  "extracted": { "claims": [ { "id", "claim", "where", "evidence_needed", "kind" } ],
                 "non_claims": [ … ], "summary": "…" },
  "verdicts": [ { "id", "claim", "verdict", "evidence": [ … ], "confidence",
                  "reasoning", "safer_rewrite" }, … ],
  "final_ledger": { "headline", "verdict", "counts", "riskiest", "top_rewrites", "summary" },
  "ledger_markdown": "# ClaimCheck proof ledger …"
}
```

Every agent uses a strict JSON schema (`additionalProperties: false`) — for the
extracted claims, each per-claim verdict, and the final ledger. The
`ledger_markdown` is assembled **in code** (so it's populated even on a dry run).

---

## The trust loop (pairs with GoalLint)

ClaimCheck and [GoalLint](../goal-lint/) are two ends of one loop:

| | GoalLint | ClaimCheck |
| :--- | :--- | :--- |
| **When** | *before* the agents run | *after* they write |
| **Input** | a vague `/goal` | a finished document / agent output |
| **Does** | hardens the instruction | verifies the claims |
| **Output** | a precise, falsifiable goal | a proof ledger |

> Harden the instruction before agents run; verify the claims after they write.

---

## Safety

Analysis-only by design. The recommended invocation uses `--sandbox read-only`, and
the workflow never writes files — it returns Markdown *inside* its JSON result. The
workflow script itself is sandboxed (no filesystem/network/process access; only the
agents act, and here they only read). Safe to point at any repo.
