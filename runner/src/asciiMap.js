// Render a run model (from runModel.js) as an ASCII execution DAG: an orchestrator
// node-box, a flow arrow into each phase layer, branch edges to a fixed-column
// agent grid (status · agent · model · effort · tokens · wall) with a 1–2 sentence
// result snippet under each node, semantic barriers between phases, and a result
// node-box. Pure (returns a string); bin/map-run.js handles I/O and the --watch loop.

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

function makeColors(on) {
  const wrap = (code) => (s) => (on ? code + s + ANSI.reset : String(s));
  const C = {
    bold: wrap(ANSI.bold), dim: wrap(ANSI.dim), cyan: wrap(ANSI.cyan),
    green: wrap(ANSI.green), yellow: wrap(ANSI.yellow), text: (s) => String(s),
  };
  C.effort = (eff, s) => {
    if (!on) return String(s);
    const c = { xhigh: ANSI.magenta, high: ANSI.blue, medium: ANSI.yellow, low: ANSI.dim, minimal: ANSI.dim, none: ANSI.dim }[eff] || "";
    return c ? c + s + ANSI.reset : String(s);
  };
  return C;
}

// ── monospace-display-width helpers (color-safe + wide/combining-char safe) ──
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const WIDE_RE = /[ᄀ-ᅟ〈〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;
const COMBINING_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "");
function dispWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) { if (COMBINING_RE.test(ch)) continue; w += WIDE_RE.test(ch) ? 2 : 1; }
  return w;
}
function truncW(s, w) {
  s = stripAnsi(String(s));
  if (dispWidth(s) <= w) return s;
  let out = "", cur = 0;
  for (const ch of s) {
    if (COMBINING_RE.test(ch)) { out += ch; continue; }
    const cw = WIDE_RE.test(ch) ? 2 : 1;
    if (cur + cw > w - 1) break;
    out += ch; cur += cw;
  }
  return out + "…";
}
function padEndW(s, w) { const d = dispWidth(s); return d >= w ? truncW(s, w) : s + " ".repeat(w - d); }
function padStartW(s, w) { const d = dispWidth(s); return d >= w ? truncW(s, w) : " ".repeat(w - d) + s; }

function fmtTokens(n) {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
function fmtMs(ms) {
  if (ms == null) return null;
  const sec = ms / 1000;
  if (sec < 60) return (sec < 10 ? sec.toFixed(1) : String(Math.round(sec))) + "s";
  const total = Math.round(sec); // round to whole seconds first, then split (no 1m60s)
  return Math.floor(total / 60) + "m" + String(total % 60).padStart(2, "0") + "s";
}

const CIRCLED = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮"];
const circled = (n) => CIRCLED[n] ?? `(${n})`;

// One-line summary of a result value — a headline-ish field, the first prose line
// of a Markdown report, or the first substantial string. Mirrors the HTML viewer.
function summarizeValue(r) {
  if (r == null) return "";
  if (typeof r === "string") return r.replace(/\s+/g, " ").trim();
  if (typeof r !== "object") return String(r);
  const direct = r.recommended_direction || r.recommendation || r.one_line_verdict || r.tagline
    || r.headline || (r.hero && r.hero.headline);
  if (direct) return String(direct);
  if (typeof r.reportMarkdown === "string") {
    const line = r.reportMarkdown.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (line) return line.replace(/[*`]/g, "");
  }
  return Object.values(r).find((v) => typeof v === "string" && v.length > 8) || "";
}

// Outcome summary for the result node: prefer the workflow's actual return value
// (the honest result the runner persisted), then fall back to a heuristic "final
// agent" result for journal-only runs that have no persisted return value.
function outcomeSummary(run) {
  if (run.result !== undefined && run.result !== null) return summarizeValue(run.result);
  const last = run.phases[run.phases.length - 1];
  const inLast = last ? run.agents.filter((a) => a.phase === last.title) : [];
  const fa = run.agents.find((a) => a.result && (a.result.recommended_direction || a.result.recommendation))
    || (inLast.length === 1 ? inLast[0] : null);
  return fa ? summarizeValue(fa.result) : "";
}

const displayLabel = (label) => (label.includes(":") ? label.split(":").slice(1).join(":") || label : label);

// fixed agent-grid columns (after the connector + status glyph)
const GRID = { model: 7, effort: 6, tok: 6, wall: 6 };

export function renderMap(run, { color = false, width = 80, maxAgents = 12, now = null, spinner = "●", snippets = true } = {}) {
  const C = makeColors(color);
  const title = (s) => C.bold(C.cyan(s));
  const out = [];
  const headline = outcomeSummary(run);
  const doneCount = run.agents.filter((a) => a.status !== "running").length;
  const runCount = run.agents.length - doneCount;

  // one width contract: everything derives from frameW (capped so it stays
  // scannable on ultra-wide terminals).
  const frameW = Math.min(Math.max(56, width || 80), 92);
  const innerW = frameW - 4;
  const snippetW = frameW - 6;
  const labelW = Math.min(16, Math.max(8, ...(run.agents.length ? run.agents.map((a) => dispWidth(displayLabel(a.label))) : [8])));
  const hasMetrics = run.totals.hasMetrics;

  // orchestrator node: progress strip + counts, then totals (no headline — that
  // narrative lives only in the result node).
  const strip = progressStrip(run, spinner, C);
  const totals = [
    `${run.phases.length} phase${run.phases.length === 1 ? "" : "s"}`,
    hasMetrics && run.totals.tokens ? fmtTokens(run.totals.tokens) + " tok" : null,
    hasMetrics && run.totals.ms ? fmtMs(run.totals.ms) : null,
    Object.keys(run.models).join(",") || null,
  ].filter(Boolean).join(" · ");
  const headLine = strip.glyphs + (strip.glyphs ? "  " : "") + strip.label + (totals ? " · " + totals : "");
  pushBox(out, C, title, "◆ " + run.name, [headLine], innerW);

  if (!run.agents.length) {
    out.push(C.dim("  │"));
    out.push(C.dim("  ▼  (no agents yet — waiting for the first to start…)"));
    return out.join("\n");
  }

  out.push(C.dim("  │"));
  const phases = run.phases.filter((p) => run.agents.some((a) => a.phase === p.title));
  phases.forEach((p, pi) => {
    const ags = run.agents.filter((a) => a.phase === p.title).sort((a, b) => a.order - b.order);
    const pdone = ags.filter((a) => a.status !== "running").length;
    const prun = ags.length - pdone;
    const ptok = ags.reduce((s, a) => s + (a.tokens || 0), 0);
    const pms = ags.reduce((s, a) => s + (a.ms || 0), 0);
    const pmeta = [
      prun ? `${pdone} done · ${prun} running` : `${ags.length} agent${ags.length === 1 ? "" : "s"}`,
      hasMetrics && ptok ? fmtTokens(ptok) + " tok" : null,
      hasMetrics && pms ? fmtMs(pms) : null,
    ].filter(Boolean).join(" · ");
    // layer header: ▼ ① Title ───── metrics   (rule fills to a single frame width)
    const lead = "▼ " + circled(pi + 1) + " " + p.title + " ";
    const ruleLen = Math.max(2, frameW - dispWidth(lead) - dispWidth(pmeta) - 6);
    out.push("  " + C.bold(C.cyan(lead)) + C.dim("─".repeat(ruleLen) + "  " + pmeta));
    if (hasMetrics) out.push(gridHeader(labelW, C));

    const collapse = ags.length > maxAgents;
    const shown = collapse ? ags.slice(0, maxAgents - 1) : ags;
    shown.forEach((a, i) => {
      const last = !collapse && i === shown.length - 1;
      out.push(agentRow(a, last ? "╰─" : "├─", labelW, C, hasMetrics, now, spinner));
      if (snippets && a.status !== "running") {
        const snip = agentSnippet(a.result);
        if (snip) {
          const rail = last ? "      " : "  " + C.dim("│") + "   ";
          for (const ln of wrapText(snip, snippetW, 2)) out.push(rail + C.dim(ln));
        }
      }
    });
    if (collapse) out.push("  " + C.dim("╰─ … +" + (ags.length - (maxAgents - 1)) + " more"));

    if (pi < phases.length - 1) {
      const next = phases[pi + 1];
      const started = run.agents.some((a) => a.phase === next.title);
      out.push(semanticBarrier(p.title, next.title, started, frameW, C));
    }
  });

  out.push(C.dim("  │"));
  out.push(C.dim("  ▼"));
  pushBox(out, C, title, "✦ result", headline ? wrapText(headline, innerW, 3) : [runCount ? "in progress…" : "(no result)"], innerW);
  return out.join("\n");
}

// run-level monochrome progress strip: ✓ per done agent, spinner per running.
function progressStrip(run, spinner, C) {
  const ags = [...run.agents].sort((a, b) => a.order - b.order);
  const N = ags.length, done = ags.filter((a) => a.status !== "running").length, running = N - done;
  const CAP = 16;
  let glyphs = "";
  if (N === 0) glyphs = "";
  else if (N <= CAP) glyphs = ags.map((a) => (a.status === "running" ? C.cyan(spinner || "⠿") : C.green("✓"))).join("");
  else glyphs = C.green("✓".repeat(Math.min(done, CAP))) + (running ? C.cyan(spinner || "⠿") : "");
  const label = running ? `${done}/${N} done · ${running} running` : `${done}/${N} done`;
  return { glyphs, label };
}

// fixed-column header for the agent grid (dim), aligned under the data columns.
function gridHeader(labelW, C) {
  const h =
    padEndW("AGENT", labelW) + "  " + padEndW("MODEL", GRID.model) + "  " +
    padEndW("EFFORT", GRID.effort) + "  " + padStartW("TOKENS", GRID.tok) + "  " + padStartW("WALL", GRID.wall);
  return "      " + C.dim(h); // 6 = base indent(2) + connector(2) + glyph(1) + space(1)
}

// One agent grid row. Running rows keep the same columns (spinner status, `--`
// tokens, elapsed in WALL) so done/running scan as one table — no live churn.
function agentRow(a, conn, labelW, C, hasMetrics, now, spinner) {
  const running = a.status === "running";
  const glyph = running ? C.cyan(spinner || "⠿") : a.result == null ? C.yellow("◑") : C.green("✓");
  const cells = [C.text(padEndW(displayLabel(a.label), labelW))];
  cells.push(C.dim(padEndW(a.model || "", GRID.model)));
  cells.push(a.effort ? C.effort(a.effort, padEndW(a.effort, GRID.effort)) : C.dim(padEndW("", GRID.effort)));
  if (running) {
    cells.push(C.dim(padStartW("--", GRID.tok)));
    cells.push(C.dim(padStartW(now && a.startedAt ? fmtMs(now - a.startedAt) : "·", GRID.wall)));
  } else if (hasMetrics) {
    cells.push(C.dim(padStartW(fmtTokens(a.tokens) ?? "·", GRID.tok)));
    cells.push(C.dim(padStartW(fmtMs(a.ms) ?? "·", GRID.wall)));
  }
  return "  " + C.dim(conn) + glyph + " " + cells.join("  ");
}

// Inter-phase gate rendered as a semantic, full-width row (part of the graph).
function semanticBarrier(prevTitle, nextTitle, started, frameW, C) {
  const text = started ? `barrier · ${prevTitle} → ${nextTitle}` : `barrier · ${prevTitle} done · awaiting ${nextTitle}`;
  const t = truncW(text, Math.max(10, frameW - 8));
  const fill = Math.max(2, frameW - 4 - dispWidth(t));
  return "  " + C.dim("┄ " + t + " " + "┄".repeat(fill));
}

// A rounded node-box with a title in the top border and pre-wrapped body lines.
// Width-aware (display width), so colored body content stays aligned.
function pushBox(out, C, title, name, bodyLines, innerW) {
  const t = truncW(name, innerW);
  out.push(C.dim("╭─ ") + title(t) + C.dim(" " + "─".repeat(Math.max(0, innerW - dispWidth(t) - 1)) + "╮"));
  for (const ln of bodyLines) out.push(C.dim("│ ") + padEndW(ln, innerW) + C.dim(" │"));
  out.push(C.dim("╰" + "─".repeat(innerW + 2) + "╯"));
}

// One agent's "last message" — a short, human-readable summary of its result.
const SNIPPET_KEYS = ["summary", "headline", "one_line_verdict", "tagline", "recommended_direction", "recommendation", "verdict", "tldr", "conclusion", "answer", "reason"];
export function agentSnippet(result) {
  if (result == null) return null;
  if (typeof result === "string") return result.trim() || null;
  if (typeof result !== "object") return String(result);
  for (const k of SNIPPET_KEYS) if (typeof result[k] === "string" && result[k].trim()) return result[k].trim();
  if (result.hero && typeof result.hero.headline === "string") return result.hero.headline.trim();
  if (typeof result.brief === "string" && result.brief.trim()) return result.brief.trim();
  const s = Object.values(result).find((v) => typeof v === "string" && v.trim().length > 12);
  return s ? s.trim() : null;
}

// Word-wrap to display width `w`, at most `maxLines` lines, ellipsis on overflow.
function wrapText(s, w, maxLines) {
  s = stripAnsi(String(s)).replace(/\s+/g, " ").trim();
  if (!s) return [];
  const words = s.split(" ");
  const lines = [];
  let cur = "", i = 0;
  for (; i < words.length; i++) {
    const cand = cur ? cur + " " + words[i] : words[i];
    if (dispWidth(cand) <= w) cur = cand;
    else {
      if (cur) lines.push(cur);
      if (lines.length >= maxLines) { cur = ""; break; }
      cur = dispWidth(words[i]) > w ? truncW(words[i], w) : words[i];
    }
  }
  if (cur && lines.length < maxLines) { lines.push(cur); i = words.length; }
  if (i < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = dispWidth(last) + 1 <= w ? last + "…" : truncW(last, w);
  }
  return lines.slice(0, maxLines);
}
