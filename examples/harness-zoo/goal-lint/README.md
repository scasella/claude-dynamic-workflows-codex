# GoalLint

**Turn a vague or risky agent `/goal` into a precise, testable, falsifiable,
artifact-producing one — before you spend a fleet of agents on it.**

GoalLint is a *linter for instructions*. It does **not** attempt your goal; it reads
the goal you're about to hand an autonomous coding agent, finds the ways that goal
will go wrong, and rewrites it into a hardened instruction with explicit guardrails.
The deliverable is a **better prompt**, returned as structured JSON plus a
paste-ready Markdown report — never an edit to your project.

It's the flagship of the **harness zoo**: small, fast, read-only, and practical.

---

## What it does

```
Parse → Critique (7 parallel lenses) → Rewrite → Verify (fresh gate) → Report
```

1. **Parse** — one reader extracts the objective, the files/commands the goal
   implies, the success criteria as stated, the *missing* constraints, the
   ambiguous phrases, and an overall risk rating. It never attempts the goal.
2. **Critique** — seven independent critics run in parallel, each through one lens:
   | Lens | Asks |
   | :--- | :--- |
   | **ambiguity** | What can be read two ways? |
   | **falsification** | What observation could prove this *failed*? |
   | **overbuild** | Where does this invite scope creep / gold-plating? |
   | **artifact** | What concrete output must exist at the end? |
   | **verification** | How is success checked *mechanically*, not self-reported? |
   | **safety** | Does it need write/network access? What must NOT be touched? |
   | **scope** | When should the agent STOP? What's out of scope? |
3. **Rewrite** — one gate folds every critique (and your caller hints) into a
   hardened `/goal`: objective, context, **allowed files**, **forbidden files**,
   **commands to run**, **success criteria**, **failure criteria**, **required
   artifacts**, **stopping criteria**, and an explicit **"do not overclaim"**
   instruction.
4. **Verify** — a *fresh* gate that never saw the rewrite being written audits it,
   deciding for each critique whether the hardened goal actually resolves it. It
   rules `ready` or `needs-work`. (Separation is the point: the author rationalizes;
   a fresh verifier audits.)
5. **Report** — a synthesizer emits a structured headline / verdict / top-actions /
   summary; the paste-ready Markdown report is then assembled in code (the hardened
   goal embedded verbatim).

Eleven agents total (1 + 7 + 1 + 1 + 1).

---

## Input

Pass either a **bare string** goal, or an **object** with optional hints:

```jsonc
{
  "goal": "Improve the error handling in the API and make it more robust...",
  "repoContext": "Node/Express service under src/. Tests run with `npm test`.",
  "allowedFiles": ["src/**", "test/**"],
  "forbiddenFiles": [".env", "src/db/migrations/**"],
  "expectedArtifacts": ["a passing `npm test`", "a short CHANGES.md note"],
  "maxAgents": 7            // optional: cap the critic fan-out (default 7)
}
```

Only `goal` is required. The hints are folded into the hardened goal's
allowed/forbidden/required sections when present. See [`sample-args.json`](sample-args.json)
and [`sample-goal.md`](sample-goal.md).

---

## Run it

**Recommended** (read-only, capped, with the live viewer):

```bash
node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
  --args-file examples/harness-zoo/goal-lint/sample-args.json \
  --frontier --auto-effort --sandbox read-only --budget 1000000 --gui
```

GoalLint is an 11-agent **standard** harness, so it runs with **`--auto-effort`**:
its 7 parallel critics get `high`, while the lone gates — Parse, Rewrite, the
fresh-context Verify, and Report — get `xhigh`, since a weak output at any of those
single-agent gates would sink the whole lint.

A **bare string** goal works too:

```bash
node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
  --args '"make the upload endpoint faster"' \
  --frontier --auto-effort --sandbox read-only --budget 1000000
```

**Size it first** with a no-token dry run (counts agents per phase, estimates a budget):

```bash
node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
  --args-file examples/harness-zoo/goal-lint/sample-args.json --plan
```

The dry-run's token estimate is a deliberately **conservative upper bound** (it costs
every agent at the maximum tier). GoalLint's agents are short analytical passes over
your goal — not deep code reads — so real runs typically spend a fraction of it, and
`--budget` is just a ceiling: trip it and the CLI prints a paste-ready `--resume`
(finished agents replay free).

The workflow's return value prints as JSON on stdout (pipe it to `jq`); progress
streams on stderr. The `report_markdown` field is a ready-to-paste report.

---

## Output

```jsonc
{
  "verdict": "ready" | "needs-work",
  "original_goal": "…",
  "risk_level": "high" | "medium" | "low",
  "parsed": { "objective", "implied_files", "expected_commands", "success_criteria",
              "missing_constraints", "ambiguities", "risk_level" },
  "critiques": [ { "lens", "finding", "severity", "failure_mode", "fix" }, … ],
  "hardened_goal": { "objective", "context", "allowed_files", "forbidden_files",
                     "commands_to_run", "success_criteria", "failure_criteria",
                     "required_artifacts", "stopping_criteria", "do_not_overclaim" },
  "hardened_goal_markdown": "…the hardened /goal as Markdown…",
  "verification": { "resolved": [ { "lens", "resolved", "evidence" } ],
                    "unresolved_count", "residual_risks", "verdict" },
  "final_report": { "headline", "verdict", "top_actions", "summary" },
  "report_markdown": "# GoalLint report …"
}
```

Every agent uses a strict JSON schema (`additionalProperties: false`) — for the
parsed goal, each critique item, the rewritten goal, the verification result, and
the final report.

---

## When GoalLint beats a normal subagent panel

A normal review/critique panel **attempts the task** and judges the *work*.
GoalLint refuses to attempt anything and hardens the *instruction*. Reach for it
**before** you dispatch agents — when getting the goal wrong is expensive.

Use GoalLint when:

- **The goal is vague or unfalsifiable.** "Make it more robust", "clean this up",
  "make sure it works" — a panel will happily produce *something* and call it done.
  GoalLint forces a success criterion that can come back **false**.
- **The task is destructive or irreversible.** Before letting agents write files, run
  migrations, or touch infra, you want explicit **forbidden files**, a **read-only**
  default, and **stopping criteria** pinned down first — not discovered afterward.
- **You're about to spend a big budget.** Ten cheap read-only agents are insurance
  against a fleet confidently doing the wrong thing for 5M tokens. Lint the prompt,
  then run the panel.
- **Success is hard to define.** GoalLint separates *what done means* (criteria,
  artifacts, verification) from *doing it*, so the eventual executor — agent or human
  — is graded mechanically, not on its own say-so.
- **You'll hand the goal to someone/something else.** The hardened `/goal` is a
  self-contained brief: paste it into a PR, a ticket, or the next workflow.

**Reach for a normal panel instead when** the goal is already crisp and testable
(just do the work and review it), or when you need the work done *now* — GoalLint
deliberately produces a sharper prompt, not a code change.

> Rule of thumb: **GoalLint runs *before* the doers; a review panel runs *after*.**

---

## Safety

Analysis-only by design. The recommended invocation uses `--sandbox read-only`, and
the workflow never writes files — it returns Markdown *inside* its JSON result. The
workflow script itself is sandboxed (no filesystem/network/process access; only the
agents act, and here they only read). Safe to point at any repo.
