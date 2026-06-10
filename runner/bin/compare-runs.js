#!/usr/bin/env node
// Longitudinal analytics across MANY runs — cost, reliability, and trend:
//
//   compare-runs [dir|journal ...] [--json]
//
// Each directory contributes every journal under its .workflow-journal/
// (same discovery as `fleet status`). One line per run (newest first):
// agents, completion rate, cached replays, the run's executed tokens, wall
// clock, and budget/reliability flags — plus run-over-run rollups for
// workflows that ran more than once (avg cost, completion rate, latest-vs-
// previous token trend). `summarize-run` is the per-run deep dive; this is
// the across-runs view.

import { collectComparison, renderComparisonText } from "../src/compareRuns.js";

const targets = [];
let json = false;
for (const a of process.argv.slice(2)) {
  if (a === "--json") json = true;
  else if (a === "-h" || a === "--help") {
    console.error("usage: compare-runs [dir|journal ...] [--json]");
    process.exit(0);
  } else if (a.startsWith("--")) {
    console.error(`unknown flag ${a}\nusage: compare-runs [dir|journal ...] [--json]`);
    process.exit(1);
  } else targets.push(a);
}

const cmp = collectComparison(targets);
if (json) console.log(JSON.stringify(cmp, null, 2));
else console.log(renderComparisonText(cmp));
