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
      "  [--budget N] [--model M] [--frontier | --pin-model M]\n" +
      "  [--effort none|minimal|low|medium|high|xhigh] [--auto-effort | --pin-effort E]\n" +
      "  [--sandbox read-only|workspace-write|danger-full-access] [--retries N]\n" +
      "  [--resume] [--journal PATH] [--fresh] [--no-journal]\n" +
      "\n" +
      "  --frontier      pin ALL agents to the latest frontier model (auto-detected),\n" +
      "                  overriding any per-call model in the script\n" +
      "  --pin-model M   pin ALL agents to model M, overriding any per-call model\n" +
      "  --auto-effort   scale thinking effort to each layer's parallel width:\n" +
      "                  1 agent->xhigh, 2+ agents->high (floor). Critical single-agent\n" +
      "                  gates (consolidate/judge/report) get maximum reasoning.\n" +
      "                  Overridden by a per-call effort; overrides --effort.\n" +
      "  --pin-effort E  force ALL agents to effort E, overriding per-call effort",
  );
  process.exit(opts.help ? 0 : 1);
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
  console.error("\nworkflow failed:", e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await shutdownClient();
}
