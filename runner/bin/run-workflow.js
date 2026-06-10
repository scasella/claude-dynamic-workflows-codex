#!/usr/bin/env node
// CLI entrypoint: run a persisted dynamic-workflow script against local Codex.
//
//   run-workflow <script.js> [--args JSON] [--args-file path]
//                [--budget N] [--model M] [--effort low|medium|high|...]
//                [--sandbox read-only|workspace-write|danger-full-access]
//
// Progress is written to stderr; the workflow's return value is printed as JSON
// to stdout, so you can pipe it:  run-workflow wf.js | jq .

import { resolve, basename, dirname, join } from "node:path";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkflowFile } from "../src/runWorkflow.js";
import { getClient, shutdownClient } from "../src/codexAgent.js";
import { pickFrontier } from "../src/modelMap.js";
import { Journal } from "../src/journal.js";
import { eventsPathFor, resultPathFor, progressPathFor, runMetaPathFor, questionsPathFor, answersPathFor } from "../src/runModel.js";
import { summarizeRun, renderSummaryText, renderEndOfRun } from "../src/runSummary.js";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));

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
    tui: false,
    gui: false,
    interactive: false,
    retries: null,
    journal: undefined,
    resume: false,
    noJournal: false,
    fresh: false,
    summary: false,
    noSummary: false,
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
    else if (a === "--tui") out.tui = true;
    else if (a === "--gui") out.gui = true;
    else if (a === "--monitor") { out.tui = true; out.gui = true; }
    else if (a === "--interactive") out.interactive = true;
    else if (a === "--retries") out.retries = Number(rest[++i]);
    else if (a === "--journal") out.journal = rest[++i];
    else if (a === "--resume") out.resume = true;
    else if (a === "--no-journal") out.noJournal = true;
    else if (a === "--fresh") out.fresh = true;
    else if (a === "--summary") out.summary = true;
    else if (a === "--no-summary") out.noSummary = true;
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
      "  [--plan] [--tui] [--gui] [--resume] [--journal PATH] [--fresh] [--no-journal]\n" +
      "  [--summary | --no-summary]\n" +
      "\n" +
      "  --tui            open a live ASCII map of the run in a new terminal window\n" +
      "  --gui            open a live HTML viewer of the run in your browser, served on\n" +
      "                   localhost so the workflow's human() questions are answerable\n" +
      "                   in the page (--monitor opens both)\n" +
      "  --interactive    enable the human() answer channel without a monitor —\n" +
      "                   answer from another terminal by appending to the\n" +
      "                   <journal>.answers.jsonl sidecar\n" +
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
      "                   without calling any model or spending tokens\n" +
      "  --summary        print the full cost/performance/reliability report at the end\n" +
      "                   (a short one is printed automatically; --no-summary silences it)",
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

// Open the live ASCII map in a NEW terminal window (it needs its own TTY for the
// alternate-screen redraw). macOS uses Terminal via osascript; elsewhere we print
// the command to run. The window persists after the run (Ctrl-C there to close).
function openTuiWindow(journalAbs) {
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const cmd = `node ${shq(join(BIN_DIR, "map-run.js"))} --journal ${shq(journalAbs)} --watch`;
  if (process.platform === "darwin") {
    const osa = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    try {
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${osa(cmd)}`, "-e", 'tell application "Terminal" to activate'], { stdio: "ignore", detached: true }).unref();
      console.error("🖥  TUI monitor: live map opening in a new Terminal window…");
      return;
    } catch {}
  }
  console.error("🖥  TUI monitor — run this in another terminal for a live map:\n   " + cmd);
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
let onEvent;
let onProgress;
let progressTimer = null;
let journalPath = null;
if (!opts.noJournal) {
  journalPath =
    opts.journal ?? `.workflow-journal/${basename(opts.script).replace(/\.[cm]?js$/, "")}.jsonl`;
  // The sidecars (events/meta/progress/questions) are written below with silent
  // best-effort guards — make sure the journal dir exists FIRST, or on a fresh
  // project they all no-op until the first journal record creates it.
  try { mkdirSync(dirname(resolve(journalPath)), { recursive: true }); } catch {}
  if (opts.fresh) await rm(journalPath, { force: true });
  journal = new Journal(journalPath, { reuse: opts.resume });
  await journal.load();
  console.error(
    opts.resume ? `↻ resuming from journal: ${journalPath}` : `✎ journal: ${journalPath}`,
  );

  // Lifecycle events sidecar (live observability) — separate from the resume
  // journal, truncated fresh each run, best-effort so it never blocks the run.
  const eventsPath = eventsPathFor(journalPath);
  try { writeFileSync(eventsPath, ""); } catch {}

  // Run-meta sidecar: the budget ceiling + effort/model policy the journal can't
  // carry, so a post-hoc `summarize-run` can report budget usage. Best-effort.
  try {
    writeFileSync(runMetaPathFor(journalPath), JSON.stringify({
      budget: opts.budget ?? null,
      budgetMeter: opts.budgetMeter,
      model: pinnedModel ?? defaultModel ?? null,
      autoEffort: opts.autoEffort,
      pinEffort: pinnedEffort,
      sandbox: opts.sandbox ?? null,
    }));
  } catch {}

  // Live partial-output sidecar: { label: latest partial text } for agents that are
  // still streaming, so a live viewer can preview progress instead of a blank pane.
  // Rewritten on a throttle (atomic), bounded in size, best-effort — never blocks.
  const progressPath = progressPathFor(journalPath);
  try { writeFileSync(progressPath, "{}"); } catch {}
  const progress = new Map();
  let progressDirty = false;
  const flushProgress = () => {
    progressDirty = false;
    try {
      const obj = {};
      for (const [k, v] of progress) obj[k] = v.length > 4000 ? v.slice(-4000) : v; // bounded tail
      const tmp = progressPath + ".tmp";
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, progressPath);
    } catch {}
  };
  const scheduleProgress = () => {
    progressDirty = true;
    if (progressTimer) return;
    progressTimer = setInterval(() => {
      if (progressDirty) flushProgress();
      else { clearInterval(progressTimer); progressTimer = null; } // idle → stop until next stream
    }, 700);
  };
  // Key live partial output by the stable agent id (the journal key; falls back to
  // label), so the viewer attaches it to the right agent even when labels repeat.
  onProgress = (label, text, id) => { progress.set(id ?? label, text); scheduleProgress(); };

  onEvent = (e) => {
    // an agent that finished shows its real result, not a stale partial — drop it
    const pk = e.id ?? e.label;
    if ((e.type === "end" || e.type === "cached") && pk && progress.delete(pk)) scheduleProgress();
    try { appendFileSync(eventsPath, JSON.stringify({ t: Date.now(), ...e }) + "\n"); } catch {}
  };
}

// ── interactive involvement channel (the workflow's `human()` global) ─────────
// Questions go OUT via the questions sidecar (the live viewer renders an answer
// card; `--gui` serves the viewer over localhost so the card can POST back).
// Answers come IN via the answers jsonl — appended by the viewer's /answer
// endpoint, or by hand:  echo '{"id":"<id>","answer":"yes"}' >> <…>.answers.jsonl
// Auto-enabled by --gui/--tui (a monitor is attached); --interactive forces it on
// for headless runs you plan to answer from another terminal.
const interactive = (opts.interactive || opts.gui || opts.tui) && !!journalPath;
let humanChannel;
if (interactive) {
  const questionsPath = questionsPathFor(journalPath);
  const answersPath = answersPathFor(journalPath);
  try { writeFileSync(questionsPath, "[]"); } catch {}
  try { if (!existsSync(answersPath)) writeFileSync(answersPath, ""); } catch {}
  const questions = [];
  const flushQuestions = () => {
    try { const tmp = questionsPath + ".tmp"; writeFileSync(tmp, JSON.stringify(questions)); renameSync(tmp, questionsPath); } catch {}
  };
  const readAnswers = () => {
    const out = new Map();
    try {
      for (const line of readFileSync(answersPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const a = JSON.parse(line); if (a && a.id !== undefined) out.set(String(a.id), a); } catch {}
      }
    } catch {}
    return out;
  };
  humanChannel = {
    notify(q) { questions.push({ ...q, askedAt: Date.now(), answered: false }); flushQuestions(); },
    async wait(id, { timeoutMs = 600_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const a = readAnswers().get(String(id));
        const q = questions.find((x) => x.id === id);
        if (a) { if (q) { q.answered = true; q.answer = a.answer; } flushQuestions(); return { answer: a.answer }; }
        if (Date.now() >= deadline) { if (q) { q.answered = true; q.timedOut = true; } flushQuestions(); return undefined; }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  };
}

// --tui / --gui: open a live monitor that watches this run's journal + events as
// it progresses — a new Terminal window with the live ASCII map (--tui) and/or the
// HTML viewer in your browser (--gui). Spawned before the run so it's up from the
// first agent. Both show every agent (running + done) with constant updates.
let guiChild = null;
if ((opts.tui || opts.gui) && journalPath) {
  const abs = resolve(journalPath);
  try { mkdirSync(dirname(abs), { recursive: true }); if (!existsSync(abs)) writeFileSync(abs, ""); } catch {}
  if (opts.gui) {
    // --serve: the live viewer is served over localhost (not file://), so its
    // human() answer card can POST back — the interactive cockpit channel.
    guiChild = spawn("node", [join(BIN_DIR, "view-run.js"), "--journal", abs, "--watch", "--serve", "--open"], { stdio: "ignore" });
    console.error("🖥  GUI monitor: live HTML viewer opening in your browser…");
  }
  if (opts.tui) openTuiWindow(abs);
} else if ((opts.tui || opts.gui) && !journalPath) {
  console.error("note: --tui/--gui need the journal; ignored with --no-journal");
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
    onEvent,
    onProgress,
    journal,
    humanChannel,
  });
  console.error("\n─── result ───");
  console.log(JSON.stringify(result ?? null, null, 2));
  // Persist the actual return value next to the journal so the viewer's result
  // node shows the honest workflow output (not a heuristic "final" agent).
  if (journalPath && result !== undefined) {
    try { writeFileSync(resultPathFor(journalPath), JSON.stringify(result ?? null)); } catch {}
  }
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
  if (progressTimer) { try { clearInterval(progressTimer); } catch {} progressTimer = null; }
  await shutdownClient();
  if (guiChild) {
    try { guiChild.kill(); } catch {}
    // Settle the browser: --settle writes a static (data-live="0") HTML plus a
    // final sidecar (final:true). The open live page picks up the sidecar, patches
    // to the finished state in place, and stops polling — no reload, no flicker.
    try { spawnSync("node", [join(BIN_DIR, "view-run.js"), "--journal", resolve(journalPath), "--settle"], { stdio: "ignore" }); } catch {}
  }
  // End-of-run recap (stderr): a short cost/performance/reliability summary, or the
  // full report with --summary. Quiet for tiny runs; silenced by --no-summary.
  // Best-effort and fully guarded — a summary hiccup never changes the run outcome.
  if (journalPath && !opts.noSummary && existsSync(journalPath)) {
    try {
      const s = summarizeRun({ journalPath, scriptPath: resolve(opts.script) });
      if (s.counts.journaledAgents > 0) {
        if (opts.summary) {
          console.error("\n" + renderSummaryText(s));
        } else {
          const reportCmd = `node ${join(BIN_DIR, "summarize-run.js")} --journal ${journalPath}`;
          const block = renderEndOfRun(s, { reportCmd });
          if (block) console.error("\n─── summary ───\n" + block);
        }
      }
    } catch {}
  }
  if (opts.tui) console.error("ℹ  the TUI monitor window keeps running — Ctrl-C there to close it.");
}
