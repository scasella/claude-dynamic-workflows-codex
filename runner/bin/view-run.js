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

import { writeFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { locateRun, buildLiveRunModel, eventsPathFor } from "../src/runModel.js";

// ── args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { target: null, script: null, journal: null, outPath: null, title: null, open: false, watch: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--script") out.script = rest[++i];
    else if (a === "--journal") out.journal = rest[++i];
    else if (a === "--out") out.outPath = rest[++i];
    else if (a === "--title") out.title = rest[++i];
    else if (a === "--open") out.open = true;
    else if (a === "--watch") out.watch = true;
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
function renderHtml(runModel, live = false) {
  const dataJson = JSON.stringify(runModel).replace(/</g, "\\u003c");
  // In --watch mode the file rewrites itself as the journal grows; a light meta
  // refresh re-pulls it in the browser. (Self-contained otherwise — no refresh.)
  const refresh = live ? `\n<meta http-equiv="refresh" content="2" />` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />${refresh}
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
  --text:#E6EDF3; --muted:#7d8893; --dim:#586471;
  --green:#6EE7B7; --amber:#FBBF24; --red:#F87171; --blue:#60A5FA; --purple:#A78BFA; --cyan:#22D3EE;
  --edge:#4d5b69; --arrow:#586a79;
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
  --text:#1b1e22; --muted:#6c7177; --dim:#a6abb0;
  --green:#0e9d6b; --amber:#b45309; --red:#dc2626; --blue:#2563eb; --purple:#7c3aed; --cyan:#0891b2;
  --edge:#595d55; --arrow:#42463e;
  --endpoint-bg:#1c1f24; --endpoint-text:#ffffff; --endpoint-border:#1c1f24;
  --barrier:#cdcbbf; --barrier-dot:#ffffff; --barrier-dot-border:#bcbaae;
  --header-bg:linear-gradient(180deg,#fbfaf5,#f2f1e9); --sidebar-bg:#f1f0e8; --surface-hover:#efeee6;
  --hero-bg:linear-gradient(180deg,#ffffff,#f7f6f0); --hero-border:#dde6e1;
  --tag-bg:#f0efe7; --json-bg:#faf9f3; --row-hover:#f4f3eb; --backdrop:rgba(28,30,28,.30); --swatch-border:rgba(0,0,0,.16);
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
ul.clean{margin:4px 0;padding-left:18px}
ul.clean li{margin:3px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-family:var(--mono);font-size:11px;background:var(--tag-bg);border:1px solid var(--border);
  border-radius:5px;padding:2px 8px;color:var(--text)}
.badge{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.swatches{display:flex;flex-wrap:wrap;gap:8px}
.sw{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;color:var(--text);
  border:1px solid var(--border);border-radius:6px;padding:4px 8px;background:#0b0e12}
.sw .chip-color{width:16px;height:16px;border-radius:4px;border:1px solid var(--swatch-border);flex:none}
table.t{border-collapse:collapse;width:100%;font-size:12.5px;margin:4px 0}
table.t th{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);
  text-align:left;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}
table.t td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
table.t td.num{font-family:var(--mono);text-align:center;white-space:nowrap}
table.t tr:hover td{background:var(--row-hover)}
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
.tg{background:transparent;color:var(--muted);border:0;padding:6px 13px;font-family:var(--mono);font-size:11px;
  cursor:pointer;letter-spacing:.05em}
.tg.on{background:var(--surface-hover);color:var(--green)}
.tg+.tg{border-left:1px solid var(--border2)}

/* ── execution map ───────────────────────────────────────────────────────── */
.mapframe{flex:1;position:relative;overflow:hidden;background:var(--bg);cursor:grab;touch-action:none}
.mapframe.grabbing{cursor:grabbing}
.mapcanvas{position:relative;min-width:max-content;margin:0;padding:48px 64px 88px;display:flex;flex-direction:column;will-change:transform}
.mapctl{position:absolute;right:16px;bottom:16px;display:flex;align-items:center;gap:6px;z-index:5;
  background:var(--panel);border:1px solid var(--border2);border-radius:10px;padding:5px 7px;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.zb{background:transparent;border:1px solid var(--border2);color:var(--text);border-radius:7px;min-width:30px;height:28px;
  cursor:pointer;font-size:14px;font-family:var(--mono);line-height:1;padding:0 9px}
.zb:hover{border-color:var(--green);color:var(--green)}
.zb.fit{font-size:11px}
.zlbl{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:44px;text-align:center}
svg.edges{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
svg.edges path.edge{fill:none;stroke:var(--edge);stroke-width:1.75;stroke-linecap:round}
svg.edges path.arrowhead{fill:var(--arrow)}
.mrow{position:relative;z-index:1;display:grid;grid-template-columns:264px minmax(420px,1fr) 264px;align-items:center}
.mrow.phase{padding:34px 0}
.mrow.orch,.mrow.result{padding:16px 0}
.mgutter.left{padding-right:52px;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.mcenter{grid-column:2;display:flex;flex-direction:column;align-items:center;gap:10px}
.mnodes{grid-column:2;display:flex;justify-content:center;flex-wrap:wrap;gap:24px}
.plabel{font-family:var(--sans);font-size:14.5px;color:var(--text);font-weight:650;letter-spacing:-.01em;display:flex;gap:8px;align-items:center}
.pidx{color:var(--muted);font-family:var(--mono);font-size:10px;border:1px solid var(--border2);border-radius:5px;padding:1px 6px}
.pdetail{color:var(--muted);font-size:11.5px;max-width:200px;line-height:1.5}
.pcount{color:var(--dim);font-family:var(--mono);font-size:10px;letter-spacing:.04em;margin-top:1px}
.mnode{position:relative;background:var(--panel2);border:1px solid var(--border2);border-radius:12px;padding:14px 22px;
  min-width:146px;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;
  transition:border-color .14s ease,box-shadow .14s ease}
.mnode.agent:hover{border-color:var(--green);box-shadow:0 2px 14px rgba(0,0,0,.28)}
.mnode .mlabel{font-family:var(--sans);font-size:14px;color:var(--text);font-weight:600;letter-spacing:-.005em;white-space:nowrap}
.mnode .mmodel{font-size:10px !important;padding:1px 7px !important}
.mnode.more{border-style:dashed;background:transparent;min-width:auto;padding:12px 18px}
.mnode.more .mlabel{color:var(--muted);font-weight:600}
.mnode.more:hover{border-color:var(--green)} .mnode.more:hover .mlabel{color:var(--text)}
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
  border-left:1px solid var(--border2);box-shadow:-24px 0 70px rgba(0,0,0,.55);display:flex;flex-direction:column;
  animation:slidein .18s ease}
@keyframes slidein{from{transform:translateX(24px);opacity:.5}to{transform:none;opacity:1}}
.drawer-head{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 18px 8px;gap:12px}
.drawer-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:auto;padding:8px 18px 30px}
.xbtn{background:transparent;border:1px solid var(--border2);color:var(--muted);border-radius:7px;width:30px;height:30px;
  cursor:pointer;font-size:13px;flex:none}
.xbtn:hover{color:var(--text);border-color:var(--green)}
`;

// Client app. Keep it dependency-free; build DOM with a tiny h() so all user
// data goes in via text nodes (no HTML injection).
const APP = String.raw`
const RUN = JSON.parse(document.getElementById('run-data').textContent);
let theme='dark';
const MODEL_PALETTES={
  dark:['#6EE7B7','#60A5FA','#A78BFA','#FBBF24','#22D3EE','#F87171'],
  light:['#0e9d6b','#2563eb','#7c3aed','#b45309','#0891b2','#dc2626']};
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
function statusChip(a){
  if(isRunning(a)){const e=elapsedOf(a);return h('span',{class:'pill run'}, h('span',{class:'dot amber'}), 'running'+(e?' · '+e:''));}
  return h('span',{class:'pill ok'}, h('span',{class:'dot'}),'completed');
}
const phaseTokens=(t)=>agentsInPhase(t).reduce((s,a)=>s+(a.tokens||0),0);
const phaseMs=(t)=>agentsInPhase(t).reduce((s,a)=>s+(a.ms||0),0);

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
const agentsInPhase = (title)=>RUN.agents.filter(a=>a.phase===title).sort((a,b)=>a.order-b.order);
const finalAgent = ()=>{
  const last=RUN.phases[RUN.phases.length-1];
  const inLast=last?agentsInPhase(last.title):[];
  return RUN.agents.find(a=>a.result&&(a.result.recommended_direction||a.result.recommendation))
    || (inLast.length===1?inLast[0]:null);
};

let sel={type:'run'};
const selKey=(s)=> s.type==='run'?'run':s.type+':'+s.id;

// ── sidebar tree ───────────────────────────────────────────────────────────
const collapsed={};
function buildTree(){
  const t=h('div',{class:'tree'});
  t.append(node({type:'run'},'▸','◆ '+RUN.name,RUN.counts.agents,'',false));
  RUN.phases.forEach((p,pi)=>{
    const kids=agentsInPhase(p.title);
    const isCol=collapsed[p.title];
    t.append(node({type:'phase',id:p.title},isCol?'▸':'▾',p.title,kids.length,'phase',true,pi+1));
    if(!isCol){
      const wrap=h('div',{class:'children'});
      kids.forEach(a=>{
        const n=node({type:'agent',id:a.label},'',a.label.includes(':')?a.label.split(':').slice(1).join(':')||a.label:a.label,null,'agent',false,null,isRunning(a));
        if(a.model) n.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55',padding:'0 6px',fontSize:'10px',marginLeft:'auto'}},a.model.replace('gpt-','')));
        wrap.append(n);
      });
      t.append(wrap);
    }
  });
  return t;
}
function node(target,twig,labelText,count,cls,isPhase,idx,running){
  const n=h('div',{class:'node '+(cls||'')+(selKey(sel)===selKey(target)?' sel':''),
    onclick:(ev)=>{ if(isPhase && ev.target.classList.contains('tw')){collapsed[target.id]=!collapsed[target.id];render();return;} select(target); }});
  n.append(h('span',{class:'tw',onclick:isPhase?(ev)=>{ev.stopPropagation();collapsed[target.id]=!collapsed[target.id];render();}:null},twig||''));
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
    return h('div',{},value.map(v=>h('div',{class:'card',style:{margin:'8px 0'}},renderValue(v))));
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

function renderTable(rows){
  const cols=[]; rows.forEach(r=>Object.keys(r).forEach(k=>{if(!cols.includes(k))cols.push(k);}));
  // keep big text columns out of the table; render them under each row instead
  const longCols=cols.filter(c=>rows.some(r=>typeof r[c]==='string'&&r[c].length>90));
  const tblCols=cols.filter(c=>!longCols.includes(c));
  const wrap=h('div',{});
  const t=h('table',{class:'t'});
  t.append(h('tr',{},tblCols.map(c=>h('th',{},c))));
  rows.forEach(r=>{
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
    t.append(tr);
    if(longCols.length){
      const tr2=h('tr',{});
      const td=h('td',{colspan:tblCols.length,style:{paddingTop:'2px',paddingBottom:'12px'}});
      longCols.forEach(c=>{ if(r[c]!=null&&r[c]!==''){ td.append(h('div',{class:'k',style:{marginTop:'4px'}},c)); td.append(h('div',{class:'prose'},String(r[c]))); }});
      tr2.append(td); t.append(tr2);
    }
  });
  wrap.append(t);
  return wrap;
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
  if(sel.type==='agent') return renderAgent(RUN.agents.find(a=>a.label===sel.id));
  return h('div',{});
}

function renderRun(){
  const m=h('div',{});
  if(RUN.description) m.append(h('div',{class:'sub',style:{maxWidth:'90ch',marginBottom:'4px'}},RUN.description));
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
let view='map', drawerAgent=null;
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
  const n=h('div',{class:'mnode agent'+(run?' running':''),title:tip,onclick:()=>openDrawer(a.label)});
  n.append(h('span',{class:'msdot'+(run?' amber':'')}));
  n.append(h('span',{class:'mlabel'}, a.label.includes(':')?a.label.split(':').slice(1).join(':'):a.label));
  if(a.model) n.append(h('span',{class:'chip mmodel',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model.replace('gpt-','')));
  return n;
}
function orchRow(){
  const node=h('div',{class:'mnode endpoint orch-node'}, h('span',{class:'mlabel'},RUN.name), h('span',{class:'mendsub'},'orchestrator'),
    h('div',{class:'mnote mnote-side'},'kicks off '+plural(RUN.counts.agents,'agent')+' across '+plural(RUN.counts.phases,'phase')));
  mapEls.orch=node;
  return h('div',{class:'mrow orch'}, h('div',{class:'mgutter'}), h('div',{class:'mcenter'}, node), h('div',{class:'mgutter'}));
}
const MAP_CAP=12; // max agent nodes drawn per phase row; the rest collapse to "+N more"
function phaseRow(p,i){
  const all=agentsInPhase(p.title);
  const ags=all.length>MAP_CAP?all.slice(0,MAP_CAP-1):all;
  const gut=h('div',{class:'mgutter left'},
    h('div',{class:'plabel'}, h('span',{class:'pidx'},(i+1)), p.title),
    p.detail?h('div',{class:'pdetail'},p.detail):null,
    h('div',{class:'pcount'},all.length+(all.length===1?' agent':' parallel')));
  if(hasMetrics()){const pt=phaseTokens(p.title),pm=phaseMs(p.title);const parts=[pt?fmtTokens(pt)+' tok':null,pm?fmtMs(pm):null].filter(Boolean);
    if(parts.length) gut.append(h('div',{class:'pcount'},parts.join(' · ')));}
  const nodes=h('div',{class:'mnodes'}); const els=[];
  ags.forEach(a=>{const n=agentNode(a); els.push(n); nodes.append(n);});
  if(all.length>MAP_CAP){
    const more=h('div',{class:'mnode more',title:'open this phase in Tree view to see all '+all.length,
      onclick:()=>{view='tree';drawerAgent=null;select({type:'phase',id:p.title});}},
      h('span',{class:'mlabel'},'+ '+(all.length-(MAP_CAP-1))+' more'));
    els.push(more); nodes.append(more);
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
  const fa=finalAgent();
  const node=h('div',{class:'mnode endpoint result-node',onclick:fa?function(){openDrawer(fa.label);}:null},
    h('span',{class:'mlabel'},'result'), h('span',{class:'mendsub'},'returns when done'));
  mapEls.result=node;
  const note=fa&&fa.result&&fa.result.recommended_direction?h('div',{class:'mnote'},fa.result.recommended_direction):null;
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
  // wheel zoom toward cursor; drag empty space to pan
  frame.addEventListener('wheel',(e)=>{ e.preventDefault(); const vp=frame.getBoundingClientRect();
    zoomAt(e.deltaY<0?1.12:0.89, e.clientX-vp.left, e.clientY-vp.top); }, {passive:false});
  frame.addEventListener('pointerdown',(e)=>{
    if(e.target&&e.target.closest&&e.target.closest('.mnode,.mapctl,.drawer')) return;
    panning=true; const sx=e.clientX, sy=e.clientY, stx=mapTx, sty=mapTy; frame.className='mapframe grabbing';
    const mv=(ev)=>{ if(!panning)return; mapTx=stx+(ev.clientX-sx); mapTy=sty+(ev.clientY-sy); mapUserAdjusted=true; applyTransform(); };
    const up=()=>{ panning=false; frame.className='mapframe'; window.removeEventListener('pointermove',mv); window.removeEventListener('pointerup',up); };
    window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up); });
  if(drawerAgent) frame.append(buildDrawer(drawerAgent));
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
  const add=(a,b)=>{const dy=Math.max(30,(b.y-a.y)*0.5);
    const d='M'+a.x+' '+a.y+' C '+a.x+' '+(a.y+dy)+' '+b.x+' '+(b.y-dy)+' '+b.x+' '+b.y;
    const p=svgEl('path',{class:'edge',d:d,'marker-end':'url(#arrow)'}); svg.append(p); edgePaths.push(p);};
  const ph=mapEls.phases;
  (ph[0]||[]).forEach(n=>add(center(mapEls.orch,'bottom'),center(n,'top')));
  for(let k=0;k<ph.length-1;k++){ const bar=mapEls.barriers[k]; if(!bar)continue;
    ph[k].forEach(n=>add(center(n,'bottom'),center(bar,'top')));
    ph[k+1].forEach(n=>add(center(bar,'bottom'),center(n,'top'))); }
  if(mapEls.result)(ph[ph.length-1]||[]).forEach(n=>add(center(n,'bottom'),center(mapEls.result,'top')));
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
  const a=RUN.agents.find(x=>x.label===label); if(!a) return h('div',{});
  const back=h('div',{class:'drawer',id:'drawer'});
  back.append(h('div',{class:'drawer-backdrop',onclick:closeDrawer}));
  const panel=h('div',{class:'drawer-panel'});
  panel.append(h('div',{class:'drawer-head'},
    h('div',{}, h('div',{class:'crumbs'},a.phase), h('div',{class:'title-lg',style:{fontSize:'17px'}},a.label)),
    h('button',{class:'xbtn',onclick:closeDrawer},'✕')));
  const chips=h('div',{class:'metarow',style:{padding:'0 18px 4px'}});
  if(a.model) chips.append(h('span',{class:'chip',style:{color:modelColor[a.model],borderColor:modelColor[a.model]+'55'}},a.model));
  if(a.effort) chips.append(h('span',{class:'pill'},'effort · '+a.effort));
  if(a.tokens!=null) chips.append(h('span',{class:'pill'},fmtTokens(a.tokens)+' tok'));
  if(a.ms!=null) chips.append(h('span',{class:'pill'},fmtMs(a.ms)));
  chips.append(statusChip(a));
  chips.append(h('a',{href:'#',class:'pill',onclick:(e)=>{e.preventDefault();view='tree';drawerAgent=null;select({type:'agent',id:label});}},'open in tree ↗'));
  panel.append(chips);
  const body=h('div',{class:'drawer-body'});
  if(a.result&&typeof a.result==='object') body.append(renderValue(a.result));
  else body.append(h('div',{class:'prose'},a.result==null?'(no result)':String(a.result)));
  const det=h('details',{class:'raw'}); det.append(h('summary',{},'raw json'), h('pre',{class:'json'},JSON.stringify(a.result,null,2)));
  body.append(det); panel.append(body); back.append(panel);
  return back;
}
function openDrawer(label){ closeDrawer(); drawerAgent=label; const f=document.getElementById('mapframe'); if(f) f.append(buildDrawer(label)); }
function closeDrawer(){ drawerAgent=null; const d=document.getElementById('drawer'); if(d&&d.remove) d.remove(); }

function render(){
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
  if(view==='map'){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(mapUserAdjusted) applyTransform(); else homeView();   // readable 100%, centered, on entry
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
render();
`;

// ── emit (CSS + APP are now initialized) ─────────────────────────────────────
const outPath =
  (opts.outPath && resolve(opts.outPath)) ||
  join(runDir, basename(journalPath).replace(/\.jsonl$/, "") + ".run.html");
writeFileSync(outPath, renderHtml(buildModel(), opts.watch));
console.log(outPath);

if (opts.open) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [outPath], () => {});
}

// --watch: rebuild the HTML as the journal grows, so an open tab tracks a live
// run (the page auto-refreshes every 2s). Runs until Ctrl-C.
if (opts.watch) {
  console.error(`↻ watching ${journalPath} — rebuilding ${outPath} on change (Ctrl-C to stop)`);
  let lastSize = -1;
  const eventsPath = eventsPathFor(journalPath);
  const sz = (p) => { try { return statSync(p).size; } catch { return 0; } };
  const tick = () => {
    // watch the journal (completed agents) AND the events sidecar (running agents)
    const size = sz(journalPath) + sz(eventsPath);
    if (size !== lastSize) {
      lastSize = size;
      try {
        writeFileSync(outPath, renderHtml(buildModel(), true));
        console.error(`  · rebuilt (${new Date().toISOString()}) — ${size} bytes journal`);
      } catch (e) {
        console.error(`  ! rebuild failed: ${e?.message ?? e}`);
      }
    }
  };
  setInterval(tick, 1500);
}
