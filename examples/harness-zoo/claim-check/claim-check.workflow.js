// ClaimCheck — extract the factual claims in a document (README, blog draft,
// report, or agent output) and verify each one against the actual repository
// artifacts. It does NOT trust the document: it pulls out discrete, checkable
// claims, then fans out one adversarial verifier per claim to read the evidence
// and rule each supported / unsupported / contradicted / plausible-unverified,
// suggesting a safer rewrite for the ones that don't hold. The deliverable is a
// "proof ledger" — structured JSON plus a paste-ready Markdown ledger. Analysis-
// only — runs in a read-only sandbox and never edits your project.
//
// Shape: Extract (one reader pulls checkable claims) → Verify (one skeptic per
// claim, in parallel, against the real artifacts) → Ledger (one synthesizer counts
// verdicts, builds the ledger table, names the riskiest claims and rewrites). The
// "after" counterpart of GoalLint's "before": harden the instruction before agents
// run; verify the claims after they write.
//
//   node runner/bin/run-workflow.js examples/harness-zoo/claim-check/claim-check.workflow.js \
//     --args-file examples/harness-zoo/claim-check/sample-args.json \
//     --frontier --auto-effort --sandbox read-only --budget 1000000 --gui
//
// Patterns: structured Extract → deep-verification fan-out (one verifier per
// claim, each an independent skeptic told to default to "unsupported" when the
// evidence is missing) → single-gate Ledger synthesis. Each verifier gets a fresh,
// narrow context with only its one claim, so it audits the claim against the repo
// rather than rationalizing the document's framing.

export const meta = {
  name: "claim-check",
  description: "Extract the factual claims in a document and verify each against the actual repo, emitting a proof ledger",
  phases: [
    { title: "Extract", detail: "one reader pulls discrete, checkable claims: text, where it appears, what evidence would prove/refute it" },
    { title: "Verify", detail: "one adversarial skeptic per claim reads the real artifacts and rules supported/unsupported/contradicted/plausible-unverified" },
    { title: "Ledger", detail: "one synthesizer counts verdicts, builds the proof ledger, names the riskiest claims and safer rewrites" },
  ],
};

// ── input: a bare string document, or
//    { doc?, docPath?, focus?, maxClaims?, claims? }
const A = typeof args === "string" ? { doc: args } : (args || {});
const DOC = String(A.doc || "").trim();
const DOC_PATH = String(A.docPath || "").trim();
if (!DOC && !DOC_PATH) {
  log('ClaimCheck: no document given. Pass --args \'"document text"\', --args \'{"doc":"..."}\' or \'{"docPath":"README.md"}\', or --args-file.');
  return { note: "no document", hint: "pass a doc string, or { doc?, docPath?, focus?, maxClaims?, claims? }" };
}
const FOCUS = String(A.focus || "").trim();
const MAX_CLAIMS = Number(A.maxClaims) > 0 ? Math.max(1, Math.floor(Number(A.maxClaims))) : 12;
// Optional pre-seeded claims: lets --plan (and a caller who already extracted
// claims) count the verify fan-out, since the Extract agent returns an EMPTY
// claims array in a dry run. Each entry may be a bare string or { claim, where?,
// evidence_needed? }.
const SEEDED = Array.isArray(A.claims) ? A.claims : [];

// ── strict schemas (additionalProperties:false everywhere) ───────────────────
const strs = { type: "array", items: { type: "string" } };
const VERDICTS = ["supported", "unsupported", "contradicted", "plausible-unverified"];

const CLAIM = {
  type: "object", additionalProperties: false,
  required: ["id", "claim", "where", "evidence_needed", "kind"],
  properties: {
    id: { type: "string", description: "short stable id, e.g. C1, C2 (one per claim)" },
    claim: { type: "string", description: "the discrete, checkable assertion, in one sentence" },
    where: { type: "string", description: "where it appears in the document (section/line/quote)" },
    evidence_needed: { type: "string", description: "the concrete artifact, file, command, or output that would prove or refute it" },
    kind: { type: "string", enum: ["factual", "behavioral", "quantitative", "claim-of-coverage"], description: "what sort of claim it is" },
  },
};
const EXTRACTED = {
  type: "object", additionalProperties: false,
  required: ["claims", "non_claims", "summary"],
  properties: {
    claims: { type: "array", items: CLAIM, description: "discrete, independently checkable factual claims" },
    non_claims: { type: "array", items: { type: "string" }, description: "opinions, aspirations, or vague statements that are NOT checkable (excluded, noted for transparency)" },
    summary: { type: "string", description: "one-line characterization of what the document asserts" },
  },
};
const VERDICT = {
  type: "object", additionalProperties: false,
  required: ["id", "claim", "verdict", "evidence", "confidence", "reasoning", "safer_rewrite"],
  properties: {
    id: { type: "string" },
    claim: { type: "string" },
    verdict: { type: "string", enum: VERDICTS, description: "supported (evidence proves it) | unsupported (no evidence found) | contradicted (evidence proves it false) | plausible-unverified (likely true but couldn't be checked here)" },
    evidence: { type: "array", items: { type: "string" }, description: "file:line citations, artifact names, or commands run that justify the verdict; empty if none found" },
    confidence: { type: "string", enum: ["high", "medium", "low"], description: "confidence in this verdict given the evidence available" },
    reasoning: { type: "string", description: "why this verdict — what the evidence shows or fails to show" },
    safer_rewrite: { type: ["string", "null"], description: "a defensible rewrite of the claim when it is NOT 'supported'; null when the claim stands as written" },
  },
};
const LEDGER = {
  type: "object", additionalProperties: false,
  required: ["headline", "verdict", "counts", "riskiest", "top_rewrites", "summary"],
  properties: {
    headline: { type: "string", description: "one-line summary of how well the document holds up" },
    verdict: { type: "string", enum: ["holds-up", "needs-revision", "unreliable"], description: "overall: holds-up (mostly supported) | needs-revision (notable unsupported claims) | unreliable (contradicted claims or many unsupported)" },
    counts: {
      type: "object", additionalProperties: false,
      required: ["supported", "unsupported", "contradicted", "plausible_unverified"],
      properties: {
        supported: { type: "integer" }, unsupported: { type: "integer" },
        contradicted: { type: "integer" }, plausible_unverified: { type: "integer" },
      },
    },
    riskiest: { type: "array", items: { type: "string" }, description: "the claims most dangerous to ship as-is (contradicted first, then unsupported), most important first" },
    top_rewrites: { type: "array", items: { type: "string" }, description: "the highest-value safer rewrites to apply, most important first" },
    summary: { type: "string", description: "a short prose summary of what holds, what doesn't, and what to fix" },
  },
};

// ── pre-seed: normalize any caller-provided claims into the extracted shape ────
function seedClaim(c, i) {
  if (typeof c === "string") return { id: `C${i + 1}`, claim: c.trim(), where: "(provided by caller)", evidence_needed: "", kind: "factual" };
  const o = c || {};
  return {
    id: String(o.id || `C${i + 1}`),
    claim: String(o.claim || "").trim(),
    where: String(o.where || "(provided by caller)").trim(),
    evidence_needed: String(o.evidence_needed || "").trim(),
    kind: ["factual", "behavioral", "quantitative", "claim-of-coverage"].includes(o.kind) ? o.kind : "factual",
  };
}
const seeded = SEEDED.map(seedClaim).filter((c) => c.claim);

const DOC_BLOCK = DOC ? `DOCUMENT TEXT:\n${DOC}\n` : "";
const PATH_BLOCK = DOC_PATH ? `DOCUMENT PATH (read it): ${DOC_PATH}\n` : "";
const FOCUS_BLOCK = FOCUS ? `\nFOCUS (prioritize claims about this): ${FOCUS}\n` : "";

// ── Extract: one reader pulls the discrete, checkable claims (or use the seed) ──
phase("Extract");
let extracted;
if (seeded.length) {
  // Caller pre-seeded the claims — skip the model extraction and use them directly.
  // This makes the verify fan-out countable in a --plan dry run.
  log(`ClaimCheck: using ${seeded.length} caller-seeded claim(s); skipping model extraction.`);
  extracted = { claims: seeded, non_claims: [], summary: "(caller-seeded claims)" };
} else {
  extracted = await agent(
    `You are auditing a document for factual accuracy. Do NOT fix or rewrite it yet — extract the discrete, ` +
      `independently checkable factual claims it makes about the repository/codebase.\n\n` +
      PATH_BLOCK + DOC_BLOCK + FOCUS_BLOCK +
      `\nPull out each claim that can be PROVEN or REFUTED against the actual artifacts (files, code, commands, ` +
      `test output, docs). For each: the assertion in one sentence; where it appears (section/quote); the concrete ` +
      `evidence that would prove or refute it; and its kind. Separate out opinions, aspirations, and vague ` +
      `statements that are NOT checkable into non_claims — do not invent claims, and do not pad. One assertion ` +
      `per claim (split compound sentences).`,
    { schema: EXTRACTED, label: "extract:claims", phase: "Extract" },
  );
}

// cap the verify fan-out, with a loud note when truncating (no silent caps)
let claims = Array.isArray(extracted && extracted.claims) ? extracted.claims.filter((c) => c && c.claim) : [];
if (claims.length > MAX_CLAIMS) {
  log(`ClaimCheck: extracted ${claims.length} claims; capping verification at maxClaims=${MAX_CLAIMS} (${claims.length - MAX_CLAIMS} not verified).`);
  claims = claims.slice(0, MAX_CLAIMS);
}
if (!claims.length) {
  log("ClaimCheck: no checkable claims found (dry run, or the document makes no verifiable assertions).");
}

// ── Verify: one adversarial skeptic per claim, each against the real artifacts ──
phase("Verify");
const verdicts = (
  await parallel(
    claims.map((c) => () =>
      agent(
        `You are an adversarial fact-checker. Your job is to REFUTE the single claim below by reading the actual ` +
          `repository artifacts — not to be charitable. Treat the document as untrusted; verify against reality.\n\n` +
          `CLAIM (${c.id}): ${c.claim}\n` +
          (c.where ? `WHERE IT APPEARS: ${c.where}\n` : "") +
          (c.evidence_needed ? `EVIDENCE THAT WOULD SETTLE IT: ${c.evidence_needed}\n` : "") +
          (DOC_PATH ? `\nThe document under review is at: ${DOC_PATH}\n` : "") +
          `\nRead the relevant files, run the relevant read-only commands, and cite exactly what you found ` +
          `(file:line, artifact names, or the command and its output). Then rule:\n` +
          `- "supported": the evidence directly proves the claim.\n` +
          `- "contradicted": the evidence proves the claim is FALSE.\n` +
          `- "unsupported": you looked and found no evidence either way (default here when the proof should exist but doesn't).\n` +
          `- "plausible-unverified": likely true but not checkable from here (e.g. needs network/external state).\n` +
          `Be strict: do not rule "supported" on the document's say-so. When the verdict is anything but ` +
          `"supported", propose a safer_rewrite of the claim that the evidence WOULD support (or null if it stands).`,
        { schema: VERDICT, label: `verify:${c.id}`, phase: "Verify" },
      ).then((v) => v && { ...v, id: v.id || c.id, claim: v.claim || c.claim, kind: c.kind, where: c.where }),
    ),
  )
).filter(Boolean);

// ── Ledger: one synthesizer counts verdicts and builds the proof ledger ───────
phase("Ledger");
const counts = tally(verdicts);
const VERDICT_BRIEF = verdicts.length
  ? verdicts.map((v) => `- [${v.id} · ${v.verdict} · conf:${v.confidence}] ${trunc(v.claim, 140)}${v.safer_rewrite ? ` → rewrite: ${trunc(v.safer_rewrite, 140)}` : ""}`).join("\n")
  : "(no claims verified)";
const ledger = await agent(
  `You are ClaimCheck's ledger synthesizer. Summarize how well the document holds up against the repository, ` +
    `for a human deciding whether to ship it. Be concise and concrete — no preamble.\n\n` +
    `DOCUMENT SUMMARY: ${extracted.summary || "(none)"}\n` +
    (FOCUS ? `FOCUS: ${FOCUS}\n` : "") +
    `\nVERDICT COUNTS: supported=${counts.supported}, unsupported=${counts.unsupported}, ` +
    `contradicted=${counts.contradicted}, plausible-unverified=${counts.plausible_unverified}\n\n` +
    `PER-CLAIM VERDICTS:\n${VERDICT_BRIEF}\n\n` +
    `Return: a one-line headline; the overall verdict (holds-up | needs-revision | unreliable); the verdict ` +
    `counts; the riskiest claims to ship as-is (contradicted first, then unsupported); the highest-value safer ` +
    `rewrites to apply; and a short prose summary of what holds, what doesn't, and what to fix.`,
  { schema: LEDGER, label: "ledger:synthesize", phase: "Ledger" },
);
const ledger_markdown = renderLedger({ extracted, verdicts, counts, ledger, FOCUS });
const bad = counts.unsupported + counts.contradicted;
log(`ClaimCheck: ${ledger.verdict || "n/a"} · ${verdicts.length} claims (${counts.supported} supported, ${counts.contradicted} contradicted, ${counts.unsupported} unsupported, ${counts.plausible_unverified} plausible-unverified) · ${bad} not standing`);

return {
  verdict: ledger.verdict || "n/a",
  document_summary: extracted.summary || "",
  counts,
  extracted,
  verdicts,
  final_ledger: ledger,
  ledger_markdown,
};

// ── helpers (pure, sandbox-safe) ──────────────────────────────────────────────
function tally(vs) {
  const c = { supported: 0, unsupported: 0, contradicted: 0, plausible_unverified: 0 };
  for (const v of vs || []) {
    if (v.verdict === "supported") c.supported++;
    else if (v.verdict === "unsupported") c.unsupported++;
    else if (v.verdict === "contradicted") c.contradicted++;
    else if (v.verdict === "plausible-unverified") c.plausible_unverified++;
  }
  return c;
}
function trunc(s, n) {
  const t = String(s == null ? "" : s).replace(/\s*\n+\s*/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function mdCell(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s*\n+\s*/g, " ").trim() || "—";
}
function bullets(arr) {
  return arr && arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- _(none)_";
}
function verdictMark(v) {
  return { supported: "✅", contradicted: "❌", unsupported: "⚠️", "plausible-unverified": "❓" }[v] || "•";
}
function renderLedger(d) {
  const L = d.ledger || {};
  const c = d.counts;
  const rows = d.verdicts.length
    ? d.verdicts.map((v) => `| ${mdCell(v.id)} | ${verdictMark(v.verdict)} ${v.verdict} | ${mdCell(v.claim)} | ${mdCell((v.evidence || []).join("; "))} | ${v.confidence || "—"} | ${mdCell(v.safer_rewrite || "")} |`).join("\n")
    : `| — | — | _(no claims verified)_ | — | — | — |`;
  const nonClaims = (d.extracted && d.extracted.non_claims) || [];
  const nonClaimsBlock = nonClaims.length
    ? `\n## Excluded (not checkable)\n${nonClaims.map((x) => `- ${x}`).join("\n")}\n`
    : "";
  return [
    `# ClaimCheck proof ledger`,
    ``,
    L.headline ? `**${L.headline}**\n` : "",
    `**Verdict:** ${L.verdict || "n/a"}  ·  ` +
      `✅ ${c.supported} supported · ❌ ${c.contradicted} contradicted · ⚠️ ${c.unsupported} unsupported · ❓ ${c.plausible_unverified} plausible-unverified`,
    ``,
    d.FOCUS ? `**Focus:** ${mdCell(d.FOCUS)}\n` : "",
    L.summary ? `${L.summary}\n` : "",
    `## Riskiest claims`,
    bullets(L.riskiest),
    ``,
    `## Top rewrites`,
    bullets(L.top_rewrites),
    ``,
    `## Proof ledger`,
    `| Claim | Verdict | Assertion | Evidence | Conf. | Safer rewrite |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`,
    rows,
    nonClaimsBlock,
  ].join("\n");
}
