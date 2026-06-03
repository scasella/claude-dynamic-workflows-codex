#!/usr/bin/env node
// CLI entrypoint: run a persisted dynamic-workflow script against local Codex.
//
//   run-workflow <script.js> [--args JSON] [--args-file path]
//                [--budget N] [--model M] [--effort low|medium|high|...]
//                [--sandbox read-only|workspace-write|danger-full-access]
//
// Progress is written to stderr; the workflow's return value is printed as JSON
// to stdout, so you can pipe it:  run-workflow wf.js | jq .

import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { runWorkflowFile } from "../src/runWorkflow.js";
import { getClient, shutdownClient } from "../src/codexAgent.js";
import { pickFrontier } from "../src/modelMap.js";
import { Journal } from "../src/journal.js";

function parseArgs(argv) {
  const out = {
    script: null,
    args: undefined,
    budget: null,
    model: null,
    pinModel: null,
    frontier: false,
    sandbox: null,
    effort: null,
    autoEffort: false,
    pinEffort: null,
    budgetMeter: "total",
    plan: false,
    retries: null,
    journal: undefined,
    resume: false,
    noJournal: false,
    fresh: false,
    help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--args") out.args = JSON.parse(rest[++i]);
    else if (a === "--args-file") out.args = JSON.parse(readFileSync(rest[++i], "utf8"));
    else if (a === "--budget") out.budget = Number(rest[++i]);
    else if (a === "--model") out.model = rest[++i];
    else if (a === "--pin-model") out.pinModel = rest[++i];
    else if (a === "--frontier") out.frontier = true;
    else if (a === "--sandbox") out.sandbox = rest[++i];
    else if (a === "--effort") out.effort = rest[++i];
    else if (a === "--auto-effort") out.autoEffort = true;
    else if (a === "--pin-effort") out.pinEffort = rest[++i];
    else if (a === "--budget-meter") out.budgetMeter = rest[++i];
    else if (a === "--plan" || a === "--dry-run") out.plan = true;
    else if (a === "--retries") out.retries = Number(rest[++i]);
    else if (a === "--journal") out.journal = rest[++i];
    else if (a === "--resume") out.resume = true;
    else if (a === "--no-journal") out.noJournal = true;
    else if (a === "--fresh") out.fresh = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.script) out.script = a;
  }
  return out;
}

const opts = parseArgs(process.argv);

if (opts.help || !opts.script) {
  console.error(
    "usage: run-workflow <script.js> [--args JSON] [--args-file path]\n" +
      "  [--budget N] [--budget-meter total|output] [--model M] [--frontier | --pin-model M]\n" +
      "  [--effort none|minimal|low|medium|high|xhigh] [--auto-effort | --pin-effort E]\n" +
      "  [--sandbox read-only|workspace-write|danger-full-access] [--retries N]\n" +
      "  [--plan] [--resume] [--journal PATH] [--fresh] [--no-journal]\n" +
      "\n" +
      "  --frontier       pin ALL agents to the latest frontier model (auto-detected),\n" +
      "                   overriding any per-call model in the script\n" +
      "  --pin-model M    pin ALL agents to model M, overriding any per-call model\n" +
      "  --auto-effort    scale thinking effort to each layer's parallel width:\n" +
      "                   1 agent->xhigh, 2+ agents->high (floor). Critical single-agent\n" +
      "                   gates (consolidate/judge/report) get maximum reasoning.\n" +
      "                   Overridden by a per-call effort; overrides --effort.\n" +
      "  --pin-effort E   force ALL agents to effort E, overriding per-call effort\n" +
      "  --budget-meter   what budget.spent() counts: total (input+output, default) or\n" +
      "                   output (generated+reasoning, the native pool)\n" +
      "  --plan           dry run: count agents per phase/effort and estimate a --budget,\n" +
      "                   without calling any model or spending tokens",
  );
  process.exit(opts.help ? 0 : 1);
}

// Rough per-agent token estimates by effort, for --plan budget sizing. Frontier
// reasoning models, all-in (input+output+reasoning). Deliberately conservative.
const EST_TOKENS_PER_EFFORT = {
  none: 80_000, minimal: 80_000, low: 150_000, medium: 350_000, high: 550_000, xhigh: 800_000,
};
// An effort-less agent inherits the Codex config default (often xhigh); cost it
// at xhigh so the estimate doesn't under-budget.
const PLAN_DEFAULT_EFFORT = "xhigh";

function printPlan(recs) {
  const byPhase = new Map();
  for (const r of recs) {
    const ph = r.phase || "(unphased)";
    if (!byPhase.has(ph)) byPhase.set(ph, []);
    byPhase.get(ph).push(r);
  }
  console.error("\n━━ Plan (dry run — no agents executed, no tokens spent) ━━");
  let estTotal = 0;
  let sawDefault = false;
  for (const [ph, rs] of byPhase) {
    const efforts = {};
    for (const r of rs) {
      const eff = r.effort || "default";
      if (eff === "default") sawDefault = true;
      efforts[eff] = (efforts[eff] || 0) + 1;
      estTotal += EST_TOKENS_PER_EFFORT[r.effort || PLAN_DEFAULT_EFFORT] ?? EST_TOKENS_PER_EFFORT.high;
    }
    const breakdown = Object.entries(efforts).map(([e, n]) => `${e}×${n}`).join("  ");
    console.error(`  ${String(rs.length).padStart(4)}  ${ph.padEnd(20)} ${breakdown}`);
  }
  const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k");
  const suggested = Math.ceil((estTotal * 1.3) / 100_000) * 100_000;
  console.error(`  total agents: ${recs.length}`);
  console.error(
    `  estimated tokens: ~${fmtM(estTotal)}  ` +
      `(rough: low ${EST_TOKENS_PER_EFFORT.low / 1000}k / med ${EST_TOKENS_PER_EFFORT.medium / 1000}k / ` +
      `high ${EST_TOKENS_PER_EFFORT.high / 1000}k / xhigh ${EST_TOKENS_PER_EFFORT.xhigh / 1000}k per agent)`,
  );
  console.error(`  suggested --budget ${suggested}  (estimate ×1.3 headroom)`);
  if (sawDefault) console.error(`  note: 'default' (no effort set) costed at ${PLAN_DEFAULT_EFFORT} (Codex config default).`);
  console.error(
    "  ⚠ dynamic fan-outs over agent OUTPUT are not counted (arrays come back empty\n" +
      "    in a dry run), so this is a LOWER BOUND. Re-run --plan on a small --args\n" +
      "    slice for a tighter number, or size --budget up.",
  );
}

// Build a paste-ready resume command from the current argv: drop --budget, ensure
// --resume, append a higher ceiling.
function suggestResumeCmd(argv, higher) {
  const src = argv.slice(2);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "--budget") { i++; continue; }
    if (src[i] === "--resume") continue;
    out.push(src[i]);
  }
  out.push("--resume", "--budget", String(higher));
  return `node ${argv[1]} ${out.join(" ")}`;
}

// `defaultModel` is the fallback model when neither a script opt nor an
// agentType declares one; kept separate from `defaults` so it doesn't outrank them.
const defaultModel = opts.model ?? undefined;
const defaults = {};
if (opts.sandbox) defaults.sandbox = opts.sandbox;
if (opts.effort) defaults.effort = opts.effort;
if (opts.retries != null && !Number.isNaN(opts.retries)) defaults.retries = opts.retries;

// Thinking-effort policy. `--pin-effort` (authoritative) and `--auto-effort`
// (layer-width policy) are plumbed into the runtime; `--effort` stays a flat
// fallback. Validate effort spellings up front so a typo fails fast.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
for (const [flag, val] of [["--effort", opts.effort], ["--pin-effort", opts.pinEffort]]) {
  if (val && !EFFORTS.has(val)) {
    console.error(`${flag}: unknown effort '${val}' (expected ${[...EFFORTS].join("|")})`);
    process.exit(1);
  }
}
const pinnedEffort = opts.pinEffort ?? null;
if (pinnedEffort) console.error(`⊙ pinning all agents to effort: ${pinnedEffort}`);
else if (opts.autoEffort) {
  console.error("⊙ auto-effort: scaling by layer width (1→xhigh, 2+→high)");
  if (opts.effort) console.error("  note: --auto-effort governs effort; --effort is ignored");
}

if (opts.budgetMeter !== "total" && opts.budgetMeter !== "output") {
  console.error(`--budget-meter: expected 'total' or 'output', got '${opts.budgetMeter}'`);
  process.exit(1);
}

// --plan: a dry run that never connects to Codex. Execute the orchestration with
// agent() stubbed (schema skeletons) to count agents per phase/effort and estimate
// a budget. No model, no tokens, no journal.
if (opts.plan) {
  const recs = [];
  try {
    await runWorkflowFile(resolve(opts.script), {
      args: opts.args,
      budgetTotal: null,
      defaults,
      defaultModel,
      pinnedModel: opts.pinModel ?? undefined,
      autoEffort: opts.autoEffort,
      pinnedEffort,
      plan: true,
      onAgentPlan: (r) => recs.push(r),
      onPhase: () => {},
      onLog: () => {},
      journal: null,
    });
  } catch (e) {
    console.error("plan failed:", e?.stack ?? e);
    process.exit(1);
  }
  printPlan(recs);
  process.exit(0);
}

// `pinnedModel` (from --frontier or --pin-model) is authoritative: every agent
// uses it, overriding any per-call `model` a script sets. --frontier auto-detects
// the latest frontier model from model/list (warming the shared connection).
let pinnedModel = opts.pinModel ?? undefined;
if (opts.frontier) {
  try {
    const client = await getClient();
    pinnedModel = pickFrontier(await client.listModels());
  } catch (e) {
    console.error("--frontier preflight failed:", e?.message ?? e);
    await shutdownClient();
    process.exit(1);
  }
  if (!pinnedModel) {
    console.error("--frontier: could not determine a frontier model from model/list");
    await shutdownClient();
    process.exit(1);
  }
}
if (pinnedModel) console.error(`⊙ pinning all agents to model: ${pinnedModel}`);

// Resume journal: on by default (write-only); --resume reuses prior results,
// --no-journal disables, --journal overrides the path, --fresh discards first.
let journal = null;
if (!opts.noJournal) {
  const journalPath =
    opts.journal ?? `.workflow-journal/${basename(opts.script).replace(/\.[cm]?js$/, "")}.jsonl`;
  if (opts.fresh) await rm(journalPath, { force: true });
  journal = new Journal(journalPath, { reuse: opts.resume });
  await journal.load();
  console.error(
    opts.resume ? `↻ resuming from journal: ${journalPath}` : `✎ journal: ${journalPath}`,
  );
}

const onPhase = (title) => console.error(`\n━━ ${title} ━━`);
const onLog = (message) => console.error(message);

try {
  const result = await runWorkflowFile(resolve(opts.script), {
    args: opts.args,
    budgetTotal: opts.budget ?? null,
    budgetMeter: opts.budgetMeter,
    defaults,
    defaultModel,
    pinnedModel,
    autoEffort: opts.autoEffort,
    pinnedEffort,
    onPhase,
    onLog,
    journal,
  });
  console.error("\n─── result ───");
  console.log(JSON.stringify(result ?? null, null, 2));
} catch (e) {
  if (e?.code === "BUDGET_EXCEEDED") {
    const higher = opts.budget ? opts.budget * 2 : 1_000_000;
    console.error(`\n💸 ${e.message}`);
    console.error("   Completed agents are journaled — resume with a higher ceiling (they replay free, 0 tokens):");
    console.error("   " + suggestResumeCmd(process.argv, higher));
  } else {
    console.error("\nworkflow failed:", e?.stack ?? e);
  }
  process.exitCode = 1;
} finally {
  await shutdownClient();
}
