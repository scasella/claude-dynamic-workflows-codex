# Claude Dynamic Workflows — on Codex

> A **Claude Code skill**: type `/codex-workflows <task>` and a fleet of **Codex (GPT) agents** fans out across the work — Claude authors the workflow, runs it on your local `codex app-server`, and streams it back as a live **execution map**.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-green.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-green.svg)
[![CI](https://github.com/scasella/claude-dynamic-workflows-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/scasella/claude-dynamic-workflows-codex/actions/workflows/ci.yml)

![Execution map](docs/map-dark.png)

You describe a task; Claude Code writes a [dynamic-workflow](https://code.claude.com/docs/en/workflows) script — `agent()` / `parallel()` / `pipeline()` / `phase()` / `budget` — and runs it across dozens of GPT-5 agents instead of Claude subagents. The runtime holds the loop, branching, and intermediate results, so your context only sees the final answer — and you watch it build as an interactive map. Great for codebase audits, large migrations, cross-checked research, and idea generation.

This repo is **two ways in**:

1. **The `/codex-workflows` skill** — how you use it day to day, from the Claude Code TUI. **Start here ↓**
2. **A standalone runner + viewer** — the same engine without Claude Code (a CLI, [near the end](#without-claude-code-standalone-cli)).

> Unofficial / community project. Not affiliated with OpenAI or Anthropic.
> "Codex" and "Claude" are trademarks of their respective owners.

---

## See it now (no Codex required)

Want a look at what a finished run is before installing anything? The viewer is offline and self-contained, and a sample run is bundled:

```bash
git clone https://github.com/scasella/claude-dynamic-workflows-codex
cd claude-dynamic-workflows-codex
node runner/bin/view-run.js examples/demo --open
```

That opens the map above — a fictional 4-phase landing-page review. Click any node for its full result; **F** frames the graph, drag to pan, scroll to zoom.

| Dark | Light | Inspector |
| :--- | :--- | :--- |
| ![dark](docs/map-dark.png) | ![light](docs/map-light.png) | ![drawer](docs/drawer.png) |

This is the viewer you'll be looking at. The rest of this guide is how to *drive* it from Claude Code.

---

## Install

Clone the repo into your Claude Code skills folder, as the `codex-workflows` skill:

```bash
git clone https://github.com/scasella/claude-dynamic-workflows-codex ~/.claude/skills/codex-workflows
```

**Prerequisites**

- [Node](https://nodejs.org) ≥ 18 (zero npm dependencies to install)
- The [`codex`](https://developers.openai.com/codex/cli) CLI on your `PATH`, logged in: `codex login`
  (verify with `node ~/.claude/skills/codex-workflows/runner/test/handshake.js` → `state: ready`)

That's it — the skill is now available in Claude Code as `/codex-workflows`.

---

## Using it in Claude Code

The skill is **manual-invoke only** — Claude never auto-triggers it. You type `/codex-workflows` and describe the task in **one or two rough sentences** — there's no need to pre-engineer a prompt; the skill compiles your rough intent into the right workflow itself:

```
/codex-workflows  Audit every route under src/ for missing auth checks
```

Behind that one line, Claude:

1. **Preflights** Codex — confirms the app-server is reachable and notes the latest frontier model.
2. **Compiles** your rough intent into a concrete harness — picks the scale, archetype, and pattern, builds a task contract, and states its assumptions (no external "metaprompt" needed).
3. **Authors** a workflow script into your project (`./<name>.workflow.js`) — so you can read it, tweak it, and rerun it.
4. **Runs** it on Codex, pinning **every agent to the latest frontier model** (`gpt-5.5`) and **scaling thinking effort to the harness** — a small run goes flat `--effort medium`, while a bigger one uses `--auto-effort` so a lone judge/synthesize gate thinks hardest (`xhigh`) and wide fan-outs floor at `high`.
5. **Surfaces** the outcome right in the conversation — a summary, the script path, and the run's **execution map rendered inline** as text:

```text
╭─ ◆ market-news ──────────────────────────────────────────────────────────────╮
│ ✓✓✓✓✓✓  6/6 done · 2 phases · 701k tok · 20m27s · gpt-5.5                    │
╰──────────────────────────────────────────────────────────────────────────────╯
  │
  ▼ ① Gather ───────────────────────────────────  5 agents · 622k tok · 17m38s
      AGENT      MODEL    EFFORT  TOKENS    WALL
  ├─✓ indices    gpt-5.5  high       52k   1m26s
  │   S&P 500 rose 0.4% to a record 6,012; Nasdaq +0.6% and Dow +0.3% close.
  ├─✓ movers     gpt-5.5  high      140k   5m16s
  │   Nvidia gained ~3% on AI demand; a major retailer slid 8% on guidance.
  ╰─✓ catalysts  gpt-5.5  high      128k   3m27s
      Several megacap earnings beat after the bell; Fed stayed data-dependent.
  ┄ barrier · Gather → Synthesize ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ▼ ② Synthesize ──────────────────────────────────  1 agent · 79k tok · 2m49s
  ╰─✓ brief      gpt-5.5  xhigh      79k   2m49s
      Fed, jobs and AI earnings kept stocks near records into June 3.
  │
  ▼
╭─ ✦ result ───────────────────────────────────────────────────────────────────╮
│ Fed, jobs and AI earnings kept stocks near records into the June 3 close.    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

### Steering your run — just ask

You don't manage flags; you describe what you want and Claude wires it up. Common asks:

| You want to… | Say something like… | What Claude does |
| :--- | :--- | :--- |
| **Watch it build live** | "…and let me watch it" · "open the live GUI" | opens a browser viewer (`--gui`) and/or a new-terminal ASCII map (`--tui`) that update **in place** as agents run |
| **See the size/cost first** | "plan it first — how many agents, roughly how much?" | a **no-token dry run** (`--plan`) that counts agents per phase and estimates a budget |
| **Cap the spend** | "keep it under ~5M tokens" | a hard `--budget` ceiling — tripping it isn't fatal, it prints a one-line `--resume` to continue |
| **Keep it read-only (safety)** | "read-only — don't let agents write files" | runs every agent with `--sandbox read-only` — a **safety** choice (agents read but never write); good for audits, research, exploration. Not a way to spend less. |
| **Let it edit files** | "let it apply the migration" | `--sandbox workspace-write` (the default) so agents can write |
| **Resume after a stop** | "resume that run" | replays already-finished agents from the journal **free**, runs only the rest |
| **Pick a specific pattern** | "do a loop-until-dry bug hunt" · "fresh-context review with independent reviewers" | authors that exact pattern (see the [pattern library](references/authoring.md)) |

One thing you *don't* tune: it's always **one frontier model for every agent** — no model-mixing. Thinking **effort** scales to the harness instead (a quick 2–5-agent run goes flat `--effort medium`; bigger runs use `--auto-effort`, so lone judge/synthesis gates think hardest). **To spend less**, lower the **budget**, drop the **effort**, narrow the **fan-out**, and **`--plan` first** to size it — never a smaller model. (Read-only is a **safety** choice — what agents may touch — not a cost lever.)

### Example invocations

```
# Audit — scan in parallel, then a skeptic confirms each finding
/codex-workflows  Audit every route under src/ for missing authorization, read-only

# Research — fan out across the web, cross-check every claim, cite the survivors
/codex-workflows  Research the current state of on-device LLM inference and verify each claim, then watch it live

# Brainstorm — generate, dedup, judge, recommend (plan it first to see the cost)
/codex-workflows  Brainstorm 10 product ideas from this repo, score them with 3 judges, recommend the top 3 — plan it first

# Review — producer drafts, independent reviewers sign off (no agent reviews its own work)
/codex-workflows  Review the files I changed for bugs with a fresh-context review gate

# Triage — classify a batch in parallel, dedupe, route (untrusted text stays read-only)
/codex-workflows  Triage these 40 issues and route each to a team

# Migrate — find every call site and rewrite it (needs write access)
/codex-workflows  Find every call of legacyFetch() and migrate it to the new client, then apply the edits

# Harden a goal — lint a vague /goal into a precise, testable one before you spend a fleet (goal_lint)
/codex-workflows  Harden this Codex goal before I run it

# Claim-check — verify a draft's claims against the actual repo, refute the unsupported ones (claim_check)
/codex-workflows  Verify this blog draft against the repo

# Invent — net-new-to-industry product ideas, not thin wrappers; judged and recombined (industry_invention_studio)
/codex-workflows  Generate practically useful, net-new product ideas from this repo

# Triage a result — decide real / overfit / continue, then write the next experiment's /goal (research_result_triage)
/codex-workflows  Triage the latest research result and write the next /goal
```

Rough intent is the default — a sentence or two is enough, and the skill compiles the rest (scale, archetype, pattern, task contract, safe run settings). Add `prompt-only` if you just want the generated invocation without running it.

### Following a run

- Claude renders the **execution map inline** as the run progresses and again when it lands — so you can follow it without leaving the conversation.
- For the full browser GUI at any time, just ask Claude to **open the viewer** (it runs `view-run` on the run's journal).
- For a **cost & reliability recap** — tokens by phase, the costliest/slowest agents, and any red flags — ask Claude to **summarize the run** (it runs `summarize-run` on the journal); a short version also prints automatically when a run finishes.
- Every run is journaled to `<project>/.workflow-journal/<name>.jsonl`; ask Claude to **open the last run in the viewer** to revisit a past run.
- The script Claude wrote stays in your project — rerun or edit it directly, or ask Claude to adjust it.

> **Not what you wanted?** If you actually want **Claude** subagents (not Codex), use Claude Code's native Workflow tool instead — this skill deliberately routes the work to Codex/GPT.

---

## The run viewer

Whether Claude opens it (`--gui` / "open the viewer") or you generate it yourself, you get one **self-contained HTML file** — works offline, shareable, no server. Two layouts (toggle top-right), a **Dark / Light** theme, and per-agent **tokens, time, model, and effort** at agent, phase, and run level.

- **◇ Map** — orchestrator → one row of parallel agents per phase → barrier merges → **result**. Each node carries its model / time / tokens; it opens at a readable 100% (**F** = fit the whole graph, `0` = reset, scroll zooms toward the cursor, drag pans). Wide fan-outs fold into an **aggregate node** you expand inline (running agents are never hidden); not-yet-started phases show a "pending" placeholder. Click any node — or the **result** node — for an **inspector that docks beside the graph** (the map stays visible) with the full structured result.
- **☰ Tree** — a dense `Run → Phase → Agent` inspector: phase **progress bars** with inline per-agent time / tokens / model, and the run's actual **returned value** at the top.

![Tree view](docs/tree.png)

Results render generically (arrays-of-objects → tables, `palette` → swatches, `severity`/`effort` → badges, 1–10 → score pills, raw-JSON toggle), and it's fully **keyboard-navigable** (Tab / Enter / arrows / Esc) with `prefers-reduced-motion` support.

**Live, in place — no reload.** With `--gui`/`--watch` the viewer is a live monitor that patches the DOM **without ever reloading**: running agents are amber with a ticking clock and **stream their partial output in the drawer**, finished agents flip to their result, and a status strip tracks wall-clock / last-update age / running count. Your view is never yanked — theme, layout, the open inspector, scroll, and zoom all survive every update; an inspector left open on a still-running agent fills in *in place* the moment its result lands. When the run finishes it settles into the static, shareable artifact. (It stays a single file: the live channel uses tiny sidecars pulled via a script tag, not `fetch`, so it updates live even opened as a `file://`.)

Prefer the terminal? The same run renders as the **ASCII map** shown above — that's exactly what Claude pastes inline, and it has a live `--watch` too.

---

## Without Claude Code (standalone CLI)

The runner and viewer work on their own — no Claude Code required.

```bash
# Run a workflow script against Codex (pin the frontier model, auto-scale effort):
node runner/bin/run-workflow.js examples/review.workflow.js --frontier --auto-effort \
  --sandbox read-only --args '{"files":["src/auth.ts"],"focus":"missing auth checks"}'
# progress streams on stderr; the workflow's return value prints as JSON on stdout

# Watch it live (browser, terminal, or both):
node runner/bin/run-workflow.js examples/market-news.workflow.js --frontier --auto-effort --gui

# Turn any past run into the viewer (HTML, or a terminal ASCII map):
node runner/bin/view-run.js <project-dir> --open       # add --watch for live
node runner/bin/map-run.js  <project-dir> --watch

# Distill a finished run into a cost / performance / reliability report:
node runner/bin/summarize-run.js <project-dir>         # also: --json / --markdown / --out PATH
```

Key flags: `--frontier` (pin the latest frontier model), `--auto-effort` (scale effort to layer width), `--plan` (dry-run agent count + budget estimate, no tokens), `--budget N` (token ceiling) with `--budget-meter total|output`, `--sandbox read-only|workspace-write`, `--tui` / `--gui` / `--monitor` (live monitors), `--resume`, `--summary` (full end-of-run report). See `node runner/bin/run-workflow.js --help`.

### The run summary report

`run-workflow` prints a one-line recap when a run finishes (`--summary` for the full report; `--no-summary` to silence it). To distill any past run yourself — what it cost, where the time went, and whether anything looks off — point `summarize-run` at the journal:

```text
$ node runner/bin/summarize-run.js examples/demo

  Run summary · nimbus-landing-redesign
  Audit a fictional SaaS landing page and propose ranked, commercially-ap…

  Agents      8 completed
  Phases      4
  Tokens      2.1M   (2,150,000)
  Agent-time  19m58s   (Σ per-agent durations, not wall-clock)

── By phase ──────────────────────────────────────────────────────────────
  PHASE            AGENTS    TOKENS  AGENT-TIME
  Audit                 2      350k       3m05s
  Concept               3      765k       7m14s
  Judge                 2      623k       5m46s
  Synthesize            1      412k       3m53s

── Costliest agents (by tokens) ──────────────────────────────────────────
    1.    412k  synthesize                   Synthesize     gpt-5.5
    2.    319k  judge:growth                 Judge          gpt-5.4
    3.    304k  judge:designer               Judge          gpt-5.4
    …                                       (up to the top 10; slowest-by-time too)

── Effort ────────────────────────────────────────────────────────────────
  medium                4 agents   973k tok
  high                  4 agents   1.2M tok
```

It reads the journal plus any sidecars: the **event stream** adds true wall-clock per phase, **cache hit rate** on a resumed run, and detection of **interrupted** agents (started, never finished); the **meta** sidecar adds **budget usage**. It also flags risks — missing metrics, many null results, an un-staged huge fan-out, agents left on the expensive default effort. It's read-only (never touches the journal), handles old journals that predate the metric fields, and emits `--json` (structured) or `--markdown` (paste-ready) as well as text.

A minimal workflow script (the DSL — `agent` / `parallel` / `pipeline` / `phase` / `budget` / `args` — is documented in [`references/authoring.md`](references/authoring.md), with runnable templates in [`examples/`](examples)):

```js
export const meta = { name: "hello", description: "two agents in parallel", phases: [{ title: "Answer" }] };
phase("Answer");
const [a, b] = await parallel([
  () => agent("Reply with one word: pong."),
  () => agent("Capital of France?", { schema: { type: "object", required: ["capital"],
    additionalProperties: false, properties: { capital: { type: "string" } } } }),
]);
return { a, b };
```

There's also a one-command live demo (needs `codex login`): `npm run demo:live` fans out agents to gather today's US market news and shows the run building as a live ASCII map.

---

## How it works

Claude Code's workflow runtime is sealed inside its binary, so this is an **external re-host** of the DSL. The only provider-specific piece is `agent()`:

| Workflow concept | Codex mapping |
| :--- | :--- |
| `agent(prompt)` → final text | `thread/start` + `turn/start`, last `agentMessage.text` |
| `agent(prompt, { schema })` | native `turn/start.outputSchema` (auto-normalized for strict mode) → parsed JSON |
| `agentType: 'x'` | loads `.claude/agents/x.md` → `developerInstructions` |
| Claude model id / alias | remapped to an available Codex model via `model/list` |
| sandbox / permissions | `approvalPolicy:"never"` + sandbox |
| transient errors | retry with backoff; app-server auto-reconnect |
| `parallel` / `pipeline` / `phase` / `budget` | unchanged — provider-neutral JS |

Workflow scripts run in an isolated `node:vm` context (no `fs`/`process`/`fetch`; non-deterministic builtins blocked) — the agents do the I/O, the script coordinates. A resume journal caches each completed agent so reruns skip unchanged work.

Full internals, the protocol mapping, and a faithfulness comparison vs. the native runtime are in [`references/runner-readme.md`](references/runner-readme.md). The DSL + authoring patterns are in [`references/authoring.md`](references/authoring.md).

---

## Requirements & compatibility

- **Node ≥ 18**, zero npm dependencies.
- A logged-in **`codex` CLI** with the `app-server` subcommand. Built and verified against `codex` **0.135.0**; method names/shapes are stable, but you can regenerate bindings for your version with `codex app-server generate-json-schema --out DIR`.

## Safety

Workflow agents run with `approvalPolicy: "never"` inside a Codex sandbox (default `sandbox: workspace-write`) — like any autonomous agent run, they read, write, and execute shell commands **without prompting**. For untrusted or exploratory tasks, tell Claude to keep it **read-only** (or pass `--sandbox read-only`), and read a workflow script before you run it. The workflow *script itself* is isolated (no filesystem/network/process access) — only the agents act.

## Limitations (honest)

- This is a **standalone re-host**, not the in-Claude-Code-native experience: no in-session background tasks, no `/workflows` progress UI, no save-as-`/command` — though the live viewer and inline map cover monitoring, and `workflow("name")` resolves saved workflows from `.claude/workflows/`.
- A couple of native nuances aren't replicated 1:1: **warm-context resume** (the journal replays *results*, not Codex thread state via `thread/fork`), and budget accounting is per-process (`--budget-meter` selects total vs the native output-token pool). The map models barrier/phase structure (a clean approximation for pipeline-shaped runs). Details in the internals doc.

## Development

```bash
npm test        # offline unit checks + viewer/map robustness across run shapes (no Codex, no network)
npm run doctor  # verify the local Codex App Server is reachable & logged in
npm run demo    # open the bundled sample run in the viewer
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

```
SKILL.md                  the Claude Code skill (manual-invoke /codex-workflows)
runner/                   standalone runner (Node, zero deps)
  bin/run-workflow.js     execute a workflow script on Codex
  bin/view-run.js         generate the HTML run viewer (--watch for live)
  bin/map-run.js          render the run as an ASCII map in the terminal (--watch)
  bin/summarize-run.js    cost / performance / reliability report (text/json/markdown)
  bin/demo-live.js        run an example + watch it build live (npm run demo:live)
  src/                    codexAgent (the seam) + runtime, transport, helpers
  src/runModel.js         shared run-model assembly (HTML + ASCII viewers)
  src/asciiMap.js         ASCII map renderer
  src/runSummary.js       run-summary computation + text/markdown renderers
  test/                   offline + view-run + view-run.live + map-run + summarize-run +
                          goal-lint.plan + handshake
references/               authoring.md (DSL + patterns) · runner-readme.md (internals)
examples/                 hello · review · bug-hunt · review-gates · deep-research ·
                          market-news · tournament-sort · triage · classify-route · demo/
  harness-zoo/goal-lint/  GoalLint — harden a vague /goal into a precise, testable one
docs/                     screenshots
```

## License

[MIT](LICENSE) © Stephen Casella.
