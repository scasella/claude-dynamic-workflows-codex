# Claude Dynamic Workflows — on Codex

> Run Claude Code's **dynamic-workflow orchestration** on a local **Codex (GPT)** backend — and **visualize any run** as an interactive execution map.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-green.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-green.svg)
[![CI](https://github.com/scasella/claude-dynamic-workflows-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/scasella/claude-dynamic-workflows-codex/actions/workflows/ci.yml)

![Execution map](docs/map-dark.png)

This repo is two things that fit together:

1. **A Claude Code skill + runner** that executes the dynamic-workflows DSL —
   `agent()` / `parallel()` / `pipeline()` / `phase()` / `budget` — against your
   local `codex app-server`. A fleet of **Codex/GPT agents** does the work instead
   of Claude subagents. You author the workflow exactly like a native one; only the
   agent backend changes.
2. **A run viewer** — a self-contained HTML **execution map** (orchestrator → phases
   → agents → result) with zoom/pan, light/dark themes, and a per-agent detail
   drawer. It renders *any* run's structured results generically.

> Unofficial / community project. Not affiliated with OpenAI or Anthropic.
> "Codex" and "Claude" are trademarks of their respective owners.

---

## See it now (no Codex required)

The viewer is offline and self-contained, and a sample run is bundled:

```bash
git clone https://github.com/scasella/claude-dynamic-workflows-codex
cd claude-dynamic-workflows-codex
node runner/bin/view-run.js examples/demo --open
```

That opens the map above — a fictional 4-phase landing-page review (Audit → Concept
→ Judge → Synthesize). Click any node to open its full result; press **F** to frame
the whole graph, drag to pan, scroll to zoom.

| Dark | Light |
| :--- | :--- |
| ![dark](docs/map-dark.png) | ![light](docs/map-light.png) |

Click a node → drill into its structured result (schema-aware: tables, color
swatches, score pills, severity/effort badges, raw JSON):

![drawer](docs/drawer.png)

---

## Why

Claude Code has [dynamic workflows](https://code.claude.com/docs/en/workflows): a
JavaScript script orchestrates dozens-to-hundreds of subagents at scale, and the
runtime holds the loop, branching, and intermediate results so your context only
sees the final answer. It's great for codebase audits, large migrations, and
cross-checked research.

This project **re-hosts that same DSL but points `agent()` at Codex** — so you can
fan work across GPT-5 agents from the same script shape. It adds the piece the
native feature doesn't have for arbitrary backends: a standalone, shareable
**visualization** of what a run actually did.

---

## Install as a Claude Code skill

Clone the repo into your personal skills folder, as the `codex-workflows` skill:

```bash
git clone https://github.com/scasella/claude-dynamic-workflows-codex ~/.claude/skills/codex-workflows
```

**Prerequisites**

- [Node](https://nodejs.org) ≥ 18
- The [`codex`](https://developers.openai.com/codex/cli) CLI on your `PATH`, logged in:
  `codex login` (verify with `node ~/.claude/skills/codex-workflows/runner/test/handshake.js`)

Then, in Claude Code:

```
/codex-workflows  Audit every route under src/ for missing auth checks
```

The skill is **manual-invoke only** — Claude won't auto-trigger it. When you invoke
it, Claude authors a workflow script and runs it on Codex via the bundled runner,
pinning every agent to the latest frontier model.

> Don't use Claude Code? You can still use the **runner and viewer standalone** —
> see below.

---

## Use the runner standalone

```bash
# Author or reuse a workflow script (the DSL is documented in references/authoring.md),
# then run it against Codex — pinning all agents to the latest frontier model:
node runner/bin/run-workflow.js examples/demo/nimbus-landing-redesign.workflow.js --frontier

# Progress streams on stderr; the workflow's return value prints as JSON on stdout.
```

Useful flags: `--frontier` (pin all agents to the auto-detected latest frontier
model), `--effort low|medium|high`, `--sandbox read-only|workspace-write`,
`--budget N` (token ceiling), `--resume` (reuse a prior run's results from the
journal). See `runner/bin/run-workflow.js --help`.

A minimal script:

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

---

## View a past run

Every run writes a journal to `<project>/.workflow-journal/<name>.jsonl`. Turn it
into a viewer:

```bash
node runner/bin/view-run.js <project-dir> --open
# or point at a journal / script explicitly:
node runner/bin/view-run.js --journal path/to.jsonl --script path/to.workflow.js --out run.html
```

The viewer has two layouts (toggle top-right) and works for any run shape:

- **◇ Map** — the execution map. Opens at a readable 100%, centered; **Fit** (`F`)
  frames the whole graph, scroll zooms toward the cursor, drag pans.
- **☰ Tree** — a `Run → Phase → Agent` sidebar + detail pane:

![Tree view](docs/tree.png)

Both render results generically (arrays-of-objects → tables, `palette` → color
swatches, `severity`/`effort` → badges, 1–10 scores → pills) and handle flat runs,
huge fan-outs (collapsed to "+N more"), journal-only runs, and string/null results.

---

## How it works

Claude Code's workflow runtime is sealed inside its binary, so this is an **external
re-host** of the DSL. The only provider-specific piece is `agent()`:

| Workflow concept | Codex mapping |
| :--- | :--- |
| `agent(prompt)` → final text | `thread/start` + `turn/start`, last `agentMessage.text` |
| `agent(prompt, { schema })` | native `turn/start.outputSchema` → parsed JSON |
| `agentType: 'x'` | loads `.claude/agents/x.md` → `developerInstructions` |
| Claude model id / alias | remapped to an available Codex model via `model/list` |
| sandbox / permissions | `approvalPolicy:"never"` + sandbox |
| transient errors | retry with backoff; app-server auto-reconnect |
| `parallel` / `pipeline` / `phase` / `budget` | unchanged — provider-neutral JS |

Workflow scripts run in an isolated `node:vm` context (no `fs`/`process`/`fetch`;
non-deterministic builtins blocked) — the agents do the I/O, the script coordinates.
A resume journal caches each completed agent so reruns skip unchanged work.

Full internals, the protocol mapping, and a faithfulness comparison vs. the native
runtime are in [`references/runner-readme.md`](references/runner-readme.md). The
DSL + authoring patterns are in [`references/authoring.md`](references/authoring.md).

---

## Requirements & compatibility

- **Node ≥ 18**, zero npm dependencies.
- A logged-in **`codex` CLI** with the `app-server` subcommand. Built and verified
  against `codex` **0.135.0**; method names/shapes are stable, but you can regenerate
  bindings for your version with `codex app-server generate-json-schema --out DIR`.

## Safety

Workflow agents run with `approvalPolicy: "never"` inside a Codex sandbox (default
`sandbox: workspace-write`) — like any autonomous agent run, they read, write, and
execute shell commands **without prompting**. Run untrusted or exploratory tasks
with `--sandbox read-only`, and read a workflow script before you run it. The
workflow *script itself* is isolated (no filesystem/network/process access) — only
the agents act.

## Limitations (honest)

- This is a **standalone re-host**, not the in-Claude-Code experience: no in-session
  background tasks, no `/workflows` TUI, no save-as-`/command`.
- A handful of native fidelity nuances aren't replicated 1:1 (per-call `phase`
  grouping, named-workflow registry, exact output-token budget accounting,
  warm-context resume). The map models barrier/phase structure (a clean
  approximation for pipeline-shaped runs). Details in the internals doc.
- Per-agent timing/tokens aren't yet persisted, so the viewer shows structure +
  results, not a cost/timeline breakdown.

## Development

```bash
npm test        # offline unit checks + viewer robustness across run shapes (no Codex, no network)
npm run doctor  # verify the local Codex App Server is reachable & logged in
npm run demo    # open the bundled sample run in the viewer
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

```
SKILL.md                  the Claude Code skill (manual-invoke /codex-workflows)
runner/                   standalone runner (Node, zero deps)
  bin/run-workflow.js     execute a workflow script on Codex
  bin/view-run.js         generate the HTML run viewer
  src/                    codexAgent (the seam) + runtime, transport, helpers
  test/                   offline + view-run robustness + handshake
references/               authoring.md (DSL) · runner-readme.md (internals)
examples/                 hello.workflow.js · review.workflow.js · demo/ (bundled run)
docs/                     screenshots
```

## License

[MIT](LICENSE) © Stephen Casella.
