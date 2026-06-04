// Shared run-model assembly: read a run's journal (+ optional script) and produce
// the structured model both viewers render — the HTML viewer (bin/view-run.js)
// and the ASCII map (bin/map-run.js). Pure beyond reading the given files, so a
// --watch loop can call buildRunModel() repeatedly as the journal grows.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

// Locate the journal + script from a target (dir or journal path) and/or explicit
// --journal/--script overrides. Returns { journalPath, scriptPath, runDir, error }.
export function locateRun({ target, journal, script } = {}) {
  const t = target ? resolve(target) : null;
  let journalPath = journal ? resolve(journal) : null;
  let runDir = null;

  if (!journalPath && t) {
    if (t.endsWith(".jsonl") && existsSync(t)) {
      journalPath = t;
    } else if (existsSync(t)) {
      runDir = t;
      const jdir = join(t, ".workflow-journal");
      if (existsSync(jdir)) {
        // Exclude the *.events.jsonl sidecar — it also ends in .jsonl and would
        // otherwise sort ahead of the real journal.
        const jsonls = readdirSync(jdir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".events.jsonl"));
        if (jsonls.length) journalPath = join(jdir, jsonls.sort()[0]);
      }
    }
  }
  // Allow attaching before the first agent completes: the journal file doesn't
  // exist yet, but the events sidecar (running agents) does. Live viewers can
  // render from events alone until the journal appears.
  const eventsExist = journalPath && existsSync(eventsPathFor(journalPath));
  if (!journalPath || (!existsSync(journalPath) && !eventsExist)) {
    return { journalPath: null, scriptPath: null, runDir, error: `No journal found. Looked at: ${journalPath ?? target}` };
  }
  runDir = runDir ?? dirname(dirname(journalPath)); // .workflow-journal/<f> → run dir

  let scriptPath = script ? resolve(script) : null;
  if (!scriptPath) {
    const base = basename(journalPath).replace(/\.jsonl$/, ""); // e.g. design-review.workflow
    for (const cand of [join(runDir, base + ".js"), join(runDir, base)]) {
      if (existsSync(cand)) { scriptPath = cand; break; }
    }
  }
  return { journalPath, scriptPath, runDir, error: null };
}

// Extract the `meta` literal from a workflow script (anchored to line-start so a
// comment mentioning `export const meta` can't shadow the real declaration).
export function extractMeta(src) {
  const m = src.match(/^[ \t]*export[ \t]+const[ \t]+meta[ \t]*=[ \t]*/m);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length);
  if (open === -1) return null;
  let depth = 0, end = -1;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) return null;
  try { return new Function("return (" + src.slice(open, end + 1) + ")")(); } catch { return null; }
}

// Pull literal label-prefix / phase / model / effort from each flat agent() opts
// object — the fallback for journals that predate the per-agent metric fields.
function parseAgentSpecs(src) {
  const found = [];
  // Match a flat agent-opts object that contains `label:`. Tolerates one level of
  // nested braces so template-literal labels like `audit:${l.key}` don't break it.
  const re = /\{((?:[^{}]|\{[^{}]*\})*\blabel\s*:(?:[^{}]|\{[^{}]*\})*)\}/g;
  let m;
  const grab = (body, key) => {
    const mm = body.match(new RegExp(key + "\\s*:\\s*[`'\"]([^`'\"$]*)"));
    return mm ? mm[1] : undefined;
  };
  while ((m = re.exec(src))) {
    const labelStart = grab(m[1], "label");
    if (labelStart === undefined) continue;
    found.push({ labelStart, phase: grab(m[1], "phase"), model: grab(m[1], "model"), effort: grab(m[1], "effort") });
  }
  return found;
}

// ── lifecycle events (live observability) ───────────────────────────────────
// The runner optionally writes a sidecar event stream next to the journal:
// {t, type:'start'|'end'|'cached', label, phase, model, effort, tokens, ms}. It's
// separate from the resume journal (purely observational) and lets a live viewer
// show running agents, counts, and true wall-clock.

export function eventsPathFor(journalPath) {
  return journalPath.replace(/\.jsonl$/i, "") + ".events.jsonl";
}

// The workflow's actual return value, persisted by the runner next to the journal
// so the viewer can show the honest output instead of guessing a "final" agent.
export function resultPathFor(journalPath) {
  return journalPath.replace(/\.jsonl$/i, "") + ".result.json";
}

export function readResult(journalPath) {
  const p = resultPathFor(journalPath);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

export function readEvents(journalPath) {
  const p = eventsPathFor(journalPath);
  if (!existsSync(p)) return null;
  const evs = [];
  try {
    for (const line of readFileSync(p, "utf8").trim().split("\n")) {
      if (!line.trim()) continue;
      try { evs.push(JSON.parse(line)); } catch {}
    }
  } catch {
    return null;
  }
  return evs;
}

// Derive live state from the event stream: which agents are still running (a
// 'start' not yet matched by an 'end'/'cached'), counts, and run wall-clock.
export function liveState(events) {
  if (!events || !events.length) return null;
  const byLabel = new Map(); // label -> { starts, ends, lastStartT, phase, model, effort }
  let firstT = Infinity, lastT = 0, ended = 0;
  for (const e of events) {
    if (typeof e.t === "number") { if (e.t < firstT) firstT = e.t; if (e.t > lastT) lastT = e.t; }
    const c = byLabel.get(e.label) || { starts: 0, ends: 0, lastStartT: 0 };
    if (e.type === "start") { c.starts++; c.lastStartT = e.t ?? c.lastStartT; c.phase = e.phase; c.model = e.model; c.effort = e.effort; }
    else if (e.type === "end" || e.type === "cached") { c.ends++; ended++; }
    byLabel.set(e.label, c);
  }
  const running = [];
  for (const [label, c] of byLabel) {
    if (c.starts > c.ends) running.push({ label, phase: c.phase ?? null, model: c.model ?? null, effort: c.effort ?? null, startedAt: c.lastStartT, status: "running" });
  }
  return {
    running,
    doneCount: ended,
    runStartedAt: firstT === Infinity ? null : firstT,
    lastEventAt: lastT || null,
  };
}

export function buildRunModel({ journalPath, scriptPath = null, runDir = null, title = null, generatedAt = null }) {
  // journal is append-only; keep the latest entry per key (resume can re-record).
  // The journal file may not exist yet — a live viewer can attach before the
  // first agent completes (the runner creates it lazily on the first result),
  // in which case the model is built from the event stream alone.
  const byKey = new Map();
  let journalText = "";
  try { journalText = readFileSync(journalPath, "utf8"); } catch {}
  for (const line of journalText.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.label) byKey.set(e.key ?? e.label, e);
    } catch {}
  }
  const agentsRaw = [...byKey.values()];

  let meta = null;
  let specs = [];
  if (scriptPath && existsSync(scriptPath)) {
    const scriptText = readFileSync(scriptPath, "utf8");
    meta = extractMeta(scriptText);
    specs = parseAgentSpecs(scriptText);
  }
  const metaPhases = (meta && Array.isArray(meta.phases) ? meta.phases : []).map((p) =>
    typeof p === "string" ? { title: p } : { title: p.title, detail: p.detail },
  );

  const specFor = (label) => {
    let best = null;
    for (const s of specs) {
      if (s.labelStart && label.startsWith(s.labelStart)) {
        if (!best || s.labelStart.length > best.labelStart.length) best = s;
      }
    }
    return best;
  };
  const phaseForLabel = (label, spec) => {
    if (spec && spec.phase) return spec.phase;
    if (label.includes(":")) {
      const prefix = label.split(":")[0];
      const mt = metaPhases.find((p) => p.title && p.title.toLowerCase().startsWith(prefix.toLowerCase()));
      return mt ? mt.title : prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
    // No phase signal — group flat runs together rather than one phase per agent.
    return "Agents";
  };

  // Prefer the per-agent fields the runtime persists (phase/model/effort/tokens/
  // ms); fall back to script regex + label heuristics for older journals.
  const agents = agentsRaw.map((e, i) => {
    const spec = specFor(e.label);
    return {
      label: e.label,
      order: i,
      phase: e.phase ?? phaseForLabel(e.label, spec),
      model: e.model ?? spec?.model ?? null,
      effort: e.effort ?? spec?.effort ?? null,
      tokens: typeof e.tokens === "number" ? e.tokens : null,
      ms: typeof e.ms === "number" ? e.ms : null,
      result: e.result,
    };
  });

  // phases in meta order, then any extra phases that appeared in the journal
  const phaseOrder = [];
  for (const p of metaPhases) if (!phaseOrder.includes(p.title)) phaseOrder.push(p.title);
  for (const a of agents) if (!phaseOrder.includes(a.phase)) phaseOrder.push(a.phase);

  const models = {};
  for (const a of agents) if (a.model) models[a.model] = (models[a.model] || 0) + 1;

  const totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);
  const totalMs = agents.reduce((s, a) => s + (a.ms || 0), 0);
  const hasMetrics = agents.some((a) => a.tokens != null || a.ms != null);

  return {
    name: title || (meta && meta.name) || basename(journalPath).replace(/\.workflow\.jsonl$|\.jsonl$/, ""),
    description: (meta && meta.description) || "",
    phases: phaseOrder.map((t) => {
      const mp = metaPhases.find((p) => p.title === t);
      return { title: t, detail: mp?.detail || "" };
    }),
    agents,
    models,
    totals: { tokens: totalTokens, ms: totalMs, hasMetrics },
    counts: { phases: phaseOrder.length, agents: agents.length },
    result: readResult(journalPath), // the workflow's actual return value, if the runner persisted it
    sources: { journal: journalPath, script: scriptPath && existsSync(scriptPath) ? scriptPath : null, runDir },
    generatedAt: generatedAt || new Date().toISOString(),
  };
}

// buildRunModel + the live event stream: merge agents that have started but not
// finished (status:'running') into the model, and attach run.live (running list,
// counts, wall-clock). Shared by both viewers so they show the same live state.
export function buildLiveRunModel(opts) {
  const run = buildRunModel(opts);
  const ls = liveState(readEvents(opts.journalPath));
  run.live = ls || { running: [], doneCount: run.agents.length, runStartedAt: null, lastEventAt: null };
  if (ls && ls.running.length) {
    const done = new Set(run.agents.map((a) => a.label));
    let order = run.agents.length;
    for (const r of ls.running) {
      if (done.has(r.label)) continue; // already completed in the journal
      const phase = r.phase ?? "Agents";
      run.agents.push({ label: r.label, order: order++, phase, model: r.model ?? null, effort: r.effort ?? null, tokens: null, ms: null, result: undefined, status: "running", startedAt: r.startedAt });
      if (!run.phases.some((p) => p.title === phase)) run.phases.push({ title: phase, detail: "" });
    }
    // refresh phaseOrder-derived counts
    run.counts = { phases: run.phases.length, agents: run.agents.length };
  }
  return run;
}
