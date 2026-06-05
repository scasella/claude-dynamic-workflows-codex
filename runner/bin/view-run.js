#!/usr/bin/env node
// view-run.js — generate a polished, self-contained HTML viewer for a
// codex-workflows run, with progressive disclosure: Run → Phase → Agent → full
// structured result.
//
// Data sources (all self-contained in the run directory; no transcript needed):
//   • <dir>/.workflow-journal/<name>.jsonl   — completed agent results (label, result)
//   • <dir>/<name>.workflow.js               — meta (name, phases) + per-agent model/effort/phase
//
// Usage:
//   node bin/view-run.js <run-dir | journal.jsonl> [--script PATH] [--journal PATH]
//                        [--out PATH] [--title TXT] [--open]
//
// Emits a single .html file (data embedded inline) and prints its path.

import { writeFileSync, statSync, renameSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { locateRun, buildLiveRunModel, eventsPathFor, progressPathFor } from "../src/runModel.js";

// Write atomically so a watching browser never loads a half-written file:
// write to a unique temp path in the same dir, then rename (atomic on POSIX).
let __atomicSeq = 0;
function writeAtomic(outPath, content) {
  const tmp = `${outPath}.tmp-${process.pid}-${__atomicSeq++}`;
  writeFileSync(tmp, content);
  renameSync(tmp, outPath);
}

// Live data sidecars next to the HTML — the no-reload update channel. The page
// polls <base>.gen.js (a tiny monotonic counter); when it advances, it pulls
// <base>.data.js (window.__wfPush(gen, model)) and reconciles in place. Loaded
// via classic <script src> injection, which works on file:// (unlike fetch).
function sidecarBase(outPath) {
  return outPath.replace(/\.html?$/i, "");
}
function writeSidecars(outPath, runModel, gen) {
  const base = sidecarBase(outPath);
  const json = JSON.stringify(runModel).replace(/</g, "\\u003c");
  writeAtomic(base + ".data.js", `window.__wfPush&&window.__wfPush(${gen},${json});\n`);
  writeAtomic(base + ".gen.js", `window.__wfGen&&window.__wfGen(${gen});\n`);
}
const nowGen = () => Date.now(); // gen = wall-clock ms: monotonic enough + cross-process comparable

// ── args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { target: null, script: null, journal: null, outPath: null, title: null, open: false, watch: false, settle: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--script") out.script = rest[++i];
    else if (a === "--journal") out.journal = rest[++i];
    else if (a === "--out") out.outPath = rest[++i];
    else if (a === "--title") out.title = rest[++i];
    else if (a === "--open") out.open = true;
    else if (a === "--watch") out.watch = true;
    else if (a === "--settle") out.settle = true; // final render: static HTML + a final sidecar so an open live page settles
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.target) out.target = a;
  }
  return out;
}

const opts = parseArgs(process.argv);
if (opts.help || (!opts.target && !opts.journal)) {
  console.error(
    "usage: view-run <run-dir | journal.jsonl> [--script PATH] [--journal PATH] [--out PATH] [--title TXT] [--open]",
  );
  process.exit(opts.help ? 0 : 1);
}

// ── locate the run (journal + script), shared with the ASCII map viewer ──────
const located = locateRun({ target: opts.target, journal: opts.journal, script: opts.script });
if (located.error) { console.error(located.error); process.exit(1); }
const { journalPath, scriptPath, runDir } = located;
// Assemble the run model from disk — re-callable so --watch can rebuild it.
const buildModel = () => buildLiveRunModel({ journalPath, scriptPath, runDir, title: opts.title });

// ── emit ────────────────────────────────────────────────────────────────────
// (emit happens at the end of the file, once CSS/APP consts are initialized)

// ── HTML template ─────────────────────────────────────────────────────────
function renderHtml(runModel, live = false, gen = 0) {
  if (gen) runModel.gen = gen; // generation stamp: lets the live page detect fresh sidecar data
  const dataJson = JSON.stringify(runModel).replace(/</g, "\\u003c");
  // In --watch mode the page updates WITHOUT reloading: it polls tiny gen.js /
  // data.js sidecars (classic <script src>, file://-safe) and reconciles the DOM
  // in place — no flash, no drawer re-slide. data-live="1" turns that loop on;
  // "0" is a settled/static render (data fully inlined, no polling, works offline).
  return `<!doctype html>
<html lang="en" data-live="${live ? "1" : "0"}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(runModel.name)} · codex-workflows run</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script id="run-data" type="application/json">${dataJson}</script>
<script>${APP}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const CSS = String.raw`
:root{
  --bg:#07080A; --panel:#0D1015; --panel2:#14181F; --border:#1e2731; --border2:#2a343f;
  --text:#E6EDF3; --muted:#8b96a1; --dim:#7b8794;
  --green:#6EE7B7; --amber:#FBBF24; --red:#F87171; --blue:#60A5FA; --purple:#A78BFA; --cyan:#22D3EE;
  --edge:#4d5b69; --arrow:#586a79; --focus:#7cc4ff; --sw-bg:#0b0e12;
  --endpoint-bg:linear-gradient(180deg,#121b27,#0b1017); --endpoint-text:#f3f7fa; --endpoint-border:#2c4a59;
  --barrier:#3a4855; --barrier-dot:#10161d; --barrier-dot-border:#46586a;
  --header-bg:linear-gradient(180deg,#0c1016,#080a0d); --sidebar-bg:#090b0e; --surface-hover:#11151b;
  --hero-bg:linear-gradient(180deg,#0e141b,#0b0f14); --hero-border:#1d2b25;
  --tag-bg:#11161d; --json-bg:#08090c; --row-hover:#0e1217; --backdrop:rgba(2,4,6,.55); --swatch-border:rgba(255,255,255,.18);
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
.theme-light{
  --bg:#f6f5ef; --panel:#ffffff; --panel2:#ffffff; --border:#e4e2d8; --border2:#d6d4c8;
  --text:#1b1e22; --muted:#5f6670; --dim:#6b727c;
  --green:#047857; --amber:#b45309; --red:#dc2626; --blue:#2563eb; --purple:#7c3aed; --cyan:#0e7490;
  --edge:#595d55; --arrow:#42463e; --focus:#1d6fd6; --sw-bg:#f8f7f1;
  --endpoint-bg:#1c1f24; --endpoint-text:#ffffff; --endpoint-border:#1c1f24;
  --barrier:#cdcbbf; --barrier-dot:#ffffff; --barrier-dot-border:#bcbaae;
  --header-bg:linear-gradient(180deg,#fbfaf5,#f2f1e9); --sidebar-bg:#f1f0e8; --surface-hover:#efeee6;
  --hero-bg:linear-gradient(180deg,#ffffff,#f7f6f0); --hero-border:#dde6e1;
  --tag-bg:#f0efe7; --json-bg:#faf9f3; --row-hover:#f4f3eb; --backdrop:rgba(28,30,28,.30); --swatch-border:rgba(0,0,0,.16);
}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
#app{height:100vh;display:flex;flex-direction:column}
a{color:var(--blue);text-decoration:none}

/* header */
header{border-bottom:1px solid var(--border);padding:14px 20px;background:
  var(--header-bg);display:flex;flex-direction:column;gap:8px}
.brandrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase}
.runname{font-weight:600;font-size:18px;letter-spacing:-.01em}
.desc{color:var(--muted);font-size:13px;max-width:90ch}
.metarow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:2px}
.pill{font-family:var(--mono);font-size:11px;padding:3px 9px;border:1px solid var(--border2);
  border-radius:999px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pill.ok{color:var(--green);border-color:var(--border2)}
.pill.run{color:var(--amber);border-color:var(--border2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}
.dot.amber,.sdot.amber,.msdot.amber{background:var(--amber);box-shadow:0 0 8px var(--amber)}
@keyframes wfpulse{0%,100%{opacity:1}50%{opacity:.35}}
.dot.amber,.sdot.amber,.msdot.amber{animation:wfpulse 1.2s ease-in-out infinite}
.mnode.running{border-color:var(--amber)}
.chip{font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid var(--border2);white-space:nowrap}

/* live status strip (--watch) */
.livebar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px;padding:7px 11px;border-radius:8px;
  background:var(--surface-hover);border:1px solid var(--border2);font-family:var(--mono);font-size:11px;color:var(--muted)}
.livebar .lk{color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:10px;margin-right:5px}
.livebar .lv{color:var(--text)}
.livebar.stale{border-color:var(--amber)} .livebar.stale .stale-flag{color:var(--amber)}
.livedot{width:7px;height:7px;border-radius:50%;background:var(--amber);box-shadow:0 0 8px var(--amber);
  animation:wfpulse 1.2s ease-in-out infinite}

/* layout */
.body{flex:1;display:grid;grid-template-columns:330px 1fr;min-height:0}
.sidebar{border-right:1px solid var(--border);overflow:auto;padding:10px 8px;background:var(--sidebar-bg)}
.main{overflow:auto;padding:24px 28px}
@media(max-width:820px){.body{grid-template-columns:1fr}.sidebar{max-height:38vh}}

/* tree */
.tree{font-family:var(--mono);font-size:12.5px}
.node{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;cursor:pointer;
  border-left:2px solid transparent;color:var(--text);user-select:none}
.node:hover{background:var(--surface-hover)}
.node.sel{background:var(--surface-hover);border-left-color:var(--green)}
.node .tw{width:12px;color:var(--dim);flex:none;text-align:center}
.node .nlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node .count{margin-left:auto;color:var(--dim);font-size:11px}
.node.phase{color:var(--text);font-weight:600}
.node.agent{font-size:12px}
.node.agent .sdot{width:6px;height:6px;border-radius:50%;background:var(--green);flex:none}
.children{margin-left:14px;border-left:1px solid var(--border);padding-left:2px}
.idx{color:var(--dim);font-size:10px;margin-right:2px}
/* inline phase progress + agent metrics in the tree (dense inspector) */
.node .pmeta{margin-left:auto;display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;color:var(--dim);flex:none}
.node .pmeta .run{color:var(--amber)}
.pbar{width:42px;height:4px;border-radius:3px;background:var(--border2);overflow:hidden;position:relative;flex:none}
.pbar>i{position:absolute;left:0;top:0;bottom:0;background:var(--green);border-radius:3px}
.node.agent .ameta{margin-left:auto;display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--dim);flex:none}
.node.agent .ameta .run{color:var(--amber)}

/* main content */
h2.sec{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
  margin:26px 0 10px;font-weight:600;border-bottom:1px solid var(--border);padding-bottom:6px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin:10px 0}
.card.hero{background:var(--hero-bg);border-color:var(--hero-border)}
.crumbs{font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:4px}
.crumbs b{color:var(--text)}
.title-lg{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:2px 0}
.sub{color:var(--muted)}
.grid{display:grid;gap:10px}
.grid.cols2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.grid.cols3{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.phasecard{cursor:pointer;transition:border-color .12s}
.phasecard:hover{border-color:var(--border2)}
.phasecard .pt{font-weight:600;display:flex;align-items:center;gap:8px}
.agentcard{cursor:pointer}
.agentcard:hover{border-color:var(--border2)}
.kv{display:grid;grid-template-columns:minmax(120px,160px) 1fr;gap:6px 16px;align-items:start}
.kv .k{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:none;padding-top:2px}
.kv .v{min-width:0}
.label-mono{font-family:var(--mono)}
.prose{white-space:pre-wrap;word-break:break-word}
/* live streaming output (running agent, partial) */
.streamlabel{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:12px 0 6px}
.streamout{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55;color:var(--text);
  border-left:2px solid var(--amber);padding:1px 0 1px 12px}
.streamcaret{display:inline-block;width:7px;height:13px;margin-left:1px;background:var(--amber);vertical-align:text-bottom;
  animation:wfpulse 1.1s ease-in-out infinite}
ul.clean{margin:4px 0;padding-left:18px}
ul.clean li{margin:3px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-family:var(--mono);font-size:11px;background:var(--tag-bg);border:1px solid var(--border);
  border-radius:5px;padding:2px 8px;color:var(--text)}
.badge{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.swatches{display:flex;flex-wrap:wrap;gap:8px}
.sw{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;color:var(--text);
  border:1px solid var(--border);border-radius:6px;padding:4px 8px;background:var(--sw-bg)}
.sw .chip-color{width:16px;height:16px;border-radius:4px;border:1px solid var(--swatch-border);flex:none}
.tablewrap{border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:62vh;margin:4px 0}
table.t{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
table.t thead th{position:sticky;top:0;z-index:1;background:var(--panel);font-family:var(--mono);font-size:10.5px;
  letter-spacing:.05em;text-transform:uppercase;color:var(--dim);text-align:left;font-weight:600;padding:6px 10px;
  border-bottom:1px solid var(--border2);white-space:nowrap}
table.t td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
table.t tbody tr:last-child td{border-bottom:0}
table.t td.num{font-family:var(--mono);text-align:center;white-space:nowrap}
table.t tbody tr:hover td{background:var(--row-hover)}
.subitems{display:flex;flex-direction:column;gap:0}
.subitem{padding:8px 0;border-top:1px solid var(--border)}
.subitem:first-child{border-top:0;padding-top:2px}
.showall{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface-hover);
  border:1px solid var(--border2);border-radius:6px;padding:5px 10px;cursor:pointer;margin:6px 0 2px}
.showall:hover{color:var(--text);border-color:var(--green)}
.scorepill{display:inline-block;min-width:26px;text-align:center;font-family:var(--mono);font-weight:700;
  font-size:11px;padding:1px 6px;border-radius:5px;color:#06110c}
details.raw{margin-top:14px;border-top:1px solid var(--border);padding-top:10px}
details.raw summary{font-family:var(--mono);font-size:11px;color:var(--muted);cursor:pointer;letter-spacing:.06em;text-transform:uppercase}
pre.json{background:var(--json-bg);border:1px solid var(--border);border-radius:8px;padding:14px;overflow:auto;
  font-family:var(--mono);font-size:11.5px;color:#aeb9c4;margin-top:10px;max-height:60vh}
.muted{color:var(--muted)} .dim{color:var(--dim)}
footer{border-top:1px solid var(--border);padding:8px 20px;font-family:var(--mono);font-size:10.5px;color:var(--dim);
  display:flex;gap:18px;flex-wrap:wrap}
.empty{color:var(--dim);font-style:italic}

/* ── view toggle ─────────────────────────────────────────────────────────── */
.toggles{margin-left:auto;display:flex;gap:10px;align-items:center}
.toggle{display:flex;border:1px solid var(--border2);border-radius:8px;overflow:hidden}
.tg{background:transparent;color:var(--muted);border:0;padding:7px 13px;font-family:var(--mono);font-size:11px;
  cursor:pointer;letter-spacing:.05em;min-height:34px;display:inline-flex;align-items:center}
.tg.on{background:var(--surface-hover);color:var(--green)}
.tg+.tg{border-left:1px solid var(--border2)}

/* ── execution map ───────────────────────────────────────────────────────── */
.mapframe{flex:1;position:relative;overflow:hidden;background:var(--bg);cursor:grab;touch-action:none}
.mapframe.grabbing{cursor:grabbing}
.mapcanvas{position:relative;min-width:max-content;margin:0;padding:48px 64px 88px;display:flex;flex-direction:column;will-change:transform}
.mapctl{position:absolute;right:16px;bottom:16px;display:flex;align-items:center;gap:6px;z-index:5;
  background:var(--panel);border:1px solid var(--border2);border-radius:10px;padding:5px 7px;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.zb{background:transparent;border:1px solid var(--border2);color:var(--text);border-radius:7px;min-width:34px;height:32px;
  cursor:pointer;font-size:14px;font-family:var(--mono);line-height:1;padding:0 9px}
.zb:hover{border-color:var(--green);color:var(--green)}
.zb.fit{font-size:11px}
.zlbl{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:44px;text-align:center}
svg.edges{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
svg.edges path.edge{fill:none;stroke:var(--edge);stroke-width:1.75;stroke-linecap:round;vector-effect:non-scaling-stroke}
svg.edges path.edge.live{stroke:var(--amber);stroke-width:2}
svg.edges path.edge.pending{stroke-dasharray:4 5;opacity:.5}
svg.edges path.arrowhead{fill:var(--arrow)}
.mrow{position:relative;z-index:1;display:grid;grid-template-columns:264px minmax(420px,1fr) 264px;align-items:center}
.mrow.phase{padding:34px 0}
.mrow.orch,.mrow.result{padding:16px 0}
.mgutter.left{padding-right:52px;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.mcenter{grid-column:2;display:flex;flex-direction:column;align-items:center;gap:10px}
.mnodes{grid-column:2;display:grid;grid-template-columns:repeat(auto-fit,168px);justify-content:center;
  align-items:start;gap:18px 20px;max-width:920px;margin:0 auto}
.mnodes .mnode{width:168px;min-width:0}
.plabel{font-family:var(--sans);font-size:14.5px;color:var(--text);font-weight:650;letter-spacing:-.01em;display:flex;gap:8px;align-items:center}
.pidx{color:var(--muted);font-family:var(--mono);font-size:10px;border:1px solid var(--border2);border-radius:5px;padding:1px 6px}
.pdetail{color:var(--muted);font-size:11.5px;max-width:200px;line-height:1.5}
.pcount{color:var(--dim);font-family:var(--mono);font-size:10px;letter-spacing:.04em;margin-top:1px}
.mnode{position:relative;background:var(--panel2);border:1px solid var(--border2);border-radius:12px;padding:14px 22px;
  min-width:146px;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;
  transition:border-color .14s ease,box-shadow .14s ease}
.mnode.agent:hover{border-color:var(--green);box-shadow:0 2px 14px rgba(0,0,0,.28)}
.mnode .mlabel{font-family:var(--sans);font-size:14px;color:var(--text);font-weight:600;letter-spacing:-.005em;
  text-align:center;max-width:184px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mnode .mmodel{font-size:10px !important;padding:1px 7px !important}
.mstats{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--dim);flex-wrap:wrap;justify-content:center}
.mstats .st{color:var(--muted)} .mstats .st.run{color:var(--amber)}
.mnode.more{border-style:dashed;background:transparent}
.mnode.more .mlabel{color:var(--text);font-weight:600}
.mnode.more:hover{border-color:var(--green)} .mnode.more:hover .mlabel{color:var(--green)}
.mnode.more .magg{display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--mono);font-size:10px;color:var(--dim)}
.mnode.more .magg .run{color:var(--amber)}
.mnode.more .maggchips{display:flex;flex-wrap:wrap;gap:3px;justify-content:center}
.mnode.pending{border-style:dashed;background:transparent;cursor:default;opacity:.55}
.mnode.pending .mlabel{color:var(--dim);font-weight:500;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.msdot{width:6px;height:6px;border-radius:50%;background:var(--green);position:absolute;top:12px;right:12px;opacity:.8}
.mnode.endpoint{background:var(--endpoint-bg);border-color:var(--endpoint-border);min-width:176px;padding:17px 28px;cursor:default;gap:4px}
.mnode.endpoint .mlabel{font-family:var(--sans);color:var(--endpoint-text);font-size:15px;font-weight:650;letter-spacing:-.01em}
.mnode.endpoint .mendsub{font-family:var(--sans);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.mnode.result-node{cursor:pointer} .mnode.result-node:hover{border-color:var(--green)}
.mnote{font-family:var(--sans);font-size:12px;color:var(--muted);max-width:360px;text-align:center;line-height:1.5}
.mbar{width:240px;height:2px;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--barrier) 14%,var(--barrier) 86%,transparent);position:relative}
.mbar::after{content:'';position:absolute;left:50%;top:50%;width:9px;height:9px;
  transform:translate(-50%,-50%) rotate(45deg);background:var(--barrier-dot);border:1px solid var(--barrier-dot-border);border-radius:2px}
.mnote-side{position:absolute;left:calc(100% + 18px);top:50%;transform:translateY(-50%);text-align:left;width:172px;line-height:1.4}

/* ── detail drawer ───────────────────────────────────────────────────────── */
.drawer{position:fixed;inset:0;z-index:50}
.drawer-backdrop{position:absolute;inset:0;background:var(--backdrop)}
.drawer-panel{position:absolute;right:0;top:0;height:100%;width:min(600px,94vw);background:var(--panel);
  border-left:1px solid var(--border2);box-shadow:-24px 0 70px rgba(0,0,0,.55);display:flex;flex-direction:column}
/* slide only on a genuine open — NOT when a live reconcile rebuilds the drawer */
.drawer-panel.intro{animation:slidein .18s ease}
@keyframes slidein{from{transform:translateX(24px);opacity:.5}to{transform:none;opacity:1}}
/* Map view: dock the inspector instead of a modal — the graph stays visible and
   pannable behind it. Narrow screens fall back to the modal (backdrop + overlay). */
.drawer.dock{pointer-events:none}
.drawer.dock .drawer-backdrop{display:none}
.drawer.dock .drawer-panel{pointer-events:auto;box-shadow:-20px 0 60px rgba(0,0,0,.42)}
@media(max-width:900px){
  .drawer.dock{pointer-events:auto}
  .drawer.dock .drawer-backdrop{display:block}
}
.mnode.selected{border-color:var(--green);box-shadow:0 0 0 1px var(--green),0 4px 18px rgba(0,0,0,.32)}
/* Fixed top region (title + meta chips) that never scrolls; the body below is the
   sole scroller. (A sticky head here would detach and paint over the body, since
   the panel itself doesn't scroll — the body does.) */
.drawer-top{flex:none;background:var(--panel);border-bottom:1px solid var(--border)}
.drawer-head{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 18px 10px;gap:12px}
.drawer-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:auto;padding:12px 18px 30px}
.xbtn{background:transparent;border:1px solid var(--border2);color:var(--muted);border-radius:7px;width:34px;height:34px;
  cursor:pointer;font-size:13px;flex:none}
.xbtn:hover{color:var(--text);border-color:var(--green)}
`;

// Client app. Keep it dependency-free; build DOM with a tiny h() so all user
// data goes in via text nodes (no HTML injection).
const APP = String.raw`
let RUN = JSON.parse(document.getElementById('run-data').textContent);
// live mode: the watcher writes gen.js/data.js sidecars as the run grows; the
// page polls them and patches the DOM IN PLACE (no reload). LIVE turns that on;
// it flips off once the run settles (result/final), dropping the live strip.
let LIVE = (typeof document!=='undefined') && !!(document.documentElement && document.documentElement.dataset)
  && document.documentElement.dataset.live==='1';
let theme='dark';
const MODEL_PALETTES={
  dark:['#6EE7B7','#60A5FA','#A78BFA','#FBBF24','#22D3EE','#F87171'],
  light:['#047857','#2563eb','#7c3aed','#b45309','#0e7490','#dc2626']};
let modelColor={};
function computeModelColors(){const pal=MODEL_PALETTES[theme]||MODEL_PALETTES.dark;
  modelColor={}; Object.keys(RUN.models).sort().forEach((m,i)=>modelColor[m]=pal[i%pal.length]);}
computeModelColors();
function plural(n,w){return n+' '+w+(n===1?'':'s');}
// metric formatters (per-agent tokens/time the runtime now persists)
function fmtTokens(n){if(n==null)return null;if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1)+'M';if(n>=1e3)return Math.round(n/1e3)+'k';return String(n);}
function fmtMs(ms){if(ms==null)return null;const sec=ms/1000;if(sec<60)return (sec<10?sec.toFixed(1):String(Math.round(sec)))+'s';const t=Math.round(sec);return Math.floor(t/60)+'m'+String(t%60).padStart(2,'0')+'s';}
const hasMetrics=()=>RUN.totals&&RUN.totals.hasMetrics;
// live state: agents merged from the event stream as status:'running'
const isRunning=(a)=>a&&a.status==='running';
const elapsedOf=(a)=>a&&a.startedAt?fmtMs(Date.now()-a.startedAt):null;

// ── precomputed indexes (RUN.agents is fixed for the page's lifetime) ────────
// Built once instead of re-filtering/sorting the whole agent list on every tree,
// map, phase-card, and metric read — cheaper for large runs and the single source
// for phase progress/aggregate stats.
const _agentsByPhase=new Map(), _agentByLabel=new Map();
const _phaseStatsCache=new Map();
function reindex(){
  _agentsByPhase.clear(); _agentByLabel.clear(); _phaseStatsCache.clear();
  RUN.agents.forEach((a)=>{ _agentByLabel.set(a.label,a); const arr=_agentsByPhase.get(a.phase)||[]; arr.push(a); _agentsByPhase.set(a.phase,arr); });
  _agentsByPhase.forEach((arr)=>arr.sort((a,b)=>a.order-b.order));
  computeModelColors();
}
reindex(); // rebuilt on every live data swap (RUN reassigned) so views read fresh
const agentsInPhase=(title)=>_agentsByPhase.get(title)||[];
const agentByLabel=(label)=>_agentByLabel.get(label);
function phaseStats(title){
  if(_phaseStatsCache.has(title)) return _phaseStatsCache.get(title);
  let tokens=0,ms=0,done=0,running=0; const a=agentsInPhase(title);
  a.forEach((x)=>{ tokens+=x.tokens||0; ms+=x.ms||0; if(isRunning(x)) running++; else done++; });
  const s={tokens,ms,total:a.length,done,running}; _phaseStatsCache.set(title,s); return s;
}
function statusChip(a){
  if(isRunning(a)){
    const pill=h('span',{class:'pill run'}, h('span',{class:'dot amber'}), 'running');
    if(a.startedAt) pill.append(' · ', h('span',{'data-elapsed-start':a.startedAt}, elapsedOf(a)||''));
    return pill;
  }
  return h('span',{class:'pill ok'}, h('span',{class:'dot'}),'completed');
}
const phaseTokens=(t)=>phaseStats(t).tokens;
const phaseMs=(t)=>phaseStats(t).ms;

// ── persisted UI state (survives the live reload) ────────────────────────────
// Keyed by journal path so multiple run viewers don't collide. Saved on every
// render + before unload; restored before the first render so a --watch reload
// keeps theme/view/selection/drawer/scroll/zoom instead of resetting them.
const STATE_KEY='cw:view:'+((RUN.sources&&RUN.sources.journal)||RUN.name||'run');
let __restoreScroll=null;
function saveState(){
  try{
    const main=document.querySelector('.main'), side=document.querySelector('.sidebar');
    sessionStorage.setItem(STATE_KEY, JSON.stringify({
      theme, view, sel, collapsed, expandedPhases, drawerAgent, drawerResult,
      mapZoom, mapTx, mapTy, mapUserAdjusted,
      mainScroll: main?main.scrollTop:0, sideScroll: side?side.scrollTop:0,
    }));
  }catch(e){}
}
function loadState(){
  try{
    const s=JSON.parse(sessionStorage.getItem(STATE_KEY)||'null'); if(!s) return;
    if(s.theme) theme=s.theme;
    if(s.view) view=s.view;
    if(s.sel) sel=s.sel;
    if(s.collapsed) Object.assign(collapsed,s.collapsed);
    if(s.expandedPhases) Object.assign(expandedPhases,s.expandedPhases);
    drawerAgent = s.drawerAgent && RUN.agents.some(a=>a.label===s.drawerAgent) ? s.drawerAgent : null;
    drawerResult = !drawerAgent && !!s.drawerResult && RUN.result!==undefined && RUN.result!==null;
    if(typeof s.mapZoom==='number'){ mapZoom=s.mapZoom; mapTx=s.mapTx; mapTy=s.mapTy; mapUserAdjusted=!!s.mapUserAdjusted; }
    __restoreScroll={main:s.mainScroll||0, side:s.sideScroll||0};
  }catch(e){}
}

// ── live tick + state-preserving reload (--watch only) ───────────────────────
let __lastInteract=0;
const noteInteract=()=>{ __lastInteract=Date.now(); };
function tickLive(){
  const now=Date.now();
  // running-agent elapsed clocks tick in place — no page rebuild needed
  document.querySelectorAll('[data-elapsed-start]').forEach(el=>{
    const s=Number(el.getAttribute('data-elapsed-start')); if(s) el.textContent=fmtMs(now-s);
  });
  const wall=document.getElementById('live-wall');
  if(wall && RUN.live && RUN.live.runStartedAt) wall.textContent=fmtMs(now-RUN.live.runStartedAt);
  const since=document.getElementById('live-since'), bar=document.getElementById('livebar');
  if(since && RUN.live && RUN.live.lastEventAt){
    const age=now-RUN.live.lastEventAt; since.textContent=fmtMs(age)+' ago';
    if(bar){ const running=RUN.agents.some(isRunning); bar.classList.toggle('stale', running && age>6000); }
  }
}
// ── no-reload live data channel ──────────────────────────────────────────────
// Poll a tiny gen.js sidecar; when its counter advances, pull data.js and
// reconcile the DOM in place. Classic <script src> injection is used (not fetch)
// because it works on file:// — the protocol the --gui monitor actually opens.
let __lastGen=(RUN&&RUN.gen)||0;
let __syncBusy=false, __syncOk=false, __syncMiss=0, __reloadFallback=false, __suppressMotion=false;
function sideUrl(ext){ // "<base>.<ext>" next to this HTML, derived from our own URL
  const p=(typeof location!=='undefined'&&location.pathname)||'';
  return p.replace(/\.html?$/i,'')+ext+'?v='+Date.now();
}
function injectScript(url,onok,onerr){
  try{
    const s=document.createElement('script'); s.src=url; s.async=true;
    s.onload=()=>{ if(s.remove)s.remove(); onok&&onok(); };
    s.onerror=()=>{ if(s.remove)s.remove(); onerr&&onerr(); };
    (document.head||document.documentElement).appendChild(s);
  }catch(e){ onerr&&onerr(); }
}
// sidecars call these globals:
if(typeof window!=='undefined'){
  window.__wfGen=function(g){ __syncOk=true; __syncMiss=0; if(typeof g==='number'&&g>__lastGen&&!__syncBusy){ __syncBusy=true; injectScript(sideUrl('.data.js'),()=>{__syncBusy=false;},()=>{__syncBusy=false;}); } };
  window.__wfPush=function(g,data){ __syncOk=true; if(typeof g!=='number'||g<=__lastGen||!data) return; __lastGen=g; RUN=data; reindex(); liveReconcile(); if(('result' in data)||data.final) liveSettle(); };
}
function liveSync(){
  if(!LIVE||__reloadFallback) return;
  injectScript(sideUrl('.gen.js'), null, ()=>{ if(!__syncOk && ++__syncMiss>=3){ __reloadFallback=true; scheduleLiveReloadFallback(); } });
}
// in-place reconcile: re-render with the fresh RUN, but suppress motion (no drawer
// re-slide, no map re-home) and preserve scroll — so the update is invisible.
function liveReconcile(){
  const m=document.querySelector('.main'), sb=document.querySelector('.sidebar'), db=document.querySelector('.drawer-body');
  __restoreScroll={ main:m?m.scrollTop:0, side:sb?sb.scrollTop:0, drawer:db?db.scrollTop:0 };
  __suppressMotion=true;
  try{ render(); } finally { __suppressMotion=false; }
}
// run finished: stop polling, drop the live strip / running styling.
function liveSettle(){
  if(!LIVE) return; LIVE=false; __reloadFallback=false;
  if(typeof window!=='undefined' && window.__wfSync){ clearInterval(window.__wfSync); window.__wfSync=null; }
  if(typeof window!=='undefined' && window.__wfTick){ clearInterval(window.__wfTick); window.__wfTick=null; }
  __suppressMotion=true; try{ render(); } finally { __suppressMotion=false; }
}
// last-resort fallback if the sidecar scripts can't load (some locked-down setup):
// the old state-preserving reload loop, so live still works — just less smoothly.
function scheduleLiveReloadFallback(){
  if(typeof window==='undefined'||window.__wfReload) return;
  console&&console.warn&&console.warn('codex-workflows: live sidecars unavailable — falling back to reload');
  window.__wfReload=setInterval(()=>{
    if(!LIVE) return;
    if(panning||(Date.now()-__lastInteract)<1600) return;
    saveState(); location.reload();
  }, 2400);
}

function h(tag, props, ...kids){
  const e=document.createElement(tag);
  if(props) for(const k in props){
    const v=props[k]; if(v==null) continue;
    if(k==='class') e.className=v;
    else if(k==='style'&&typeof v==='object') Object.assign(e.style,v);
    else if(k.slice(0,2)==='on') e.addEventListener(k.slice(2).toLowerCase(),v);
    else e.setAttribute(k,v);
  }
  for(let kid of kids.flat()){ if(kid==null||kid===false) continue;
    e.append(kid.nodeType?kid:document.createTextNode(String(kid))); }
  return e;
}
const finalAgent = ()=>{
  const last=RUN.phases[RUN.phases.length-1];
  const inLast=last?agentsInPhase(last.title):[];
  return RUN.agents.find(a=>a.result&&(a.result.recommended_direction||a.result.recommendation))
    || (inLast.length===1?inLast[0]:null);
};

let sel={type:'run'};
const selKey=(s)=> s.type==='run'?'run':s.type+':'+s.id;
const expandedPhases={}; // map phase title → true when its collapsed agents are expanded inline

// ── sidebar tree ───────────────────────────────────────────────────────────
const collapsed={};
function buildTree(){
  const t=h('div',{class:'tree'});
  t.append(node({type:'run'},'▸','◆ '+RUN.name,RUN.counts.agents,'',false));
  RUN.phases.forEach((p,pi)=>{
    const kids=agentsInPhase(p.title);
    const st=phaseStats(p.title);
    const isCol=collapsed[p.title];
    const pn=node({type:'phase',id:p.title},isCol?'▸':'▾',p.title,null,'phase',true,pi+1);
    pn.append(phaseTreeMeta(st));
    t.append(pn);
    if(!isCol){
      const wrap=h('div',{class:'children'});
      kids.forEach(a=>{
        const lbl=a.label.includes(':')?a.label.split(':').slice(1).join(':')||a.label:a.label;
        const n=node({type:'agent',id:a.label},'',lbl,null,'agent',false,null,isRunning(a));
        n.append(agentTreeMeta(a));
        wrap.append(n);
      });
      t.append(wrap);
    }
  });
  return t;
}
// inline phase progress: running count, done/total, a progress bar
function phaseTreeMeta(st){
  const m=h('span',{class:'pmeta'});
  if(st.running) m.append(h('span',{class:'run'},'●'+st.running));
  m.append(h('span',{},st.done+'/'+st.total));
  const frac=st.total?st.done/st.total:0;
  m.append(h('span',{class:'pbar'}, h('i',{style:{width:Math.round(frac*100)+'%'}})));
  return m;
}
// inline agent metrics: elapsed (running, ticks) or time, tokens, model
function agentTreeMeta(a){
  const m=h('span',{class:'ameta'});
  if(isRunning(a)){ m.append(h('span',{class:'run'}, a.startedAt?h('span',{'data-elapsed-start':a.startedAt},elapsedOf(a)||'…'):'running')); }
  else if(a.ms!=null){ m.append(h('span',{},fmtMs(a.ms))); }
  if(a.tokens!=null) m.append(h('span',{},fmtTokens(a.tokens)));
  if(a.model) m.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55',padding:'0 6px',fontSize:'10px'}},a.model.replace('gpt-','')));
  return m;
}
function node(target,twig,labelText,count,cls,isPhase,idx,running){
  const toggle=()=>{ collapsed[target.id]=!collapsed[target.id]; render(); };
  const n=h('div',{class:'node '+(cls||'')+(selKey(sel)===selKey(target)?' sel':''),
    role:'button', tabindex:'0',
    onclick:(ev)=>{ if(isPhase && ev.target.classList.contains('tw')){toggle();return;} select(target); },
    onkeydown:(ev)=>{
      if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); select(target); }
      else if(isPhase&&ev.key==='ArrowLeft'){ ev.preventDefault(); if(!collapsed[target.id]) toggle(); }
      else if(isPhase&&ev.key==='ArrowRight'){ ev.preventDefault(); if(collapsed[target.id]) toggle(); }
    }});
  n.append(h('span',{class:'tw',onclick:isPhase?(ev)=>{ev.stopPropagation();toggle();}:null},twig||''));
  if(cls==='agent') n.append(h('span',{class:'sdot'+(running?' amber':'')}));
  if(idx) n.append(h('span',{class:'idx'},idx));
  n.append(h('span',{class:'nlabel'},labelText));
  if(count!=null) n.append(h('span',{class:'count'},count));
  return n;
}
function select(t){ sel=t; render(); const m=document.querySelector('.main'); if(m)m.scrollTop=0; }

// ── value renderer (generic + heuristics) ───────────────────────────────────
const isHex=(s)=>/^#?[0-9a-fA-F]{3,8}\b/.test(String(s).trim());
const SCORE_KEYS=/^(commercial_appeal|differentiation|feasibility|brand|score|rating|appeal)$/i;

function badge(text,color){ return h('span',{class:'badge',style:{color:'#06110c',background:color}},text); }
function sevColor(v){v=String(v).toLowerCase();return v==='high'?'#F87171':v==='medium'?'#FBBF24':v==='low'?'#9aa6b2':'#9aa6b2';}
function effColor(v){v=String(v).toUpperCase();return v==='S'?'#6EE7B7':v==='M'?'#FBBF24':v==='L'?'#F87171':'#9aa6b2';}
function scoreColor(n){const v=Math.max(1,Math.min(10,Number(n)||0));const hue=Math.round((v-1)/9*125);return 'hsl('+hue+',58%,55%)';}

function swatch(s){
  const str=String(s).trim();
  const m=str.match(/(#[0-9a-fA-F]{3,8})/);
  const color=m?m[1]:(/^[a-z]+$/i.test(str.split(/\s|—|-/)[0])?str.split(/\s|—|-/)[0]:null);
  return h('span',{class:'sw'}, h('span',{class:'chip-color',style:{background:color||'#333'}}), str);
}

function renderValue(value,key){
  if(value==null||value==='') return h('span',{class:'empty'},'—');
  if(typeof value==='number'||typeof value==='boolean') return h('span',{class:'label-mono'},String(value));
  if(typeof value==='string'){
    if(key&&/^severity$/i.test(key)) return badge(value,sevColor(value));
    if(key&&/^effort$/i.test(key)&&/^[SML]$/i.test(value.trim())) return badge(value,effColor(value));
    return h('div',{class:'prose'},value);
  }
  if(Array.isArray(value)){
    if(value.length===0) return h('span',{class:'empty'},'—');
    const allStr=value.every(v=>typeof v==='string'||typeof v==='number');
    if(allStr){
      if((key&&/palette|colors|swatch/i.test(key)) || value.every(v=>isHex(v))){
        return h('div',{class:'swatches'},value.map(swatch));
      }
      const short=value.every(v=>String(v).length<=24);
      if(short) return h('div',{class:'chips'},value.map(v=>h('span',{class:'tag'},v)));
      return h('ul',{class:'clean'},value.map(v=>h('li',{},renderValue(v))));
    }
    if(value.every(v=>v&&typeof v==='object'&&!Array.isArray(v))) return renderTable(value);
    return h('div',{class:'subitems'},value.map(v=>h('div',{class:'subitem'},renderValue(v))));
  }
  // object
  return renderObject(value);
}

function renderObject(obj){
  const kv=h('div',{class:'kv'});
  for(const k of Object.keys(obj)){
    kv.append(h('div',{class:'k'},k));
    kv.append(h('div',{class:'v'},renderValue(obj[k],k)));
  }
  return kv;
}

const TABLE_CAP=100; // initial rows; the rest reveal behind "Show all"
function renderTable(rows){
  const cols=[]; rows.forEach(r=>Object.keys(r).forEach(k=>{if(!cols.includes(k))cols.push(k);}));
  // keep big text columns out of the table; render them under each row instead
  const longCols=cols.filter(c=>rows.some(r=>typeof r[c]==='string'&&r[c].length>90));
  const tblCols=cols.filter(c=>!longCols.includes(c));
  const wrap=h('div',{});
  const tw=h('div',{class:'tablewrap'});
  const t=h('table',{class:'t'});
  t.append(h('thead',{}, h('tr',{},tblCols.map(c=>h('th',{scope:'col'},c)))));
  const tbody=h('tbody',{});
  t.append(tbody);
  const addRow=(r)=>{
    const tr=h('tr',{});
    tblCols.forEach(c=>{
      const v=r[c];
      if(v!=null&&SCORE_KEYS.test(c)&&typeof v==='number'){
        tr.append(h('td',{class:'num'},h('span',{class:'scorepill',style:{background:scoreColor(v)}},String(v))));
      } else if(c.toLowerCase()==='severity'&&v){ tr.append(h('td',{},badge(v,sevColor(v)))); }
      else if(c.toLowerCase()==='effort'&&/^[SML]$/i.test(String(v||'').trim())){ tr.append(h('td',{},badge(v,effColor(v)))); }
      else if(typeof v==='number'){ tr.append(h('td',{class:'num'},String(v))); }
      else { tr.append(h('td',{},renderValue(v,c))); }
    });
    tbody.append(tr);
    if(longCols.length){
      const tr2=h('tr',{});
      const td=h('td',{colspan:tblCols.length,style:{paddingTop:'2px',paddingBottom:'12px'}});
      longCols.forEach(c=>{ if(r[c]!=null&&r[c]!==''){ td.append(h('div',{class:'k',style:{marginTop:'4px'}},c)); td.append(h('div',{class:'prose'},String(r[c]))); }});
      tr2.append(td); tbody.append(tr2);
    }
  };
  rows.slice(0,TABLE_CAP).forEach(addRow);
  tw.append(t); wrap.append(tw);
  if(rows.length>TABLE_CAP){
    const btn=h('button',{class:'showall'},'Show all '+rows.length+' rows');
    btn.addEventListener('click',()=>{ rows.slice(TABLE_CAP).forEach(addRow); btn.remove(); });
    wrap.append(btn);
  }
  return wrap;
}

// running agent with no result yet — show its streaming output if the runner is
// capturing it, else a pending skeleton instead of "(no result)".
function pendingResult(a){
  const c=h('div',{class:'card'});
  const row=h('div',{class:'metarow'});
  row.append(statusChip(a));
  if(a.model) row.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
  if(a.effort) row.append(h('span',{class:'pill'},'effort · '+a.effort));
  row.append(h('span',{class:'pill'},'phase · '+a.phase));
  c.append(row);
  if(a.progress){
    // live partial output — the agent is mid-stream. Shown verbatim; updates in place.
    c.append(h('div',{class:'streamlabel'},'streaming output'));
    c.append(h('div',{class:'streamout'}, a.progress, h('span',{class:'streamcaret'})));
  } else {
    c.append(h('div',{class:'prose muted',style:{marginTop:'10px'}},'Running — waiting for this agent’s first output…'));
  }
  return c;
}

// one-line summary of an agent result, for cards/sidebar
function summarize(r){
  if(!r||typeof r!=='object') return '';
  return r.one_line_verdict||r.tagline||r.recommended_direction||r.top_pick||
    (r.hero&&r.hero.headline)||r.headline||r.positioning_statement||
    (Object.values(r).find(v=>typeof v==='string'&&v.length>8))||'';
}

// ── main panes ───────────────────────────────────────────────────────────
function renderMain(){
  if(sel.type==='run') return renderRun();
  if(sel.type==='phase') return renderPhase(RUN.phases.find(p=>p.title===sel.id));
  if(sel.type==='agent') return renderAgent(agentByLabel(sel.id));
  return h('div',{});
}

function renderRun(){
  const m=h('div',{});
  if(RUN.description) m.append(h('div',{class:'sub',style:{maxWidth:'90ch',marginBottom:'4px'}},RUN.description));
  if(hasResult()){
    // the workflow's actual return value — rendered inline, no guessing
    m.append(h('h2',{class:'sec'},'Result'));
    const r=RUN.result;
    m.append(h('div',{class:'card hero'}, (r&&typeof r==='object')?renderValue(r):h('div',{class:'prose'},String(r))));
  } else {
    const fa=finalAgent();
    if(fa&&fa.result){
      const r=fa.result;
      m.append(h('h2',{class:'sec'},'Outcome'));
      const hero=h('div',{class:'card hero'});
      if(r.recommended_direction) hero.append(h('div',{class:'title-lg'},r.recommended_direction));
      if(r.hero&&r.hero.headline){ hero.append(h('div',{style:{fontSize:'16px',fontWeight:600,marginTop:'4px'}},r.hero.headline));
        if(r.hero.subhead) hero.append(h('div',{class:'sub'},r.hero.subhead)); }
      if(r.why_this_wins) hero.append(h('div',{class:'prose',style:{marginTop:'10px'}},r.why_this_wins));
      hero.append(h('div',{style:{marginTop:'10px'}}, h('a',{href:'#',onclick:(e)=>{e.preventDefault();select({type:'agent',id:fa.label});}}, 'Open full result → '+fa.label)));
      m.append(hero);
    }
  }
  // phases
  m.append(h('h2',{class:'sec'},'Phases'));
  const g=h('div',{class:'grid cols2'});
  RUN.phases.forEach((p,i)=>{
    const kids=agentsInPhase(p.title);
    const c=h('div',{class:'card phasecard',onclick:()=>select({type:'phase',id:p.title})});
    c.append(h('div',{class:'pt'}, h('span',{class:'idx'},(i+1)), p.title, h('span',{class:'count',style:{marginLeft:'auto'}},kids.length+' agent'+(kids.length===1?'':'s'))));
    if(p.detail) c.append(h('div',{class:'sub',style:{marginTop:'4px'}},p.detail));
    const mods={}; kids.forEach(a=>{if(a.model)mods[a.model]=(mods[a.model]||0)+1;});
    if(Object.keys(mods).length) c.append(h('div',{class:'chips',style:{marginTop:'8px'}},
      Object.entries(mods).map(([mm,ct])=>h('span',{class:'chip',style:{color:modelColor[mm],borderColor:modelColor[mm]+'55'}},mm+(ct>1?' ×'+ct:'')))));
    if(hasMetrics()){const pt=phaseTokens(p.title),pm=phaseMs(p.title);const parts=[pt?fmtTokens(pt)+' tokens':null,pm?fmtMs(pm)+' agent-time':null].filter(Boolean);
      if(parts.length) c.append(h('div',{style:{marginTop:'8px',fontFamily:'var(--mono)',fontSize:'11px',color:'var(--dim)'}},parts.join('   ·   ')));}
    g.append(c);
  });
  m.append(g);
  // costliest agents — a quick cost lens over the run (when per-agent metrics exist)
  if(hasMetrics()){
    const costly=RUN.agents.filter(a=>a.tokens!=null).sort((a,b)=>b.tokens-a.tokens).slice(0,3);
    if(costly.length){
      m.append(h('h2',{class:'sec'},'Costliest agents'));
      const cg=h('div',{class:'card'});
      costly.forEach(a=>{
        const row=h('div',{class:'metarow',style:{cursor:'pointer'},onclick:()=>select({type:'agent',id:a.label})});
        row.append(h('span',{class:'pill'},fmtTokens(a.tokens)+' tok'));
        if(a.ms!=null) row.append(h('span',{class:'pill'},fmtMs(a.ms)));
        row.append(h('span',{class:'label-mono',style:{fontWeight:600}},a.label));
        if(a.model) row.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
        cg.append(row);
      });
      m.append(cg);
    }
  }
  // run meta
  m.append(h('h2',{class:'sec'},'Run'));
  const meta=h('div',{class:'card'});
  const kv=h('div',{class:'kv'});
  const addkv=(k,v)=>{kv.append(h('div',{class:'k'},k));kv.append(h('div',{class:'v'},v));};
  addkv('agents',String(RUN.counts.agents));
  addkv('phases',String(RUN.counts.phases));
  if(hasMetrics()){
    if(RUN.totals.tokens) addkv('tokens',fmtTokens(RUN.totals.tokens)+'  ('+RUN.totals.tokens.toLocaleString()+')');
    if(RUN.totals.ms) addkv('agent-time',fmtMs(RUN.totals.ms)+'  (sum of per-agent durations, not wall-clock)');
  }
  if(Object.keys(RUN.models).length) addkv('models',h('div',{class:'chips'},Object.entries(RUN.models).map(([mm,ct])=>h('span',{class:'chip',style:{color:modelColor[mm],borderColor:modelColor[mm]+'55'}},mm+' ×'+ct))));
  // effort breakdown (mirrors the summarize-run report; surfaces default-effort cost)
  const efforts={}; RUN.agents.forEach(a=>{const e=a.effort||'default';efforts[e]=(efforts[e]||0)+1;});
  const effKeys=Object.keys(efforts);
  if(effKeys.length&&!(effKeys.length===1&&effKeys[0]==='default'&&!hasMetrics())) addkv('effort',h('div',{class:'chips'},effKeys.map(e=>h('span',{class:'pill'},e+' ×'+efforts[e]))));
  meta.append(kv);
  m.append(meta);
  return m;
}

function renderPhase(p){
  if(!p) return h('div',{});
  const m=h('div',{});
  m.append(h('div',{class:'crumbs'}, h('a',{href:'#',onclick:(e)=>{e.preventDefault();select({type:'run'});}},RUN.name),' / ',h('b',{},p.title)));
  m.append(h('div',{class:'title-lg'},p.title));
  if(p.detail) m.append(h('div',{class:'sub'},p.detail));
  m.append(h('h2',{class:'sec'},'Agents'));
  agentsInPhase(p.title).forEach(a=>{
    const c=h('div',{class:'card agentcard',onclick:()=>select({type:'agent',id:a.label})});
    const top=h('div',{style:{display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap'}});
    top.append(h('span',{class:'label-mono',style:{fontWeight:600}},a.label));
    if(a.model) top.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
    if(a.effort) top.append(h('span',{class:'pill'},'effort '+a.effort));
    if(a.tokens!=null) top.append(h('span',{class:'pill'},fmtTokens(a.tokens)+' tok'));
    if(a.ms!=null) top.append(h('span',{class:'pill'},fmtMs(a.ms)));
    top.append(statusChip(a));
    c.append(top);
    const s=summarize(a.result); if(s) c.append(h('div',{class:'prose',style:{marginTop:'8px',color:'var(--muted)'}},s));
    m.append(c);
  });
  return m;
}

function renderAgent(a){
  if(!a) return h('div',{});
  const m=h('div',{});
  m.append(h('div',{class:'crumbs'}, h('a',{href:'#',onclick:(e)=>{e.preventDefault();select({type:'run'});}},RUN.name),' / ',
    h('a',{href:'#',onclick:(e)=>{e.preventDefault();select({type:'phase',id:a.phase});}},a.phase),' / ',h('b',{},a.label)));
  m.append(h('div',{class:'title-lg'},a.label));
  const chips=h('div',{class:'metarow'});
  chips.append(h('span',{class:'pill'},'phase · '+a.phase));
  if(a.model) chips.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
  if(a.effort) chips.append(h('span',{class:'pill'},'effort · '+a.effort));
  if(a.tokens!=null) chips.append(h('span',{class:'pill'},'tokens · '+fmtTokens(a.tokens)));
  if(a.ms!=null) chips.append(h('span',{class:'pill'},'time · '+fmtMs(a.ms)));
  chips.append(statusChip(a));
  m.append(chips);
  m.append(h('h2',{class:'sec'},'Result'));
  if(isRunning(a) && a.result==null){
    m.append(pendingResult(a));
    return m; // no raw-json block for an agent that hasn't produced output yet
  }
  if(a.result&&typeof a.result==='object'){
    m.append(h('div',{class:'card'},renderValue(a.result)));
  } else {
    m.append(h('div',{class:'card'},h('div',{class:'prose'},a.result==null?'(no result)':String(a.result))));
  }
  const det=h('details',{class:'raw'});
  det.append(h('summary',{},'raw json'));
  det.append(h('pre',{class:'json'},JSON.stringify(a.result,null,2)));
  m.append(det);
  return m;
}

// ── view toggle, execution map, drawer, frame ───────────────────────────────
let view='map', drawerAgent=null, drawerResult=false;
const hasResult=()=>RUN.result!==undefined && RUN.result!==null;
let mapZoom=1, mapTx=0, mapTy=0, mapUserAdjusted=false, panning=false;
let mapEls={orch:null,result:null,phases:[],barriers:[]};
let edgePaths=[];
const SVGNS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs){const e=document.createElementNS(SVGNS,tag);if(attrs)for(const k in attrs)e.setAttribute(k,attrs[k]);return e;}

function renderHeader(){
  const head=h('header',{});
  head.append(h('div',{class:'brandrow'},
    h('span',{class:'brand'},'codex·workflows / run viewer'),
    h('span',{class:'runname'},RUN.name),
    h('div',{class:'toggles'},
      h('div',{class:'toggle'},
        h('button',{class:'tg'+(view==='map'?' on':''),onclick:()=>{view='map';render();}},'◇ Map'),
        h('button',{class:'tg'+(view==='tree'?' on':''),onclick:()=>{view='tree';drawerAgent=null;render();}},'☰ Tree')),
      h('div',{class:'toggle'},
        h('button',{class:'tg'+(theme==='dark'?' on':''),onclick:()=>{theme='dark';render();}},'● Dark'),
        h('button',{class:'tg'+(theme==='light'?' on':''),onclick:()=>{theme='light';render();}},'○ Light')))));
  if(RUN.description) head.append(h('div',{class:'desc'},RUN.description));
  const meta=h('div',{class:'metarow'});
  const nDone=RUN.agents.filter(a=>!isRunning(a)).length, nRun=RUN.agents.length-nDone;
  meta.append(nRun
    ? h('span',{class:'pill run'}, h('span',{class:'dot amber'}), nDone+'/'+RUN.agents.length+' done · '+nRun+' running')
    : h('span',{class:'pill ok'}, h('span',{class:'dot'}), nDone+'/'+RUN.agents.length+' completed'));
  meta.append(h('span',{class:'pill'},plural(RUN.counts.phases,'phase')));
  meta.append(h('span',{class:'pill'},plural(RUN.counts.agents,'agent')));
  if(hasMetrics()){
    if(RUN.totals.tokens) meta.append(h('span',{class:'pill'},fmtTokens(RUN.totals.tokens)+' tokens'));
    if(RUN.totals.ms) meta.append(h('span',{class:'pill'},fmtMs(RUN.totals.ms)+' agent-time'));
  }
  Object.entries(RUN.models).forEach(([mm,ct])=>meta.append(h('span',{class:'chip',style:{color:modelColor[mm],borderColor:modelColor[mm]+'55'}},mm+' ×'+ct)));
  head.append(meta);
  // live status strip: wall-clock, last-update age (stale flag), running count —
  // only while the run is live or still has in-flight agents.
  const nRunning=RUN.agents.filter(isRunning).length;
  if(LIVE || nRunning){
    const lb=h('div',{class:'livebar',id:'livebar'});
    lb.append(h('span',{style:{display:'inline-flex',alignItems:'center',gap:'6px'}},
      h('span',{class:'livedot'}), h('span',{style:{color:'var(--amber)',fontWeight:700,letterSpacing:'.08em'}}, LIVE?'LIVE':'RUNNING')));
    if(RUN.live && RUN.live.runStartedAt)
      lb.append(h('span',{}, h('span',{class:'lk'},'elapsed'), h('span',{class:'lv',id:'live-wall'}, fmtMs(Date.now()-RUN.live.runStartedAt)||'—')));
    if(RUN.live && RUN.live.lastEventAt)
      lb.append(h('span',{class:'stale-flag'}, h('span',{class:'lk'},'updated'), h('span',{class:'lv',id:'live-since'}, fmtMs(Date.now()-RUN.live.lastEventAt)+' ago')));
    lb.append(h('span',{}, h('span',{class:'lk'},'running'), h('span',{class:'lv'}, String(nRunning))));
    if(LIVE) lb.append(h('span',{class:'lk',style:{marginLeft:'auto'}},'auto-refresh on'));
    head.append(lb);
  }
  return head;
}
function renderFooter(){
  const f=h('footer',{});
  f.append(h('span',{},'journal: '+RUN.sources.journal));
  if(RUN.sources.script) f.append(h('span',{},'script: '+RUN.sources.script));
  f.append(h('span',{},'generated '+RUN.generatedAt));
  return f;
}

// map nodes / rows
function agentNode(a){
  const run=isRunning(a), el=elapsedOf(a);
  const tip=(a.model?'['+a.model+(a.effort?' · '+a.effort:'')+'] ':'')+(run?('running'+(el?' '+el:'')+' · '):(a.tokens!=null?fmtTokens(a.tokens)+' tok · ':''))+(summarize(a.result)||a.label);
  const open=()=>openDrawer(a.label);
  const n=h('div',{class:'mnode agent'+(run?' running':'')+(drawerAgent===a.label?' selected':''),title:tip,role:'button',tabindex:'0',
    'aria-label':'Agent '+a.label+(run?', running':', completed')+(a.ms!=null?', '+fmtMs(a.ms):''),
    onclick:open, onkeydown:(e)=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();open();} }});
  n.append(h('span',{class:'msdot'+(run?' amber':'')}));
  n.append(h('span',{class:'mlabel'}, a.label.includes(':')?a.label.split(':').slice(1).join(':'):a.label));
  if(a.model) n.append(h('span',{class:'chip mmodel',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model.replace('gpt-','')));
  // node footer: live elapsed (ticks) for running, else time + tokens
  const stats=h('div',{class:'mstats'}); let hasStat=false;
  if(run){ stats.append(h('span',{class:'st run'}, a.startedAt?h('span',{'data-elapsed-start':a.startedAt}, el||'…'):'running')); hasStat=true; }
  else {
    if(a.ms!=null){ stats.append(h('span',{class:'st'},fmtMs(a.ms))); hasStat=true; }
    if(a.tokens!=null){ stats.append(h('span',{},fmtTokens(a.tokens))); hasStat=true; }
  }
  if(hasStat) n.append(stats);
  return n;
}
function orchRow(){
  const node=h('div',{class:'mnode endpoint orch-node'}, h('span',{class:'mlabel'},RUN.name), h('span',{class:'mendsub'},'orchestrator'),
    h('div',{class:'mnote mnote-side'},'kicks off '+plural(RUN.counts.agents,'agent')+' across '+plural(RUN.counts.phases,'phase')));
  mapEls.orch=node;
  return h('div',{class:'mrow orch'}, h('div',{class:'mgutter'}), h('div',{class:'mcenter'}, node), h('div',{class:'mgutter'}));
}
const MAP_CAP=12; // collapse a phase's agent row beyond this many nodes
function phaseRow(p,i){
  const all=agentsInPhase(p.title);
  const st=phaseStats(p.title);
  const expanded=expandedPhases[p.title];
  // running-aware visible set: never fold an in-flight agent into the aggregate.
  // Show running first, then earliest by order up to the cap; the rest collapse.
  let visible=all, hidden=[];
  if(all.length>MAP_CAP && !expanded){
    const slots=Math.max(1, MAP_CAP-1);
    const pick=new Set(all.filter(isRunning).map(a=>a.label));
    for(const a of all){ if(pick.size>=slots) break; pick.add(a.label); }
    visible=all.filter(a=>pick.has(a.label));
    hidden=all.filter(a=>!pick.has(a.label));
  }
  // a phase whose agents haven't started yet (live runs reach it later): its width
  // isn't known until the run gets there (dynamic workflows size it at runtime), so
  // show the phase as "pending" rather than a misleading "0 parallel".
  const pending = all.length === 0;
  const gut=h('div',{class:'mgutter left'},
    h('div',{class:'plabel'}, h('span',{class:'pidx'},(i+1)), p.title),
    p.detail?h('div',{class:'pdetail'},p.detail):null,
    h('div',{class:'pcount'}, pending ? 'pending' : st.running ? st.done+'/'+st.total+' done · '+st.running+' running' : all.length+(all.length===1?' agent':' parallel')));
  if(hasMetrics()){const parts=[st.tokens?fmtTokens(st.tokens)+' tok':null,st.ms?fmtMs(st.ms):null].filter(Boolean);
    if(parts.length) gut.append(h('div',{class:'pcount'},parts.join(' · ')));}
  const nodes=h('div',{class:'mnodes'}); const els=[];
  visible.forEach(a=>{const n=agentNode(a); els.push(n); nodes.append(n);});
  if(pending){
    // placeholder so the plan's shape is visible (and edges flow through) before
    // this phase starts; the real agent nodes replace it when they spawn.
    const pend=h('div',{class:'mnode pending','aria-label':p.title+' — pending'}, h('span',{class:'mlabel'},'pending'));
    els.push(pend); nodes.append(pend);
  }
  if(hidden.length){
    // aggregate bucket (not a fake agent): hidden count + running + tokens + model mix
    const hidRunning=hidden.filter(isRunning).length;
    const hidTokens=hidden.reduce((s,a)=>s+(a.tokens||0),0);
    const mods={}; hidden.forEach(a=>{if(a.model)mods[a.model]=(mods[a.model]||0)+1;});
    const expand=()=>{ expandedPhases[p.title]=true; render(); };
    const agg=h('div',{class:'mnode more',role:'button',tabindex:'0',title:'show '+hidden.length+' more agents in '+p.title,
      'aria-label':hidden.length+' more agents in '+p.title+(hidRunning?', '+hidRunning+' running':'')+'. Activate to expand.',
      onclick:expand, onkeydown:(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();expand();}}},
      h('span',{class:'mlabel'},'+ '+hidden.length+' more'));
    const info=h('div',{class:'magg'});
    if(hidRunning) info.append(h('span',{class:'run'},hidRunning+' running'));
    if(hidTokens) info.append(h('span',{},fmtTokens(hidTokens)+' tok'));
    if(Object.keys(mods).length){ const chips=h('div',{class:'maggchips'});
      Object.entries(mods).forEach(([mm,ct])=>chips.append(h('span',{class:'chip mmodel',style:{color:modelColor[mm],borderColor:modelColor[mm]+'55'}},mm.replace('gpt-','')+(ct>1?'×'+ct:''))));
      info.append(chips); }
    agg.append(info);
    els.push(agg); nodes.append(agg);
  } else if(expanded && all.length>MAP_CAP){
    const collapse=()=>{ expandedPhases[p.title]=false; render(); };
    const agg=h('div',{class:'mnode more',role:'button',tabindex:'0',title:'collapse '+p.title,'aria-label':'Collapse '+p.title,
      onclick:collapse, onkeydown:(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();collapse();}}},
      h('span',{class:'mlabel'},'− collapse'));
    els.push(agg); nodes.append(agg);
  }
  mapEls.phases.push(els);
  return h('div',{class:'mrow phase'}, gut, nodes, h('div',{class:'mgutter'}));
}
function barrierRow(k){
  const bar=h('div',{class:'mbar',title:'barrier — all of “'+RUN.phases[k].title+'” complete before “'+RUN.phases[k+1].title+'”'});
  mapEls.barriers.push(bar);
  return h('div',{class:'mrow barrier'}, h('div',{class:'mgutter'}), h('div',{class:'mcenter'},bar), h('div',{class:'mgutter'}));
}
function resultRow(){
  // Prefer the workflow's actual persisted return value; fall back to the
  // heuristic "final agent" only when no result was persisted (older/live runs).
  let open=null, sub='returns when done', note=null;
  if(hasResult()){
    open=openResultDrawer; sub='workflow output';
    const snip=summarize(RUN.result)||(typeof RUN.result==='string'?RUN.result:null);
    if(snip) note=h('div',{class:'mnote'}, String(snip).slice(0,240));
  } else {
    const fa=finalAgent();
    if(fa){ open=()=>openDrawer(fa.label); sub='final agent';
      if(fa.result&&fa.result.recommended_direction) note=h('div',{class:'mnote'},fa.result.recommended_direction); }
  }
  const node=h('div',{class:'mnode endpoint result-node'+(drawerResult?' selected':''),role:open?'button':null,tabindex:open?'0':null,
    'aria-label':open?'Workflow result':null,onclick:open,
    onkeydown:open?(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}}:null},
    h('span',{class:'mlabel'},'result'), h('span',{class:'mendsub'},sub));
  mapEls.result=node;
  return h('div',{class:'mrow result'}, h('div',{class:'mgutter'}), h('div',{class:'mcenter'},node,note), h('div',{class:'mgutter'}));
}
function renderMapFrame(){
  mapEls={orch:null,result:null,phases:[],barriers:[]}; edgePaths=[];
  const frame=h('div',{class:'mapframe',id:'mapframe'});
  const canvas=h('div',{class:'mapcanvas',id:'mapcanvas'});
  const svg=svgEl('svg',{id:'map-edges',class:'edges'});
  const defs=svgEl('defs',{});
  const marker=svgEl('marker',{id:'arrow',viewBox:'0 0 10 10',refX:'8.5',refY:'5',markerWidth:'8',markerHeight:'8','orient':'auto-start-reverse'});
  marker.append(svgEl('path',{class:'arrowhead',d:'M0 0 L10 5 L0 10 z'}));
  defs.append(marker); svg.append(defs); canvas.append(svg);
  canvas.append(orchRow());
  RUN.phases.forEach((p,i)=>{ canvas.append(phaseRow(p,i)); if(i<RUN.phases.length-1) canvas.append(barrierRow(i)); });
  canvas.append(resultRow());
  frame.append(canvas);
  // zoom / pan controls
  frame.append(h('div',{class:'mapctl'},
    h('button',{class:'zb',title:'Zoom out',onclick:(e)=>{e.stopPropagation();zoomAt(0.83);}},'−'),
    h('span',{class:'zlbl',id:'zoomlbl'},Math.round(mapZoom*100)+'%'),
    h('button',{class:'zb',title:'Zoom in',onclick:(e)=>{e.stopPropagation();zoomAt(1.2);}},'+'),
    h('button',{class:'zb fit',title:'Fit & center  (F)',onclick:(e)=>{e.stopPropagation();fitMap();}},'⤢ Fit')));
  // wheel zoom toward cursor; drag empty space to pan. Bail when the wheel is over
  // the inspector or controls so they scroll normally (don't hijack it to zoom).
  frame.addEventListener('wheel',(e)=>{
    if(e.target&&e.target.closest&&e.target.closest('.drawer,.mapctl')) return;
    e.preventDefault(); noteInteract(); const vp=frame.getBoundingClientRect();
    zoomAt(e.deltaY<0?1.12:0.89, e.clientX-vp.left, e.clientY-vp.top); }, {passive:false});
  frame.addEventListener('pointerdown',(e)=>{
    if(e.target&&e.target.closest&&e.target.closest('.mnode,.mapctl,.drawer')) return;
    noteInteract();
    panning=true; const sx=e.clientX, sy=e.clientY, stx=mapTx, sty=mapTy; frame.className='mapframe grabbing';
    const mv=(ev)=>{ if(!panning)return; mapTx=stx+(ev.clientX-sx); mapTy=sty+(ev.clientY-sy); mapUserAdjusted=true; applyTransform(); };
    const up=()=>{ panning=false; frame.className='mapframe'; window.removeEventListener('pointermove',mv); window.removeEventListener('pointerup',up); };
    window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up); });
  if(drawerAgent) frame.append(buildDrawer(drawerAgent));
  else if(drawerResult) frame.append(buildResultDrawer());
  return frame;
}
function drawEdges(){
  const canvas=document.getElementById('mapcanvas'); const svg=document.getElementById('map-edges');
  if(!canvas||!svg||!mapEls.orch) return;
  const cr=canvas.getBoundingClientRect();
  // edges live in the canvas's LAYOUT coordinate space (the SVG scales with the
  // canvas transform), so divide rendered deltas by the live scale.
  const scale=canvas.offsetWidth?(cr.width/canvas.offsetWidth):1;
  svg.setAttribute('width',canvas.scrollWidth); svg.setAttribute('height',canvas.scrollHeight);
  edgePaths.forEach(p=>p.remove()); edgePaths=[];
  const center=(el,side)=>{const r=el.getBoundingClientRect();
    return {x:(r.left-cr.left+r.width/2)/scale, y:((side==='top'?r.top:r.bottom)-cr.top)/scale};};
  const add=(a,b,cls)=>{const dy=Math.max(30,(b.y-a.y)*0.5);
    const d='M'+a.x+' '+a.y+' C '+a.x+' '+(a.y+dy)+' '+b.x+' '+(b.y-dy)+' '+b.x+' '+b.y;
    const p=svgEl('path',{class:'edge'+(cls?' '+cls:''),d:d,'marker-end':'url(#arrow)'}); svg.append(p); edgePaths.push(p);};
  // classify edges by the downstream phase's live state: amber while a phase is
  // running, dashed/dim for a phase that hasn't started any agent yet.
  const edgeCls=(k)=>{ const t=RUN.phases[k]&&RUN.phases[k].title; if(t==null) return '';
    const st=phaseStats(t); if(st.running>0) return 'live'; if((st.done+st.running)===0) return 'pending'; return ''; };
  const ph=mapEls.phases;
  (ph[0]||[]).forEach(n=>add(center(mapEls.orch,'bottom'),center(n,'top'),edgeCls(0)));
  for(let k=0;k<ph.length-1;k++){ const bar=mapEls.barriers[k]; if(!bar)continue;
    const cIn=edgeCls(k), cOut=edgeCls(k+1);
    ph[k].forEach(n=>add(center(n,'bottom'),center(bar,'top'),cIn));
    ph[k+1].forEach(n=>add(center(bar,'bottom'),center(n,'top'),cOut)); }
  if(mapEls.result)(ph[ph.length-1]||[]).forEach(n=>add(center(n,'bottom'),center(mapEls.result,'top'),edgeCls(ph.length-1)));
}

// ── zoom / pan ──────────────────────────────────────────────────────────────
function applyTransform(){
  const c=document.getElementById('mapcanvas'); if(!c)return;
  c.style.transformOrigin='0 0';
  c.style.transform='translate('+mapTx+'px,'+mapTy+'px) scale('+mapZoom+')';
  const l=document.getElementById('zoomlbl'); if(l) l.textContent=Math.round(mapZoom*100)+'%';
}
// Default "home" view: 100% (fully readable), centered, anchored near the top so
// you read the run top-down. Tall maps overflow downward — pan or Fit to see all.
function homeView(){
  const f=document.getElementById('mapframe'), c=document.getElementById('mapcanvas'); if(!f||!c)return;
  const vp=f.getBoundingClientRect(), cw=c.scrollWidth, ch=c.scrollHeight; if(!vp.width)return;
  mapZoom=1;
  mapTx=Math.max(24,(vp.width-cw)/2);
  mapTy=ch<=vp.height?Math.max(24,(vp.height-ch)/2):28;
  mapUserAdjusted=false; applyTransform();
}
// Zoom out as needed so the WHOLE map fits, and center it (the on-demand overview).
function fitMap(){
  const f=document.getElementById('mapframe'), c=document.getElementById('mapcanvas'); if(!f||!c)return;
  const vp=f.getBoundingClientRect(), cw=c.scrollWidth, ch=c.scrollHeight; if(!cw||!ch||!vp.width)return;
  let z=Math.min(vp.width/(cw+48), vp.height/(ch+48)); z=Math.min(z,1); z=Math.max(z,0.12);
  mapZoom=z; mapTx=Math.max(0,(vp.width-cw*z)/2); mapTy=Math.max(14,(vp.height-ch*z)/2);
  mapUserAdjusted=false; applyTransform();
}
// Zoom by factor, keeping the point (cx,cy) in viewport coords fixed (cursor/center).
function zoomAt(factor,cx,cy){
  const f=document.getElementById('mapframe'); if(!f)return; const vp=f.getBoundingClientRect();
  if(cx==null){cx=vp.width/2;cy=vp.height/2;}
  const nz=Math.min(2.6,Math.max(0.12,mapZoom*factor));
  const wx=(cx-mapTx)/mapZoom, wy=(cy-mapTy)/mapZoom;
  mapZoom=nz; mapTx=cx-wx*nz; mapTy=cy-wy*nz; mapUserAdjusted=true; applyTransform();
}

// detail drawer (progressive disclosure on a node)
function buildDrawer(label){
  const a=agentByLabel(label); if(!a) return h('div',{});
  const back=h('div',{class:'drawer'+(view==='map'?' dock':''),id:'drawer'});
  back.append(h('div',{class:'drawer-backdrop',onclick:closeDrawer}));
  const panel=h('div',{class:'drawer-panel'+(__suppressMotion?'':' intro'),role:'dialog','aria-modal':'true','aria-label':'Agent '+a.label});
  const top=h('div',{class:'drawer-top'});
  top.append(h('div',{class:'drawer-head'},
    h('div',{}, h('div',{class:'crumbs'},a.phase), h('div',{class:'title-lg',style:{fontSize:'17px'}},a.label)),
    h('button',{class:'xbtn',id:'drawer-close','aria-label':'Close',onclick:closeDrawer},'✕')));
  const chips=h('div',{class:'metarow',style:{padding:'0 18px 12px'}});
  if(a.model) chips.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
  if(a.effort) chips.append(h('span',{class:'pill'},'effort · '+a.effort));
  if(a.tokens!=null) chips.append(h('span',{class:'pill'},fmtTokens(a.tokens)+' tok'));
  if(a.ms!=null) chips.append(h('span',{class:'pill'},fmtMs(a.ms)));
  chips.append(statusChip(a));
  chips.append(h('a',{href:'#',class:'pill',onclick:(e)=>{e.preventDefault();view='tree';drawerAgent=null;select({type:'agent',id:label});}},'open in tree ↗'));
  top.append(chips);
  panel.append(top);
  const body=h('div',{class:'drawer-body'});
  if(isRunning(a) && a.result==null){
    body.append(pendingResult(a));
  } else {
    if(a.result&&typeof a.result==='object') body.append(renderValue(a.result));
    else body.append(h('div',{class:'prose'},a.result==null?'(no result)':String(a.result)));
    const det=h('details',{class:'raw'}); det.append(h('summary',{},'raw json'), h('pre',{class:'json'},JSON.stringify(a.result,null,2)));
    body.append(det);
  }
  panel.append(body); back.append(panel);
  return back;
}
// result drawer: render the workflow's actual return value (the honest output)
function buildResultDrawer(){
  const back=h('div',{class:'drawer'+(view==='map'?' dock':''),id:'drawer'});
  back.append(h('div',{class:'drawer-backdrop',onclick:closeDrawer}));
  const panel=h('div',{class:'drawer-panel'+(__suppressMotion?'':' intro'),role:'dialog','aria-modal':'true','aria-label':'Workflow result'});
  const top=h('div',{class:'drawer-top'});
  top.append(h('div',{class:'drawer-head'},
    h('div',{}, h('div',{class:'crumbs'},RUN.name), h('div',{class:'title-lg',style:{fontSize:'17px'}},'workflow result')),
    h('button',{class:'xbtn',id:'drawer-close','aria-label':'Close',onclick:closeDrawer},'✕')));
  panel.append(top);
  const body=h('div',{class:'drawer-body'});
  const r=RUN.result;
  if(r&&typeof r==='object') body.append(renderValue(r));
  else body.append(h('div',{class:'prose'}, r==null?'(empty)':String(r)));
  const det=h('details',{class:'raw'}); det.append(h('summary',{},'raw json'), h('pre',{class:'json'},JSON.stringify(r,null,2)));
  body.append(det); panel.append(body); back.append(panel);
  return back;
}
let __drawerReturnFocus=null;
function focusClose(){ if(typeof requestAnimationFrame!=='undefined') requestAnimationFrame(()=>{ const x=document.getElementById('drawer-close'); if(x&&x.focus) x.focus(); }); }
function openDrawer(label){
  __drawerReturnFocus=document.activeElement; drawerAgent=label; drawerResult=false;
  render(); // re-render so the node shows selected + the dock mounts consistently
  focusClose(); saveState();
}
function openResultDrawer(){
  __drawerReturnFocus=document.activeElement; drawerResult=true; drawerAgent=null;
  render(); focusClose(); saveState();
}
function closeDrawer(){
  const had=drawerAgent||drawerResult; if(!had) return; drawerAgent=null; drawerResult=false;
  render();
  if(__drawerReturnFocus&&__drawerReturnFocus.focus){ try{__drawerReturnFocus.focus();}catch(e){} } __drawerReturnFocus=null;
  saveState();
}

function render(){
  const motionSuppressed=__suppressMotion; // capture now — the map rAF runs after the reconcile resets it
  if(typeof document!=='undefined'&&document.body) document.body.className = theme==='light'?'theme-light':'';
  computeModelColors();
  const app=document.getElementById('app'); app.textContent='';
  app.append(renderHeader());
  if(view==='map'){ app.append(renderMapFrame()); }
  else {
    const body=h('div',{class:'body'});
    body.append(h('div',{class:'sidebar'}, buildTree()), h('div',{class:'main'}, renderMain()));
    app.append(body);
  }
  app.append(renderFooter());
  // restore scroll after layout (one-shot — after a live reconcile or fallback
  // reload), then snapshot current state for the fallback reload path.
  requestAnimationFrame(()=>{
    if(__restoreScroll){
      const main=document.querySelector('.main'), side=document.querySelector('.sidebar'), db=document.querySelector('.drawer-body');
      if(main) main.scrollTop=__restoreScroll.main; if(side) side.scrollTop=__restoreScroll.side;
      if(db && __restoreScroll.drawer!=null) db.scrollTop=__restoreScroll.drawer;
      __restoreScroll=null;
    }
    saveState();
  });
  if(view==='map'){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      // a live reconcile must NOT re-home the camera (that would look like a jump);
      // keep the exact transform and just reflow the edges to the new node layout.
      if(mapUserAdjusted||motionSuppressed) applyTransform(); else homeView();
      drawEdges();
    }));
    if(typeof window!=='undefined' && !window.__wfResize){ window.__wfResize=true;
      window.addEventListener('resize',()=>{ if(view!=='map')return; if(!mapUserAdjusted) homeView(); drawEdges(); });
      window.addEventListener('keydown',(e)=>{ if(view!=='map')return;
        const t=e.target&&e.target.tagName; if(t==='INPUT'||t==='TEXTAREA')return;
        if(e.key==='f'||e.key==='F'){fitMap();}
        else if(e.key==='0'){homeView();}
        else if(e.key==='+'||e.key==='='){zoomAt(1.2);}
        else if(e.key==='-'||e.key==='_'){zoomAt(0.83);} });
    }
  }
}

// one-time global wiring: Escape closes the drawer (any view), keyboard/pointer
// count as interaction (used only by the reload fallback), unload snapshots state.
// Then kick off the live elapsed tick + the no-reload sidecar sync loop.
function initLive(){
  if(typeof window==='undefined'||window.__wfInit) return; window.__wfInit=true;
  window.addEventListener('keydown',(e)=>{ noteInteract();
    if(e.key==='Escape'&&(drawerAgent||drawerResult)){ e.preventDefault(); closeDrawer(); } });
  window.addEventListener('pointerdown',noteInteract,true);
  window.addEventListener('pagehide',saveState);
  window.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') saveState(); });
  if(LIVE){
    if(!window.__wfTick) window.__wfTick=setInterval(tickLive,1000); // elapsed clocks (no re-render)
    if(!window.__wfSync) window.__wfSync=setInterval(liveSync,1200); // pull fresh data, reconcile in place
    liveSync();                                                      // kick immediately
  }
}
// live-debug seam: type __wfState() in the console to see the current live state.
if(typeof window!=='undefined') window.__wfState=()=>({gen:__lastGen, live:LIVE, settled:!LIVE, agents:RUN.agents.length, running:RUN.agents.filter(isRunning).length, name:RUN.name});
loadState(); render(); initLive();
`;

// ── emit (CSS + APP are now initialized) ─────────────────────────────────────
const outPath =
  (opts.outPath && resolve(opts.outPath)) ||
  join(runDir, basename(journalPath).replace(/\.jsonl$/, "") + ".run.html");

if (opts.settle) {
  // Final render: a static (data-live="0") HTML with data fully inlined, PLUS a
  // final sidecar carrying final:true so any still-open live page reconciles to
  // the finished state and stops polling. Then exit.
  const model = buildModel();
  model.final = true;
  const gen = nowGen();
  writeAtomic(outPath, renderHtml(model, false, gen));
  writeSidecars(outPath, model, gen);
  console.log(outPath);
} else {
  const gen0 = nowGen();
  writeAtomic(outPath, renderHtml(buildModel(), opts.watch, gen0));
  if (opts.watch) writeSidecars(outPath, buildModel(), gen0);
  console.log(outPath);

  if (opts.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(opener, [outPath], () => {});
  }

  // --watch: as the journal/events grow, rewrite the data sidecars (and the HTML,
  // for a fresh manual reload). The OPEN page never reloads — it pulls the
  // sidecars and patches the DOM in place. Runs until Ctrl-C.
  if (opts.watch) {
    console.error(`↻ watching ${journalPath} — live-updating ${outPath} on change (Ctrl-C to stop)`);
    let lastSig = "";
    const eventsPath = eventsPathFor(journalPath);
    const progressPath = progressPathFor(journalPath);
    // size+mtime, not size alone: a truncate/rewrite/resume can keep byte count
    // stable while content changes, and the sidecars are rewritten in place.
    const sig = (p) => { try { const s = statSync(p); return s.size + ":" + s.mtimeMs; } catch { return "0:0"; } };
    const tick = () => {
      const cur = sig(journalPath) + "|" + sig(eventsPath) + "|" + sig(progressPath);
      if (cur !== lastSig) {
        lastSig = cur;
        try {
          const model = buildModel();
          const gen = nowGen();
          writeSidecars(outPath, model, gen);              // the no-reload update channel
          writeAtomic(outPath, renderHtml(model, true, gen)); // keep HTML fresh for a manual reload
        } catch (e) {
          console.error(`  ! update failed: ${e?.message ?? e}`);
        }
      }
    };
    setInterval(tick, 1500);
  }
}
