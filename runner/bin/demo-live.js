#!/usr/bin/env node
// demo-live.js — one command: run an example workflow on Codex and watch it build
// as a live ASCII map in this terminal. Wires run-workflow.js (which writes the
// journal as agents finish) to map-run.js --watch (which redraws it), both pointed
// at the same journal. The live map exits on its own when the run finishes.
//
// Needs a logged-in `codex` CLI (it uses --frontier) and spends a small amount of
// tokens (the default example is ~3 agents). Run it from a real terminal.
//
//   node bin/demo-live.js [--script PATH] [--args JSON] [--budget N]
//   npm run demo:live

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunModel } from "../src/runModel.js";
import { renderMap } from "../src/asciiMap.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const bin = (n) => join(__dir, n);
const EXAMPLES = resolve(__dir, "../../examples");

function parse(argv) {
  const o = { script: null, args: null, budget: 6_000_000, help: false };
  const r = argv.slice(2);
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    if (a === "--script") o.script = r[++i];
    else if (a === "--args") o.args = r[++i];
    else if (a === "--budget") o.budget = Number(r[++i]);
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}
const opts = parse(process.argv);
if (opts.help) {
  console.log(
    "usage: demo-live [--script PATH] [--args JSON] [--budget N]\n" +
      "  Run an example workflow on Codex and watch it build as a live ASCII map.\n" +
      "  Defaults to examples/market-news.workflow.js (gathers today's US market news;\n" +
      "  the agents use live web access). Needs `codex login`.",
  );
  process.exit(0);
}

const script = opts.script ? resolve(opts.script) : join(EXAMPLES, "market-news.workflow.js");
// The sandboxed workflow script can't read the clock, so inject today's date here.
const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const argsJson = opts.args ?? JSON.stringify({ date: today });

const dir = mkdtempSync(join(tmpdir(), "wf-demo-"));
const journal = join(dir, "run.jsonl");
writeFileSync(journal, ""); // pre-create so the watcher can attach immediately
const wfLog = join(dir, "workflow.log");
const color = process.stdout.isTTY && !process.env.NO_COLOR;

console.error(`▶ running ${basename(script)} on Codex`);
console.error(`  journal: ${journal}`);
console.error(`  log:     ${wfLog}`);

// The workflow runs in the background; its progress/result go to a log file so
// they don't fight the map's alternate-screen redraw.
const out = openSync(wfLog, "w");
const wf = spawn(
  "node",
  [bin("run-workflow.js"), script, "--frontier", "--auto-effort", "--sandbox", "read-only", "--budget", String(opts.budget), "--journal", journal, "--args", argsJson],
  { stdio: ["ignore", out, out] },
);

let map = null;
let finished = false;
let timer = null;

function printFinalMap() {
  try {
    const run = buildRunModel({ journalPath: journal });
    process.stdout.write("\n" + renderMap(run, { color, width: process.stdout.columns || 80 }) + "\n");
  } catch {}
}
function tailLog(n = 15) {
  try {
    const lines = readFileSync(wfLog, "utf8").trim().split("\n");
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}
function finish(code) {
  if (finished) return;
  finished = true;
  printFinalMap();
  if (code) console.error(`\n⚠ workflow exited ${code}. Last log lines (${wfLog}):\n` + tailLog());
  else console.error(`\n✓ done. Full journal: ${journal}  ·  open in a browser: node ${bin("view-run.js")} --journal ${journal} --open`);
  process.exit(code ? 1 : 0);
}

if (process.stdout.isTTY) {
  console.error("  live map opens below — it exits automatically when the run finishes (Ctrl-C to stop early)\n");
  // Give the run a moment to connect (its preflight logs land in the log file),
  // then open the live map, which owns the TTY for its alternate-screen redraw.
  timer = setTimeout(() => {
    if (finished) return;
    map = spawn("node", [bin("map-run.js"), "--journal", journal, "--watch"], { stdio: "inherit" });
    map.on("exit", () => finish(0));
  }, 400);
  wf.on("exit", (code) => {
    if (timer) clearTimeout(timer);
    if (map) map.kill("SIGINT"); // run done → stop the live map; its exit prints the final frame
    else finish(code ?? 0);
  });
} else {
  // Not a terminal (piped/CI): can't redraw live — run to completion, then print once.
  console.error("  (not a TTY — running to completion, then printing the map)\n");
  wf.on("exit", (code) => finish(code ?? 0));
}

process.on("SIGINT", () => {
  try { wf.kill(); } catch {}
  try { if (map) map.kill("SIGINT"); } catch {}
  finish(0);
});
