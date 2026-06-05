// Checks for the run-summary tool (src/runSummary.js + bin/summarize-run.js).
// Builds synthetic runs covering the shapes a real journal can take — enriched,
// metric-less/old, resumed (cached + interrupted), budget-capped, null-heavy,
// single huge fan-out, unlabeled — and asserts the report + warnings. No tokens,
// no network. Also verifies the tool never mutates the files it reads.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { summarizeRun, renderSummaryText, renderSummaryMarkdown, renderEndOfRun, fmtTokens, fmtMs } from "../src/runSummary.js";

const BIN = new URL("../bin/summarize-run.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-sumtest-"));
const J = (o) => JSON.stringify(o);

// Write a run (journal + optional sidecars) under ROOT/<name>/.workflow-journal/
// and return the journal path.
function writeRun(name, { journal = [], events = null, result = undefined, meta = null, script = null }) {
  const dir = join(ROOT, name), jdir = join(dir, ".workflow-journal");
  mkdirSync(jdir, { recursive: true });
  const base = name + ".workflow";
  const jpath = join(jdir, base + ".jsonl");
  writeFileSync(jpath, journal.map(J).join("\n"));
  if (events) writeFileSync(join(jdir, base + ".events.jsonl"), events.map(J).join("\n"));
  if (result !== undefined) writeFileSync(join(jdir, base + ".result.json"), J(result));
  if (meta) writeFileSync(join(jdir, base + ".meta.json"), J(meta));
  if (script) writeFileSync(join(dir, base + ".js"), script);
  return { dir, jpath };
}
const codes = (s, level) => s.warnings.filter((w) => !level || w.level === level).map((w) => w.code);

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

// 1) fmt helpers match the viewer / asciiMap vocabulary.
{
  assert.equal(fmtTokens(2_150_000), "2.1M");
  assert.equal(fmtTokens(412_000), "412k");
  assert.equal(fmtTokens(null), null);
  assert.equal(fmtMs(119_600), "2m00s", "rolls over (never 1m60s)");
  assert.equal(fmtMs(5300), "5.3s");
  ok("formatting helpers");
}

// 2) Enriched single run + event sidecar: per-phase wall-clock, top lists,
//    model/effort breakdown, run wall-clock — and no spurious warnings.
{
  const journal = [
    { key: "a#0", label: "scan:auth", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 400_000, ms: 4000, result: { findings: [{ x: 1 }] } },
    { key: "b#0", label: "scan:routes", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 300_000, ms: 6000, result: { findings: [] } },
    { key: "c#0", label: "report", phase: "Report", model: "gpt-5.5", effort: "xhigh", tokens: 900_000, ms: 12_000, result: { headline: "one real issue" } },
  ];
  const events = [
    { t: 1000, type: "start", label: "scan:auth", phase: "Scan" },
    { t: 1000, type: "start", label: "scan:routes", phase: "Scan" },
    { t: 5000, type: "end", label: "scan:auth", phase: "Scan", tokens: 400_000, ms: 4000 },
    { t: 7000, type: "end", label: "scan:routes", phase: "Scan", tokens: 300_000, ms: 6000 },
    { t: 7000, type: "start", label: "report", phase: "Report" },
    { t: 19_000, type: "end", label: "report", phase: "Report", tokens: 900_000, ms: 12_000 },
  ];
  const { jpath } = writeRun("enriched", { journal, events });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.counts.journaledAgents, 3);
  assert.equal(s.counts.completedAgents, 3);
  assert.equal(s.counts.nullResults, 0);
  assert.equal(s.counts.interruptedAgents, 0);
  assert.equal(s.metrics.totalTokens, 1_600_000);
  assert.equal(s.metrics.executedTokens, 1_600_000, "fresh run: every agent finished this run → executed == all-in");
  assert.equal(s.metrics.runWallMs, 18_000, "run wall-clock = 19000 - 1000");
  const scan = s.byPhase.find((p) => p.phase === "Scan");
  assert.equal(scan.agents, 2);
  assert.equal(scan.tokens, 700_000);
  assert.equal(scan.agentMs, 10_000, "agent-time = 4000 + 6000 (sum, double-counts parallel)");
  assert.equal(scan.wallMs, 6000, "wall-clock = 7000 - 1000 (the two ran in parallel)");
  assert.equal(s.topByTokens[0].label, "report", "costliest is the synthesizer");
  assert.equal(s.topByMs[0].label, "report", "slowest is the synthesizer");
  assert.deepEqual(s.byModel, [{ model: "gpt-5.5", agents: 3, tokens: 1_600_000 }]);
  assert.deepEqual(codes(s, "warn"), [], "a clean enriched run has no warnings");
  // text + markdown render without throwing and carry the key facts
  const txt = renderSummaryText(s);
  assert.match(txt, /Run summary · enriched/);
  assert.match(txt, /Wall-clock/);
  assert.match(txt, /report/);
  assert.match(renderSummaryMarkdown(s), /\| Phase \| Agents \| Tokens \| Agent-time \| Wall \|/);
  ok("enriched run: wall-clock, top lists, breakdowns, no false warnings");
}

// 3) Old / metric-less journal (no tokens, ms, phase, model, effort), no script:
//    missing-metrics + unphased + high-cost-default-effort warnings; journal-only.
{
  const journal = [
    { key: "a#0", label: "alpha", result: "first" },
    { key: "b#0", label: "beta", result: "second" },
    { key: "c#0", label: "gamma", result: "third" },
  ];
  const { jpath } = writeRun("old", { journal });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.metrics.totalTokens, 0);
  assert.equal(s.metrics.hasMetrics, false);
  assert.equal(s.topByTokens.length, 0, "no agent carries a token metric");
  assert.equal(s.counts.cachedAgents, null, "no events -> cached unknown");
  const w = codes(s, "warn");
  assert.ok(w.includes("missing-metrics"), "all-missing metrics -> warn");
  assert.ok(w.includes("unphased-agents"), "no phase signal -> all unphased -> warn");
  assert.ok(w.includes("default-effort-cost"), "no effort -> inherits config default -> warn");
  assert.ok(codes(s).includes("no-events"), "absent event sidecar is explained");
  const txt = renderSummaryText(s);
  assert.doesNotMatch(txt, /^\s+Tokens/m, "no Tokens line when totals are zero");
  assert.match(txt, /Warnings/);
  ok("old metric-less journal: lower-bound warnings, journal-only");
}

// 4) Resumed run: event sidecar with cached replays + an interrupted agent.
{
  const journal = [
    { key: "x#0", label: "find:a", phase: "Find", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: { ok: 1 } },
    { key: "y#0", label: "find:b", phase: "Find", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: { ok: 1 } },
    { key: "z#0", label: "verify:a", phase: "Verify", model: "gpt-5.5", effort: "high", tokens: 200_000, ms: 2000, result: { real: true } },
  ];
  const events = [
    { t: 50, type: "cached", label: "find:a", phase: "Find" },
    { t: 60, type: "cached", label: "find:b", phase: "Find" },
    { t: 100, type: "start", label: "verify:a", phase: "Verify" },
    { t: 500, type: "end", label: "verify:a", phase: "Verify", tokens: 200_000, ms: 2000 },
    { t: 200, type: "start", label: "verify:b", phase: "Verify" }, // started, never ended → interrupted
  ];
  const { jpath } = writeRun("resumed", { journal, events });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.counts.cachedAgents, 2, "two cache replays this run");
  assert.equal(s.counts.interruptedAgents, 1, "verify:b started but never finished");
  assert.equal(s.counts.totalAgents, 4, "3 journaled + 1 interrupted");
  assert.ok(s.cache, "cache stats present on a resume");
  assert.equal(s.cache.cached, 2);
  assert.equal(s.cache.touched, 4, "2 cached + 2 started");
  assert.equal(s.cache.fraction, 0.5);
  assert.equal(s.metrics.totalTokens, 400_000, "all-in across the journal");
  assert.equal(s.metrics.executedTokens, 200_000, "only verify:a executed this run; cached finds replayed free");
  assert.ok(codes(s, "warn").includes("interrupted-agents"), "interrupted agents warn");
  assert.match(renderSummaryText(s), /Cache\s+50% hit/);
  ok("resumed run: cache hit rate + interrupted detection");
}

// 5) Budget meta sidecar near the ceiling → budget section + budget-pressure warn.
{
  const journal = [
    { key: "a#0", label: "scan:a", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 450_000, ms: 5000, result: {} },
    { key: "b#0", label: "scan:b", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 450_000, ms: 5000, result: {} },
  ];
  const meta = { startedAt: 1, budget: 1_000_000, budgetMeter: "total", model: "gpt-5.5", autoEffort: true, sandbox: "read-only" };
  const { jpath } = writeRun("budgeted", { journal, meta });
  const s = summarizeRun({ journalPath: jpath });
  assert.ok(s.budget, "budget present when meta carries a ceiling");
  assert.equal(s.budget.total, 1_000_000);
  assert.equal(s.budget.spent, 900_000);
  assert.equal(s.budget.remaining, 100_000);
  assert.equal(Math.round(s.budget.fraction * 100), 90);
  assert.equal(s.budget.basis, "all-in-journal", "no event sidecar → budget falls back to the all-in journal total");
  assert.match(renderSummaryText(s), /journaled all-in total/);
  assert.ok(codes(s, "warn").includes("budget-pressure"), "≥80% used -> warn");
  assert.deepEqual(s.policy, { model: "gpt-5.5", autoEffort: true, pinEffort: null, sandbox: "read-only" });
  const txt = renderSummaryText(s);
  assert.match(txt, /Budget\s+900k \/ 1\.0M total \(90% used · 100k left\)/);
  assert.match(txt, /Run policy/);
  assert.match(txt, /auto-effort/);
  ok("budget meta: usage section, pressure warning, run policy");
}

// 6) Null-heavy run → many-null-results warning (and completed excludes nulls).
{
  const mk = (i, nul) => ({ key: "n" + i + "#0", label: "task:" + i, phase: "Work", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: nul ? null : { ok: 1 } });
  const journal = [mk(0, false), mk(1, false), mk(2, false), mk(3, true), mk(4, true)];
  const { jpath } = writeRun("nulls", { journal });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.counts.nullResults, 2);
  assert.equal(s.counts.completedAgents, 3, "completed excludes nulls");
  assert.ok(codes(s, "warn").includes("many-null-results"), "2/5 null (40%) -> warn");
  ok("null-heavy run: many-null-results");
}

// 7) Single huge fan-out (≥12 agents, one phase) → structure warning.
{
  const journal = Array.from({ length: 13 }, (_, i) => ({
    key: "f" + i + "#0", label: "find:bug-" + i, phase: "Find", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: { issue: i },
  }));
  const { jpath } = writeRun("fanout", { journal });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.byPhase.length, 1);
  assert.ok(codes(s, "warn").includes("single-phase-fanout"), "13 agents in one phase -> warn");
  ok("single huge fan-out: structure warning");
}

// 8) Unlabeled agents (a prompt-slice label) → an advisory note.
{
  const journal = [
    { key: "a#0", label: "Summarize the entire architecture in painstaking detail", phase: "Work", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: "x" },
    { key: "b#0", label: "report", phase: "Work", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: "y" },
  ];
  const { jpath } = writeRun("unlabeled", { journal });
  const s = summarizeRun({ journalPath: jpath });
  assert.ok(codes(s, "info").includes("unlabeled-agents"), "prose label flagged as unlabeled");
  // the single-word 'report' must NOT be flagged
  assert.match(s.warnings.find((w) => w.code === "unlabeled-agents").message, /^1 of 2/);
  ok("unlabeled agents: advisory note, single-word labels exempt");
}

// 9) Result sidecar + --include-result: result attached and previewed; omitted otherwise.
{
  const journal = [{ key: "s#0", label: "synthesize", phase: "Synthesize", model: "gpt-5.5", effort: "xhigh", tokens: 50_000, ms: 9000, result: { headline: "internal" } }];
  const result = { headline: "Ship the state-preserving viewer", quick_wins: ["atomic writes"] };
  const { jpath } = writeRun("withresult", { journal, result });
  const plain = summarizeRun({ journalPath: jpath });
  assert.equal(plain.result, undefined, "result omitted without --include-result");
  assert.equal(plain.sources.result, true, "but its presence is noted");
  const inc = summarizeRun({ journalPath: jpath, includeResult: true });
  assert.deepEqual(inc.result, result);
  assert.match(renderSummaryText(inc, { includeResult: true }), /Ship the state-preserving viewer/);
  ok("result sidecar + --include-result");
}

// 10) renderEndOfRun: quiet (one line) for tiny runs; phase table for larger ones.
{
  const tiny = summarizeRun({ journalPath: writeRun("tiny", { journal: [
    { key: "a#0", label: "a", phase: "P", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: 1 },
    { key: "b#0", label: "b", phase: "P", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: 2 },
  ] }).jpath });
  const tinyOut = renderEndOfRun(tiny, { reportCmd: "node summarize-run.js --journal x" });
  assert.equal(tinyOut.split("\n").filter((l) => /^\s{2}\S/.test(l) && !l.includes("full report")).length, 0, "no phase table for ≤2 agents");
  assert.match(tinyOut, /^Σ 2 agents/);
  assert.match(tinyOut, /full report:/);

  const big = summarizeRun({ journalPath: writeRun("big", { journal: [
    { key: "a#0", label: "scan:a", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: 1 },
    { key: "b#0", label: "scan:b", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 100_000, ms: 1000, result: 2 },
    { key: "c#0", label: "report", phase: "Report", model: "gpt-5.5", effort: "xhigh", tokens: 300_000, ms: 4000, result: 3 },
  ] }).jpath });
  const bigOut = renderEndOfRun(big);
  assert.match(bigOut, /Scan/);
  assert.match(bigOut, /Report/);
  ok("renderEndOfRun: quiet for tiny, phase table for larger");
}

// 11) The tool is read-only: it never mutates the journal or creates sidecars.
{
  const journal = [{ key: "a#0", label: "x", phase: "P", model: "gpt-5.5", effort: "high", tokens: 1000, ms: 100, result: 1 }];
  const { dir, jpath } = writeRun("readonly", { journal });
  const jdir = join(dir, ".workflow-journal");
  const before = readFileSync(jpath, "utf8");
  const filesBefore = readdirSync(jdir).sort();
  // exercise both the library and the CLI (text + json)
  summarizeRun({ journalPath: jpath });
  execFileSync("node", [BIN, "--journal", jpath], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("node", [BIN, "--journal", jpath, "--json"], { stdio: ["ignore", "ignore", "ignore"] });
  assert.equal(readFileSync(jpath, "utf8"), before, "journal bytes unchanged");
  assert.deepEqual(readdirSync(jdir).sort(), filesBefore, "no new sidecar files created");
  ok("read-only: journal unchanged, no sidecars written");
}

// 12) End-to-end CLI: text / json / markdown / --out, and locateRun via run-dir.
{
  const { dir, jpath } = writeRun("e2e", { journal: [
    { key: "a#0", label: "scan:a", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 400_000, ms: 4000, result: { findings: [] } },
    { key: "b#0", label: "report", phase: "Report", model: "gpt-5.5", effort: "xhigh", tokens: 900_000, ms: 12_000, result: { headline: "done" } },
  ] });
  const text = execFileSync("node", [BIN, "--journal", jpath], { encoding: "utf8" });
  assert.match(text, /Run summary · e2e/);
  const json = JSON.parse(execFileSync("node", [BIN, jpath, "--json"], { encoding: "utf8" }));
  assert.equal(json.counts.journaledAgents, 2);
  const md = execFileSync("node", [BIN, dir, "--markdown"], { encoding: "utf8" });
  assert.match(md, /^# Run summary — e2e/m);
  const outPath = join(ROOT, "e2e.json");
  execFileSync("node", [BIN, "--journal", jpath, "--json", "--out", outPath], { stdio: ["ignore", "ignore", "ignore"] });
  assert.equal(JSON.parse(readFileSync(outPath, "utf8")).counts.journaledAgents, 2, "--out wrote the JSON report");
  ok("end-to-end CLI: text / json / markdown / --out / run-dir");
}

// 13) Resumed run WITH a budget + id-bearing events: budget bills the LATEST run's
//     executed tokens (matched by id), separate from the journal's all-in total.
{
  const journal = [
    { key: "x#0", label: "scan:a", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 450_000, ms: 5000, result: {} },
    { key: "y#0", label: "scan:b", phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 450_000, ms: 5000, result: {} },
    { key: "z#0", label: "report", phase: "Report", model: "gpt-5.5", effort: "xhigh", tokens: 300_000, ms: 4000, result: {} },
  ];
  // resume: the two scans replay from cache (0 tokens this run); only report executes.
  const events = [
    { t: 10, type: "cached", id: "x#0", label: "scan:a", phase: "Scan" },
    { t: 20, type: "cached", id: "y#0", label: "scan:b", phase: "Scan" },
    { t: 100, type: "start", id: "z#0", label: "report", phase: "Report" },
    { t: 500, type: "end", id: "z#0", label: "report", phase: "Report", tokens: 300_000, ms: 4000 },
  ];
  const meta = { budget: 1_000_000, budgetMeter: "total", model: "gpt-5.5", autoEffort: true, sandbox: "read-only" };
  const { jpath } = writeRun("resumed-budget", { journal, events, meta });
  const s = summarizeRun({ journalPath: jpath });
  assert.equal(s.metrics.totalTokens, 1_200_000, "all-in across the journal");
  assert.equal(s.metrics.executedTokens, 300_000, "only report executed this run (matched by id)");
  assert.equal(s.budget.basis, "latest-run", "with events present, budget bills the latest run");
  assert.equal(s.budget.spent, 300_000, "spent = executed-this-run, not the all-in 1.2M");
  assert.equal(s.budget.allInTokens, 1_200_000);
  assert.equal(s.budget.remaining, 700_000);
  const txt = renderSummaryText(s);
  assert.match(txt, /Executed/, "report distinguishes executed-this-run");
  assert.match(txt, /this run/, "budget line labels the latest-run basis");
  ok("resumed + budget + events: latest-run executed tokens vs all-in journal total");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nsummarize-run checks passed ✓ (${n} groups)`);
