// Deep research over a codebase — the shape of Claude Code's bundled
// /deep-research workflow, re-hosted on Codex: fan out investigators across
// several angles, cross-check (vote on) every claim they surface, then a single
// synthesizer writes a cited report from only the claims that survived.
//
// This version researches a CODE question in a read-only repo sandbox, so it runs
// anywhere without web access. For a web-enabled variant, change the investigator
// instructions to "search the web and fetch sources" (requires a Codex with web
// tools) — the fan-out / verify / synthesize structure is identical.
//
//   node runner/bin/run-workflow.js examples/deep-research.workflow.js --frontier --auto-effort --sandbox read-only \
//     --args '{"question":"How is auth enforced across routes?","dir":"src"}'

export const meta = {
  name: "deep-research",
  description: "Fan-out investigation → cross-check each claim → cited synthesis report",
  phases: [
    { title: "Investigate", detail: "one reader per angle, returns cited claims" },
    { title: "Verify", detail: "a skeptic cross-checks each claim against the code" },
    { title: "Report", detail: "one synthesizer writes the cited report" },
  ],
};

const QUESTION = (args && args.question) || "";
const DIR = (args && args.dir) || ".";
const ANGLES = (args && Array.isArray(args.angles) && args.angles.length)
  ? args.angles
  : [
      "the primary code paths and entry points",
      "edge cases, error handling, and failure modes",
      "tests, configuration, and how it's exercised",
      "assumptions, gaps, and anything surprising or risky",
    ];

if (!QUESTION) {
  log('deep-research needs a question. Pass --args \'{"question":"...","dir":"src"}\'.');
  return { note: "no question" };
}

const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence", "files"],
        properties: {
          claim: { type: "string" },
          evidence: { type: "string", description: "what in the code supports it" },
          files: { type: "array", items: { type: "string", description: "path or path:line" } },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reason"],
  properties: {
    real: { type: "boolean", description: "true only if the code actually supports the claim" },
    reason: { type: "string" },
    correction: { type: "string", description: "if not real, what's actually true" },
  },
};

// Investigate: each angle is read independently (a multi-modal sweep — each reader
// is blind to what the others find).
phase("Investigate");
const investigations = await parallel(
  ANGLES.map((angle, i) => () =>
    agent(
      `Research this question about the code under "${DIR}": ${QUESTION}\n\n` +
        `Focus on ${angle}. Read the relevant files and return concrete, checkable claims, each with the ` +
        `evidence and the file path(s) (path:line where you can). Prefer few well-supported claims over many.`,
      { label: `investigate:angle-${i + 1}`, sandbox: "read-only", schema: CLAIMS_SCHEMA },
    ),
  ),
);

// Flatten + lightly dedupe claims by normalized text before the (costly) verify.
const seen = new Set();
const claims = [];
for (const inv of investigations.filter(Boolean)) {
  for (const c of inv.claims || []) {
    const key = c.claim.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(c);
  }
}
log(`investigation surfaced ${claims.length} distinct claims`);
if (!claims.length) return { question: QUESTION, report: "No claims surfaced.", verified: [], dropped: 0 };

// Verify: a skeptic cross-checks each claim against the code, defaulting to refuted
// when unsure (adversarial verification — kills plausible-but-unsupported claims).
phase("Verify");
const verdicts = await parallel(
  claims.map((c) => () =>
    agent(
      `Cross-check this claim against the code under "${DIR}". Open the cited files and confirm it. ` +
        `Set real=false if the code does not clearly support it (default to false when unsure).\n\n` +
        `Claim: ${c.claim}\nClaimed evidence: ${c.evidence}\nCited files: ${(c.files || []).join(", ")}`,
      { label: `verify:${c.files?.[0] || c.claim.slice(0, 24)}`, sandbox: "read-only", schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...c, verdict: v })),
  ),
);
const verified = verdicts.filter(Boolean).filter((c) => c.verdict && c.verdict.real);
const dropped = verdicts.filter(Boolean).length - verified.length;
log(`${verified.length} claims survived cross-check, ${dropped} dropped`);

// Report: one synthesizer (a lone gate → xhigh under --auto-effort) writes the
// cited report. It RETURNS the prose (per the "heavy final stage" guidance) rather
// than writing a file, so a long synthesis can't trip the per-turn timeout.
phase("Report");
const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["report", "key_findings"],
  properties: {
    report: { type: "string", description: "markdown; cite file:line inline" },
    key_findings: { type: "array", items: { type: "string" } },
  },
};
const synthesis = await agent(
  `Write a concise, well-structured answer to: ${QUESTION}\n\n` +
    `Use ONLY these verified claims (each already cross-checked against the code). Cite the files inline. ` +
    `Note any gaps the investigation did not resolve.\n\n` +
    verified.map((c, i) => `${i + 1}. ${c.claim}  [${(c.files || []).join(", ")}]`).join("\n"),
  { label: "report:synthesize", schema: REPORT_SCHEMA },
);

return {
  question: QUESTION,
  report: synthesis?.report ?? "(synthesis unavailable)",
  key_findings: synthesis?.key_findings ?? [],
  verified_claims: verified.map((c) => ({ claim: c.claim, files: c.files })),
  dropped,
};
