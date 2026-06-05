#!/usr/bin/env node
// summarize-run.js — read a workflow run's journal (+ optional event / result /
// meta sidecars) and print a concise cost / performance / reliability report.
// Read-only: it never writes or mutates the journal.
//
// Usage:
//   node bin/summarize-run.js --journal <path.jsonl> [--json] [--markdown]
//                             [--out PATH] [--include-result] [--script PATH]
//   node bin/summarize-run.js <run-dir | journal.jsonl> [flags]
//
//   default output is a human-readable text report; --json emits the structured
//   summary, --markdown a paste-ready report. --out writes to a file (else stdout).

import { writeFileSync } from "node:fs";
import { locateRun, listJournalsForTarget } from "../src/runModel.js";
import { summarizeRun, renderSummaryText, renderSummaryMarkdown } from "../src/runSummary.js";

function parseArgs(argv) {
  const out = { target: null, journal: null, script: null, title: null, json: false, markdown: false, out: null, includeResult: false, list: false, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--journal") out.journal = rest[++i];
    else if (a === "--script") out.script = rest[++i];
    else if (a === "--title") out.title = rest[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--markdown" || a === "--md") out.markdown = true;
    else if (a === "--out") out.out = rest[++i];
    else if (a === "--include-result") out.includeResult = true;
    else if (a === "--list") out.list = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.target) out.target = a;
  }
  return out;
}

const opts = parseArgs(process.argv);
if (opts.list) {
  const journals = listJournalsForTarget(opts.target || opts.journal);
  if (!journals.length) { console.error("no journals found (looked in <dir>/.workflow-journal)"); process.exit(1); }
  console.error("journals (newest first) — pick one with --journal <path>:");
  for (const j of journals) process.stdout.write(`${new Date(j.mtimeMs).toISOString()}  ${String(j.size).padStart(9)}B  ${j.path}\n`);
  process.exit(0);
}
if (opts.help || (!opts.journal && !opts.target)) {
  console.error(
    "usage: summarize-run --journal <path.jsonl> [--json] [--markdown] [--out PATH]\n" +
      "                     [--include-result] [--script PATH] [--list]\n" +
      "       summarize-run <run-dir | journal.jsonl> [flags]\n" +
      "\n" +
      "  Concise cost / performance / reliability report for a workflow run.\n" +
      "  Reads the journal (+ event / result / meta sidecars when present); never\n" +
      "  writes them. Default output is text; --json / --markdown switch format,\n" +
      "  --out writes to a file instead of stdout. --list shows a run dir's journals\n" +
      "  (newest first) so you can pick one with --journal.",
  );
  process.exit(opts.help ? 0 : 1);
}

const located = locateRun({ target: opts.target, journal: opts.journal, script: opts.script });
if (located.error) { console.error(located.error); process.exit(1); }
const { journalPath, scriptPath, runDir } = located;

const summary = summarizeRun({ journalPath, scriptPath, runDir, title: opts.title, includeResult: opts.includeResult });

// Precedence when more than one format is requested: json > markdown > text.
let output;
if (opts.json) output = JSON.stringify(summary, null, 2);
else if (opts.markdown) output = renderSummaryMarkdown(summary, { includeResult: opts.includeResult });
else output = renderSummaryText(summary, { includeResult: opts.includeResult });

if (opts.out) {
  writeFileSync(opts.out, output.endsWith("\n") ? output : output + "\n");
  console.error(`wrote ${opts.json ? "JSON" : opts.markdown ? "Markdown" : "text"} summary → ${opts.out}`);
} else {
  process.stdout.write(output.endsWith("\n") ? output : output + "\n");
}
