// Multi-persona critique → synthesis: optimally polish the terminal ASCII map
// rendered by runner/src/asciiMap.js (bin/map-run.js). Eight diverse design
// personas each critique the CURRENT map and propose a refined full-frame
// redesign; a lone synthesizer reconciles them into one recommended design +
// a prioritized, implementable change list.
//
//   node runner/bin/run-workflow.js polish-ascii-map.workflow.js --frontier --auto-effort \
//     --sandbox read-only --budget 8000000

export const meta = {
  name: "polish-ascii-map",
  description: "Diverse multi-persona critique + synthesis to visually polish the workflow ASCII map",
  phases: [
    { title: "Critique", detail: "8 design personas critique + propose a redesign in parallel" },
    { title: "Synthesize", detail: "reconcile into one recommended design + change list" },
  ],
};

// ── the artifact under review ───────────────────────────────────────────────
const CURRENT_COMPLETED = `
╭─ ◆ market-news ────────────────────────────────────────────────────────╮
│ 6 agents · 2 phases · 701k tok · 20m27s · gpt-5.5                      │
│ Fed, jobs and AI earnings kept stocks near records, but June 3 closing │
│ levels were not yet final at midday.                                   │
╰────────────────────────────────────────────────────────────────────────╯
  │
  ▼ ① Gather ───────────────────────────────────  5 agents · 622k tok · 17m38s
  ├─✓ indices    5.5  high     52k tok  1m26s
  │   S&P 500 rose 0.4% to a record 6,012; Nasdaq +0.6% and Dow +0.3% at the
  │   June 2 close.
  ├─✓ movers     5.5  high    140k tok  5m16s
  │   Nvidia gained ~3% on AI demand; a major retailer slid 8% after cutting
  │   guidance.
  ├─✓ sectors    5.5  high    166k tok  3m27s
  │   Technology and communication services led; energy and utilities lagged.
  ├─✓ macro      5.5  high    136k tok  4m02s
  │   The 10-year yield eased toward 4.2% as cooler jobs data kept a July cut
  │   in play.
  ╰─✓ catalysts  5.5  high    128k tok  3m27s
      Several megacap earnings beat after the bell; Fed speakers stayed
      data-dependent.
  ┄┄┄┄┄┄┄┄┄┄ barrier ┄┄┄┄┄┄┄┄┄┄┄
  ▼ ② Synthesize ──────────────────────────────────  1 agent · 79k tok · 2m49s
  ╰─✓ brief      5.5  xhigh    79k tok  2m49s
      Fed, jobs and AI earnings kept stocks near records into June 3.
  │
  ▼
╭─ ✦ result ─────────────────────────────────────────────────────────────╮
│ Fed, jobs and AI earnings kept stocks near records, but June 3 closing │
│ levels were not yet final at midday.                                   │
╰────────────────────────────────────────────────────────────────────────╯
`.trim();

const CURRENT_MIDRUN = `
╭─ ◆ market-news ────────────────────────────────────────────────────────╮
│ 2 done · 3 running · 1 phase · 218k tok · 4m53s · gpt-5.5              │
╰────────────────────────────────────────────────────────────────────────╯
  │
  ▼ ① Gather ──────────────────────────  2 done · 3 running · 218k tok · 4m53s
  ├─✓ indices    5.5  high     52k tok  1m26s
  │   S&P 500 rose 0.4% to a record 6,012; Nasdaq +0.6% and Dow +0.3% at the
  │   June 2 close.
  ├─✓ sectors    5.5  high    166k tok  3m27s
  │   Technology and communication services led; energy and utilities lagged.
  ├─⠋ movers     5.5  high   6m00s running…
  ├─⠋ macro      5.5  high   6m00s running…
  ╰─⠋ catalysts  5.5  high   6m00s running…
  │
  ▼
╭─ ✦ result ─────────────────────────────────────────────────────────────╮
│ in progress…                                                           │
╰────────────────────────────────────────────────────────────────────────╯
`.trim();

const CONSTRAINTS = [
  "Rendered by runner/src/asciiMap.js (you MAY read it — read-only sandbox, cwd = repo root) and driven by bin/map-run.js.",
  "Pure text in a monospace terminal, typically 80–100 columns wide, variable height. Unicode/box-drawing is allowed and encouraged.",
  "Optional ANSI color, BUT it must look excellent with --no-color / NO_COLOR (pure monochrome) — never rely on color alone for meaning.",
  "Live --watch mode redraws the WHOLE frame in place ~4x/sec on the alternate screen; it must fit the terminal height (per-agent snippets auto-drop when too tall). Keep redraws calm (avoid heavy churn).",
  "Alignment must be EXACT in monospace — beware multi-codepoint or East-Asian-wide glyphs (✓ ◆ ✦ ▼ · ─ │ ╭ ╰ ⠋ are width-1 in common terminals; emoji are width-2 and banned).",
  "It must read as a GRAPH/DAG: orchestrator node → phase layers → agent nodes (branch edges) → barriers → result node. Show per agent: status (✓ done / spinner running), model, effort, tokens, wall-time, and a 1–2 sentence snippet of the result.",
  "Audience: developers watching a multi-agent run. Bar is an elite TUI (btop / lazygit / k9s): scannable at a glance, professional, calm, graph-like.",
].join("\n- ");

// ── 8 diverse design personas ───────────────────────────────────────────────
const PERSONAS = [
  { key: "typographer", brief: "a Unicode & monospace typography expert. Obsess over box-drawing correctness, consistent corners/joints, exact column alignment, baseline grid, glyph width pitfalls, and which separator/arrow/branch characters are most legible and consistent." },
  { key: "tui-craft", brief: "an elite TUI craftsperson who built tools like btop, lazygit and k9s. Apply what world-class terminal UIs do: panel framing, subtle separators, restrained status color, visual hierarchy, density vs breathing room, and focus." },
  { key: "info-designer", brief: "an information designer in the Tufte tradition. Maximize data-ink ratio: align numeric columns (tokens/time), kill redundancy, make status/tokens/time scannable, and consider micro-encodings (e.g. a tiny bar for elapsed/effort) without clutter." },
  { key: "dag-viz", brief: "a graph/DAG visualization specialist. Make flow and structure read instantly: clear nodes vs edges, fan-out/convergence, layer boundaries, arrows, and how a viewer's eye traces orchestrator → phases → result." },
  { key: "a11y-mono", brief: "an accessibility & monochrome specialist. The map MUST be perfectly legible with NO color (NO_COLOR) and for colorblind users. Encode meaning in glyphs/shape/weight, ensure contrast, and avoid color-only signals." },
  { key: "minimalist", brief: "a ruthless minimalist (Dieter Rams / geohot sensibility). Remove everything non-essential. Every glyph must earn its place. Calm, quiet, uncluttered — but still complete and graph-like." },
  { key: "ascii-artist", brief: "a demoscene ASCII/box-drawing artist. Bring refined craft to the connectors, corners, arrows and node framing — elegant and polished, with tasteful flair that never becomes noise." },
  { key: "liveops", brief: "a live-ops dashboard designer. Optimize the --watch live feel: instant running-vs-done clarity, where the eye goes as agents flip to ✓, tasteful motion (spinner), progress legibility, and at-a-glance run health." },
];

const CRITIQUE = {
  type: "object",
  additionalProperties: false,
  required: ["persona", "verdict", "top_issues", "proposed_map", "specific_changes", "one_big_idea"],
  properties: {
    persona: { type: "string" },
    verdict: { type: "string", description: "one-line overall take on the current map" },
    top_issues: {
      type: "array",
      description: "the most important problems from your lens",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "issue", "severity", "fix"],
        properties: {
          area: { type: "string", description: "e.g. boxes, edges, alignment, color, spacing, snippets, typography" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          fix: { type: "string", description: "the concrete change" },
        },
      },
    },
    proposed_map: { type: "string", description: "a COMPLETE redesigned frame as monospace ASCII (your improved version of the completed-run map). Keep ~84 cols. Show exact characters." },
    specific_changes: { type: "array", items: { type: "string", description: "concrete, implementable change (specific characters, spacing, columns, color rules, layout)" } },
    one_big_idea: { type: "string", description: "the single highest-impact change you'd make" },
  },
};

phase("Critique");
const critiques = await parallel(
  PERSONAS.map((p) => () =>
    agent(
      `You are ${p.brief}\n\n` +
        `Critique and visually polish this terminal ASCII workflow map. You may read runner/src/asciiMap.js (the renderer) to ground your proposal in what's implementable.\n\n` +
        `CONSTRAINTS:\n- ${CONSTRAINTS}\n\n` +
        `CURRENT MAP — completed run:\n\n${CURRENT_COMPLETED}\n\n` +
        `CURRENT MAP — mid-run (live):\n\n${CURRENT_MIDRUN}\n\n` +
        `From YOUR perspective, give your sharpest critique and propose a concretely improved full-frame redesign (exact monospace characters, ~84 cols). Be specific and implementable; avoid generic advice.`,
      { label: "critique:" + p.key, sandbox: "read-only", schema: CRITIQUE },
    ),
  ),
);
const valid = critiques.filter(Boolean);
log(`collected ${valid.length}/${PERSONAS.length} persona critiques`);

phase("Synthesize");
const SYNTH = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "recommended_map", "prioritized_changes", "conflicts_resolved", "dropped"],
  properties: {
    headline: { type: "string", description: "the core recommendation in one line" },
    recommended_map: { type: "string", description: "ONE consolidated, best-of-all redesigned frame as monospace ASCII (~84 cols), exact characters — the design to implement" },
    prioritized_changes: {
      type: "array",
      description: "ordered, implementable changes to runner/src/asciiMap.js",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["change", "why", "effort", "impact"],
        properties: {
          change: { type: "string" },
          why: { type: "string" },
          effort: { type: "string", enum: ["S", "M", "L"] },
          impact: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    conflicts_resolved: { type: "array", items: { type: "string", description: "where personas disagreed and how you decided" } },
    dropped: { type: "array", items: { type: "string", description: "ideas considered and rejected, with why" } },
  },
};
const synthesis = await agent(
  `You are a principal terminal-UI designer consolidating ${valid.length} persona critiques into ONE polished design for the workflow ASCII map.\n\n` +
    `Constraints (unchanged):\n- ${CONSTRAINTS}\n\n` +
    `Reconcile the proposals: keep what's genuinely better, resolve conflicts decisively, and drop gimmicks. Produce ONE recommended full-frame redesign (exact monospace, ~84 cols) and an ordered, implementable change list for runner/src/asciiMap.js. Favor high-impact, low-risk polish; keep it calm and graph-like; it must stay perfect in --no-color.\n\n` +
    `PERSONA CRITIQUES:\n\n` +
    valid
      .map((c, i) => `### [${i + 1}] ${c.persona}\nVerdict: ${c.verdict}\nBig idea: ${c.one_big_idea}\nTop issues: ${(c.top_issues || []).map((t) => `(${t.severity}) ${t.area}: ${t.issue} → ${t.fix}`).join(" | ")}\nChanges: ${(c.specific_changes || []).join(" · ")}\nProposed map:\n${c.proposed_map}`)
      .join("\n\n"),
  { label: "synthesize:design", schema: SYNTH },
);

return { synthesis, persona_count: valid.length, critiques: valid };
