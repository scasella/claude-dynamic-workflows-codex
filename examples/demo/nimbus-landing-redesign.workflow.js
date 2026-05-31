// A complete, self-contained demo workflow over a FICTIONAL product ("Nimbus").
// It ships with a pre-baked result journal so you can open the viewer with no
// Codex calls:
//
//   node runner/bin/view-run.js examples/demo --open
//
// To run it for real against your local Codex App Server:
//
//   node runner/bin/run-workflow.js examples/demo/nimbus-landing-redesign.workflow.js --frontier
//
// Shape: Audit (2 lenses) → Concept (3 directions) → Judge (2 personas) →
// Synthesize (1). A barrier between phases: concepts read the full audit, judges
// read all concepts, synthesis reads everything.

export const meta = {
  name: "nimbus-landing-redesign",
  description: "Audit a fictional SaaS landing page and propose ranked, commercially-appealing redesign concepts",
  phases: [
    { title: "Audit", detail: "two lenses critique the current page for commercial appeal" },
    { title: "Concept", detail: "three distinct redesign directions, each a full concept" },
    { title: "Judge", detail: "two personas rank the concepts" },
    { title: "Synthesize", detail: "final recommendation + build roadmap" },
  ],
};

const BRIEF = `
PRODUCT: "Nimbus" — a fictional API analytics dashboard for developer teams. It
shows request volume, latency percentiles, and error rates across a team's APIs.
CURRENT PAGE: a dense feature wall — a hero that just says "API analytics, done
right", a grid of 9 feature cards, and a footer. No clear value proposition, no
pricing, a single weak "Sign up" button, and no proof or social validation.
GOAL: propose redesign directions optimized for commercial appeal — communicate
value fast, build trust, and convert a cold visitor — while keeping the live
dashboard as the interactive proof.`;

/* ── schemas ─────────────────────────────────────────────────────────────── */
const sev = { type: "string", enum: ["high", "medium", "low"] };
const AUDIT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["lens", "one_line_verdict", "strengths_to_keep", "problems", "opportunities"],
  properties: {
    lens: { type: "string" }, one_line_verdict: { type: "string" },
    strengths_to_keep: { type: "array", items: { type: "string" } },
    problems: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["issue", "commercial_cost", "severity"],
      properties: { issue: { type: "string" }, commercial_cost: { type: "string" }, severity: sev } } },
    opportunities: { type: "array", items: { type: "string" } },
  },
};
const VISUAL = { type: "object", additionalProperties: false,
  required: ["mood", "palette", "typography", "layout", "motion"],
  properties: { mood: { type: "string" }, palette: { type: "array", items: { type: "string" } },
    typography: { type: "string" }, layout: { type: "string" }, motion: { type: "string" } } };
const HERO = { type: "object", additionalProperties: false,
  required: ["headline", "subhead", "primary_cta", "secondary_cta", "visual"],
  properties: { headline: { type: "string" }, subhead: { type: "string" },
    primary_cta: { type: "string" }, secondary_cta: { type: "string" }, visual: { type: "string" } } };
const SECTIONS = { type: "array", items: { type: "object", additionalProperties: false,
  required: ["section", "purpose", "content"],
  properties: { section: { type: "string" }, purpose: { type: "string" }, content: { type: "string" } } } };
const CONCEPT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["concept_name", "tagline", "positioning_statement", "target_buyer", "big_idea",
    "visual_system", "hero", "page_sections", "monetization", "why_commercial", "feasibility", "risks"],
  properties: {
    concept_name: { type: "string" }, tagline: { type: "string" }, positioning_statement: { type: "string" },
    target_buyer: { type: "string" }, big_idea: { type: "string" }, visual_system: VISUAL, hero: HERO,
    page_sections: SECTIONS, monetization: { type: "string" }, why_commercial: { type: "string" },
    feasibility: { type: "string" }, risks: { type: "array", items: { type: "string" } },
  },
};
const RANKING_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["persona", "scores", "ranking_best_to_worst", "top_pick", "best_idea_to_steal"],
  properties: {
    persona: { type: "string" },
    scores: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["concept_name", "commercial_appeal", "differentiation", "feasibility", "brand", "rationale"],
      properties: { concept_name: { type: "string" }, commercial_appeal: { type: "integer" },
        differentiation: { type: "integer" }, feasibility: { type: "integer" }, brand: { type: "integer" },
        rationale: { type: "string" } } } },
    ranking_best_to_worst: { type: "array", items: { type: "string" } },
    top_pick: { type: "string" }, best_idea_to_steal: { type: "string" },
  },
};
const FINAL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["recommended_direction", "why_this_wins", "positioning_statement", "hero", "visual_system",
    "page_blueprint", "grafted_ideas", "monetization_plan", "build_roadmap", "risks_and_guardrails"],
  properties: {
    recommended_direction: { type: "string" }, why_this_wins: { type: "string" },
    positioning_statement: { type: "string" }, hero: HERO, visual_system: VISUAL, page_blueprint: SECTIONS,
    grafted_ideas: { type: "array", items: { type: "string" } }, monetization_plan: { type: "string" },
    build_roadmap: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["phase", "change", "commercial_impact", "effort"],
      properties: { phase: { type: "string" }, change: { type: "string" },
        commercial_impact: { type: "string" }, effort: { type: "string", enum: ["S", "M", "L"] } } } },
    risks_and_guardrails: { type: "array", items: { type: "string" } },
  },
};

/* ── inputs ──────────────────────────────────────────────────────────────── */
const LENSES = [
  { key: "conversion", title: "Conversion strategist", focus: "value-prop clarity, CTA strength, lead capture, pricing visibility, and the funnel from cold visitor to signup" },
  { key: "visual", title: "Brand & visual designer", focus: "hierarchy, typography, spacing, and whether it reads as a premium paid product vs a generic template" },
];
const DIRECTIONS = [
  { key: "minimal", name: "Quiet Confidence", seed: "Editorial minimalism: one sharp value prop, generous whitespace, a single live chart as proof, one primary CTA." },
  { key: "bold", name: "Bold Signal", seed: "High-contrast, opinionated brand: a punchy headline, big numbers, vivid accent color, social proof above the fold." },
  { key: "editorial", name: "Developer Editorial", seed: "Docs-forward: lead with a live code snippet hitting the API, a metered free tier, and a quickstart — sell to engineers directly." },
];
const JUDGES = [
  { key: "growth", persona: "a growth lead who cares only whether a cold visitor understands the value in 5 seconds and is moved to act" },
  { key: "designer", persona: "a design director who cares about taste and whether it looks like a premium paid product rather than generic AI-generated SaaS" },
];

/* ── prompts ─────────────────────────────────────────────────────────────── */
const auditPrompt = (l) => `${BRIEF}\n\nROLE: ${l.title}. Audit the CURRENT Nimbus landing page through your lens (${l.focus}) for one purpose: making it commercially appealing. Be concrete; prioritize problems by commercial impact.`;
const conceptPrompt = (d, audit) => `${BRIEF}\n\nYou are a product designer + brand strategist. Using the audit below, design ONE complete, distinct redesign concept along this direction — "${d.name}": ${d.seed}\n\nAUDIT:\n${audit}\n\nSpecify a real visual system (palette as hex + role, type, layout, motion), the hero, a top-to-bottom page structure, and a monetization strategy. Differentiate from the other directions.`;
const judgePrompt = (j, concepts, audit) => `You are ${j.persona}.\n\nAUDIT:\n${audit}\n\nCONCEPTS:\n${concepts}\n\nScore each concept 1-10 on commercial_appeal, differentiation, feasibility, and brand. Rank them, pick a winner, and name the single best idea to steal into the winner.`;
const synthPrompt = (audit, concepts, judges) => `${BRIEF}\n\nYou are the lead design director making the final call. Using the audit, concepts, and judge rankings, produce the FINAL recommendation: pick a direction (you may graft the best ideas from the others), with real hero copy, a section-by-section blueprint, a visual system, a monetization plan, and a phased build roadmap ordered by commercial lift.\n\nAUDIT:\n${audit}\n\nCONCEPTS:\n${concepts}\n\nJUDGES:\n${judges}`;

/* ── orchestration (barrier-structured) ──────────────────────────────────── */
phase("Audit");
const audits = (await parallel(LENSES.map((l) => () =>
  agent(auditPrompt(l), { schema: AUDIT_SCHEMA, label: `audit:${l.key}`, phase: "Audit", model: "gpt-5.4", effort: "medium" })))).filter(Boolean);
const auditDigest = JSON.stringify(audits, null, 2);
log(`Audit complete — ${audits.length}/${LENSES.length} lenses`);

phase("Concept");
const concepts = (await parallel(DIRECTIONS.map((d) => () =>
  agent(conceptPrompt(d, auditDigest), { schema: CONCEPT_SCHEMA, label: `concept:${d.key}`, phase: "Concept", model: "gpt-5.5", effort: "high" })))).filter(Boolean);
const conceptsDigest = JSON.stringify(concepts, null, 2);
log(`Concepts generated — ${concepts.length}/${DIRECTIONS.length} directions`);

phase("Judge");
const judges = (await parallel(JUDGES.map((j) => () =>
  agent(judgePrompt(j, conceptsDigest, auditDigest), { schema: RANKING_SCHEMA, label: `judge:${j.key}`, phase: "Judge", model: "gpt-5.4", effort: "medium" })))).filter(Boolean);
const judgesDigest = JSON.stringify(judges, null, 2);
log(`Judging complete — ${judges.length}/${JUDGES.length} panels`);

phase("Synthesize");
const recommendation = await agent(synthPrompt(auditDigest, conceptsDigest, judgesDigest),
  { schema: FINAL_SCHEMA, label: "synthesize", phase: "Synthesize", model: "gpt-5.5", effort: "high" });

return { audits, concepts, judges, recommendation };
