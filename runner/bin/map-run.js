#!/usr/bin/env node
// map-run.js — render a codex-workflows run as an ASCII execution map in the
// terminal. With --watch it redraws in place as the journal grows, so you get a
// live map of a run without leaving the shell (the terminal analogue of
// view-run.js --watch).
//
// Usage:
//   node bin/map-run.js <run-dir | journal.jsonl> [--script PATH] [--journal PATH]
//                       [--watch] [--no-color] [--max-agents N] [--title TXT]

import { statSync } from "node:fs";
import { basename } from "node:path";
import { locateRun, buildLiveRunModel, eventsPathFor } from "../src/runModel.js";
import { renderMap } from "../src/asciiMap.js";

function parseArgs(argv) {
  const out = { target: null, script: null, journal: null, title: null, watch: false, color: null, maxAgents: 12, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--script") out.script = rest[++i];
    else if (a === "--journal") out.journal = rest[++i];
    else if (a === "--title") out.title = rest[++i];
    else if (a === "--watch") out.watch = true;
    else if (a === "--no-color") out.color = false;
    else if (a === "--color") out.color = true;
    else if (a === "--max-agents") out.maxAgents = Math.max(2, Number(rest[++i]) || 12);
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.target) out.target = a;
  }
  return out;
}

const opts = parseArgs(process.argv);
if (opts.help || (!opts.target && !opts.journal)) {
  console.error(
    "usage: map-run <run-dir | journal.jsonl> [--script PATH] [--journal PATH]\n" +
      "               [--watch] [--no-color] [--max-agents N] [--title TXT]\n" +
      "\n" +
      "  ASCII execution map of a run; --watch redraws live as the journal grows.",
  );
  process.exit(opts.help ? 0 : 1);
}

const located = locateRun({ target: opts.target, journal: opts.journal, script: opts.script });
if (located.error) { console.error(located.error); process.exit(1); }
const { journalPath, scriptPath, runDir } = located;

// Color on when stdout is a TTY and NO_COLOR isn't set, unless overridden.
const color = opts.color ?? (process.stdout.isTTY && !process.env.NO_COLOR);
const width = () => process.stdout.columns || 80;
const eventsPath = eventsPathFor(journalPath);
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const watchStartedAt = Date.now();

// Build the run model with in-flight (running) agents merged from the event
// sidecar, so the live map shows started-but-unfinished work (shared with the
// HTML viewer via runModel.js).
const buildLiveModel = () => buildLiveRunModel({ journalPath, scriptPath, runDir, title: opts.title });

let model = buildLiveModel();
// Render the graph; in a height-bounded terminal, drop the per-agent snippets so
// the frame still fits (otherwise a too-tall frame breaks the home-anchored redraw).
const render = (now, spin) => {
  const opt = { color, width: width(), maxAgents: opts.maxAgents, now, spinner: spin };
  const full = renderMap(model, opt);
  const rows = process.stdout.rows || 0;
  if (rows && full.split("\n").length + 2 > rows) return renderMap(model, { ...opt, snippets: false });
  return full;
};

// One-shot (or non-TTY --watch, where an alternate-screen redraw is impossible).
if (!opts.watch || !process.stdout.isTTY) {
  if (opts.watch && !process.stdout.isTTY) console.error("(--watch needs a TTY; printing once)");
  process.stdout.write(render(Date.now(), SPIN[0]) + "\n");
  process.exit(0);
}

// --watch: alternate screen + animated in-place redraw.
const ALT_ON = "\x1b[?1049h", ALT_OFF = "\x1b[?1049l", CURSOR_HIDE = "\x1b[?25l", CURSOR_SHOW = "\x1b[?25h", HOME = "\x1b[H", CLEAR_EOL = "\x1b[K", CLEAR_DOWN = "\x1b[0J";
const dim = (s) => (color ? "\x1b[2m" + s + "\x1b[0m" : s);
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
const clock = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s"; };
let spin = 0, lastSig = "";

function footer(now) {
  const live = model.live || {};
  const done = model.agents.filter((a) => a.status !== "running").length;
  const running = model.agents.length - done;
  const start = live.runStartedAt || watchStartedAt;
  // Freeze the wall-clock at the last event once nothing is running.
  const elapsed = running === 0 && live.lastEventAt && live.runStartedAt ? live.lastEventAt - live.runStartedAt : now - start;
  const lead = running > 0 ? SPIN[spin % SPIN.length] : "✓";
  return dim(`  ${lead} ${clock(elapsed)}  ·  ${done} done${running ? ` · ${running} running` : ""}  ·  updated ${new Date(now).toLocaleTimeString()}  ·  Ctrl-C to exit`);
}

function draw() {
  // Rebuild the model only when a file changed; redraw every tick to animate.
  const sig = sizeOf(journalPath) + ":" + sizeOf(eventsPath);
  if (sig !== lastSig) { lastSig = sig; model = buildLiveModel(); }
  const now = Date.now();
  const body = render(now, SPIN[spin % SPIN.length]) + "\n" + footer(now);
  // Clear each line to EOL (kills leftovers from a longer previous frame), then
  // clear everything below — fixes the "39sCtrl-C" overlap artifact.
  process.stdout.write(HOME + body.split("\n").map((l) => l + CLEAR_EOL).join("\n") + CLEAR_DOWN);
  spin++;
}

function restore() { process.stdout.write(CURSOR_SHOW + ALT_OFF); }

process.stdout.write(ALT_ON + CURSOR_HIDE);
draw();
const timer = setInterval(draw, 250);
process.on("SIGWINCH", draw); // re-flow on terminal resize
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { clearInterval(timer); restore(); process.exit(0); });
}
