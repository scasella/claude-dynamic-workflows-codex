// GoalLint — harden a vague or risky agent "/goal" into a precise, testable,
// falsifiable, artifact-producing one. It does NOT attempt the goal: it lints the
// *instruction* you're about to hand a fleet of agents, and returns a hardened
// goal as structured JSON + a paste-ready Markdown report. Analysis-only — runs in
// a read-only sandbox and never edits your project.
//
// Shape: Parse → Critique (7 parallel lenses) → Rewrite → Verify (fresh gate) →
// Report (synthesize + assemble Markdown). A flagship "harness zoo" template:
// small, fast, and practical — the deliverable is a better PROMPT, not a code change.
//
//   node runner/bin/run-workflow.js examples/harness-zoo/goal-lint/goal-lint.workflow.js \
//     --args-file examples/harness-zoo/goal-lint/sample-args.json \
//     --frontier --effort medium --sandbox read-only --budget 1000000 --gui
//
// Patterns: structured Parse → perspective-diverse parallel Critique →
// single-gate Rewrite → fresh-context Verify. The verifier never saw the rewrite
// being authored, so it audits the hardened goal rather than rationalizing it.

export const meta = {
  name: "goal-lint",
  description: "Turn a vague or risky agent /goal into a precise, testable, falsifiable, artifact-producing one",
  phases: [
    { title: "Parse", detail: "extract objective, files, commands, success criteria, gaps, ambiguity" },
    { title: "Critique", detail: "7 parallel lenses: ambiguity, falsifiability, overbuild, artifact, verification, safety, scope" },
    { title: "Rewrite", detail: "produce a hardened /goal: allowed/forbidden files, commands, success/failure/stop criteria" },
    { title: "Verify", detail: "a fresh gate checks the rewrite resolves every critique" },
    { title: "Report", detail: "synthesize headline/verdict/top-actions, then assemble the paste-ready Markdown" },
  ],
};

// ── input: a bare string goal, or
//    { goal, repoContext?, allowedFiles?, forbiddenFiles?, expectedArtifacts?, maxAgents? }
const A = typeof args === "string" ? { goal: args } : (args || {});
const GOAL = String(A.goal || "").trim();
if (!GOAL) {
  log('GoalLint: no goal given. Pass --args \'"your goal"\', --args \'{"goal":"..."}\', or --args-file.');
  return { note: "no goal", hint: "pass a goal string, or { goal, repoContext?, allowedFiles?, forbiddenFiles?, expectedArtifacts?, maxAgents? }" };
}
const REPO_CONTEXT = String(A.repoContext || "").trim();
const ALLOWED = Array.isArray(A.allowedFiles) ? A.allowedFiles : [];
const FORBIDDEN = Array.isArray(A.forbiddenFiles) ? A.forbiddenFiles : [];
const EXPECTED_ARTIFACTS = Array.isArray(A.expectedArtifacts) ? A.expectedArtifacts : [];

// ── strict schemas (additionalProperties:false everywhere) ───────────────────
const sev = { type: "string", enum: ["high", "medium", "low"] };
const strs = { type: "array", items: { type: "string" } };

const PARSED = {
  type: "object", additionalProperties: false,
  required: ["objective", "implied_files", "expected_commands", "success_criteria", "missing_constraints", "ambiguities", "risk_level"],
  properties: {
    objective: { type: "string", description: "the core thing to achieve, in one sentence" },
    implied_files: strs, expected_commands: strs,
    success_criteria: strs, missing_constraints: strs, ambiguities: strs,
    risk_level: { type: "string", enum: ["high", "medium", "low"], description: "risk of handing this goal to an agent as-is" },
  },
};
const CRITIQUE = {
  type: "object", additionalProperties: false,
  required: ["lens", "finding", "severity", "failure_mode", "fix"],
  properties: {
    lens: { type: "string" },
    finding: { type: "string", description: "the single most important problem this lens exposes" },
    severity: sev,
    failure_mode: { type: "string", description: "what an agent does wrong if the goal ships as-is" },
    fix: { type: "string", description: "the concrete change to the goal that resolves it" },
  },
};
const HARDENED = {
  type: "object", additionalProperties: false,
  required: ["objective", "context", "allowed_files", "forbidden_files", "commands_to_run",
    "success_criteria", "failure_criteria", "required_artifacts", "stopping_criteria", "do_not_overclaim"],
  properties: {
    objective: { type: "string" },
    context: { type: "string" },
    allowed_files: strs, forbidden_files: strs, commands_to_run: strs,
    success_criteria: { type: "array", items: { type: "string" }, description: "mechanically checkable" },
    failure_criteria: { type: "array", items: { type: "string" }, description: "observations that prove it did NOT work" },
    required_artifacts: { type: "array", items: { type: "string" }, description: "named, inspectable outputs" },
    stopping_criteria: { type: "array", items: { type: "string" }, description: "when to STOP, to prevent over-building" },
    do_not_overclaim: { type: "string", description: "instruction telling the agent not to report success it cannot demonstrate" },
  },
};
const VERIFICATION = {
  type: "object", additionalProperties: false,
  required: ["resolved", "unresolved_count", "residual_risks", "verdict"],
  properties: {
    resolved: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["lens", "resolved", "evidence"],
        properties: { lens: { type: "string" }, resolved: { type: "boolean" }, evidence: { type: "string" } },
      },
    },
    unresolved_count: { type: "integer" },
    residual_risks: strs,
    verdict: { type: "string", enum: ["ready", "needs-work"] },
  },
};
const FINAL_REPORT = {
  type: "object", additionalProperties: false,
  required: ["headline", "verdict", "top_actions", "summary"],
  properties: {
    headline: { type: "string", description: "one-line summary of the lint result" },
    verdict: { type: "string", enum: ["ready", "needs-work"] },
    top_actions: { type: "array", items: { type: "string" }, description: "the most impactful changes, most important first" },
    summary: { type: "string", description: "a short prose summary of what was wrong and what the hardened goal fixes" },
  },
};

// ── the seven critic lenses (a static fan-out → counted exactly by --plan) ────
const CRITICS = [
  { key: "ambiguity", brief: "Ambiguity. Terms/phrases open to multiple readings, undefined nouns, vague quantifiers ('better', 'fast', 'robust', 'etc.'), pronouns without referents. A goal an agent can read two ways will be read the wrong way." },
  { key: "falsification", brief: "Falsifiability. Can you state a concrete, observable outcome that would prove the goal FAILED? If success is unfalsifiable, the agent will simply declare victory. Demand a check that can come back false." },
  { key: "overbuild", brief: "Over-building. Does the goal invite scope creep, gold-plating, or rewrites beyond the objective? Pin it to the smallest change that satisfies the objective." },
  { key: "artifact", brief: "Artifact/output. What concrete artifact must exist when done — a file, a diff, a printed value, a passing test? Is it named and inspectable, or only 'it works'?" },
  { key: "verification", brief: "Verification. How is success checked MECHANICALLY (a command, an assertion, a diff), independent of the agent's self-report? A goal verified only by the agent's say-so is not verified." },
  { key: "safety", brief: "Safety/sandbox. Does the goal need write/network/exec access, or can it stay read-only? What must NOT be touched? Are inputs untrusted? Name the blast radius and the guardrails." },
  { key: "scope", brief: "Scope control. What are the stopping criteria — when should the agent STOP rather than keep polishing? What is explicitly out of scope? Bound the work." },
];
// optional fan-out cap (the only variable-width stage)
const capN = Number(A.maxAgents) > 0 ? Math.max(1, Math.min(CRITICS.length, Math.floor(Number(A.maxAgents)))) : CRITICS.length;
const critics = CRITICS.slice(0, capN);

const HINTS = [
  REPO_CONTEXT && `Repo context: ${REPO_CONTEXT}`,
  ALLOWED.length && `Caller-allowed files: ${ALLOWED.join(", ")}`,
  FORBIDDEN.length && `Caller-forbidden files: ${FORBIDDEN.join(", ")}`,
  EXPECTED_ARTIFACTS.length && `Caller-expected artifacts: ${EXPECTED_ARTIFACTS.join(", ")}`,
].filter(Boolean).join("\n");

// ── Parse: one reader extracts a precise analysis (it never attempts the goal) ──
phase("Parse");
const parsed = await agent(
  `You are linting an instruction ("/goal") that will be handed to an autonomous coding agent. ` +
    `Do NOT attempt the goal — analyze it.\n\nGOAL:\n${GOAL}\n` + (HINTS ? `\nCALLER HINTS:\n${HINTS}\n` : "") +
    `\nReturn: the core objective in one sentence; the files/dirs it likely touches; the commands a solver ` +
    `would run (build/test/lint); the success criteria as stated or implied; the constraints that are MISSING ` +
    `but needed (sandbox, scope, artifacts, verification); and any ambiguous phrases. Rate the risk of handing ` +
    `this goal to an agent as-is.`,
  { schema: PARSED, label: "parse:goal", phase: "Parse" },
);
const PARSE_BRIEF =
  `Objective: ${parsed.objective}\n` +
  `Ambiguities: ${(parsed.ambiguities || []).join("; ") || "(none noted)"}\n` +
  `Missing constraints: ${(parsed.missing_constraints || []).join("; ") || "(none noted)"}`;

// ── Critique: 7 independent lenses, each narrow and refute-leaning ────────────
phase("Critique");
const critiques = (
  await parallel(
    critics.map((C) => () =>
      agent(
        `You are the ${C.key.toUpperCase()} critic for an agent /goal. Critique ONLY through this lens:\n${C.brief}\n\n` +
          `GOAL:\n${GOAL}\n\nPARSE:\n${PARSE_BRIEF}\n` + (HINTS ? `\nCALLER HINTS:\n${HINTS}\n` : "") +
          `\nReturn the single most important problem this lens exposes, the failure mode it causes if the goal ` +
          `ships as-is, and the concrete change to the goal that fixes it. If the goal is already solid on this ` +
          `lens, say so with severity "low" — do not invent problems.`,
        { schema: CRITIQUE, label: `critique:${C.key}`, phase: "Critique" },
      ),
    ),
  )
).filter(Boolean);
const CRIT_BRIEF = critiques.map((c) => `- [${c.lens} · ${c.severity}] ${c.finding} → fix: ${c.fix}`).join("\n");

// ── Rewrite: one gate folds every critique + the caller hints into a hardened goal ──
phase("Rewrite");
const hardened = await agent(
  `Rewrite the /goal below into a hardened instruction for an autonomous agent, resolving every critique. ` +
    `The result must be precise, testable, falsifiable, and artifact-producing.\n\n` +
    `ORIGINAL GOAL:\n${GOAL}\n\nPARSE:\n${PARSE_BRIEF}\n\nCRITIQUES:\n${CRIT_BRIEF}\n` +
    (HINTS ? `\nCALLER HINTS (honor these):\n${HINTS}\n` : "") +
    `\nProduce: objective; context; allowed files; forbidden files; commands to run; success criteria ` +
    `(each mechanically checkable); failure criteria (observations that prove it did NOT work); required ` +
    `artifacts (named, inspectable outputs); stopping criteria (when to STOP, to prevent over-building); and ` +
    `an explicit "do not overclaim" instruction telling the agent never to report success it cannot ` +
    `demonstrate. Fold the caller hints into allowed/forbidden/required where given. Keep it tight — a sharp ` +
    `goal, not an essay.`,
  { schema: HARDENED, label: "rewrite:harden", phase: "Rewrite" },
);
const GOAL_MD = renderGoalMarkdown(hardened);

// ── Verify: a FRESH gate (it did not write the rewrite) audits each critique ──
phase("Verify");
const verification = await agent(
  `You are a FRESH verifier. You did NOT write the hardened goal below. For each critique finding, decide ` +
    `whether the hardened goal RESOLVES it, citing the specific part that does (or noting what is still ` +
    `missing). Then list residual risks and rule the goal "ready" or "needs-work". Be strict: default to ` +
    `not-resolved if the goal does not concretely address the finding.\n\n` +
    `HARDENED GOAL:\n${GOAL_MD}\n\nCRITIQUE FINDINGS:\n${CRIT_BRIEF || "(none)"}`,
  { schema: VERIFICATION, label: "verify:gate", phase: "Verify" },
);

// ── Report: a synthesizer writes the structured headline/verdict/top-actions; the
// paste-ready Markdown is then assembled in code (verbatim hardened goal, always
// populated — so it survives a --plan dry run too) ──────────────────────────────
phase("Report");
const report = await agent(
  `You are GoalLint's reporter. Summarize this lint for a human deciding whether to dispatch agents on the ` +
    `hardened goal. Be concise and concrete — no preamble.\n\n` +
    `ORIGINAL GOAL:\n${GOAL}\n\nRISK (as-is): ${parsed.risk_level}\n\nCRITIQUES:\n${CRIT_BRIEF || "(none)"}\n\n` +
    `VERIFICATION: verdict=${verification.verdict}, unresolved=${verification.unresolved_count}\n` +
    `RESIDUAL RISKS: ${(verification.residual_risks || []).join("; ") || "(none)"}\n\n` +
    `Return a one-line headline, the verdict, the top actions (most impactful first), and a short prose summary ` +
    `of what was wrong and what the hardened goal fixes.`,
  { schema: FINAL_REPORT, label: "report:synthesize", phase: "Report" },
);
const report_markdown = renderReport({ GOAL, parsed, critiques, GOAL_MD, verification, report });
const highs = critiques.filter((c) => c.severity === "high").length;
log(`GoalLint: ${report.verdict || verification.verdict} · risk ${parsed.risk_level} · ${critiques.length} critiques (${highs} high) · ${verification.unresolved_count} unresolved`);

return {
  verdict: report.verdict || verification.verdict,
  original_goal: GOAL,
  risk_level: parsed.risk_level,
  parsed,
  critiques,
  hardened_goal: hardened,
  hardened_goal_markdown: GOAL_MD,
  verification,
  final_report: report,
  report_markdown,
};

// ── markdown helpers (pure string building; safe in the script sandbox) ──────
function bullets(arr) {
  return arr && arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- _(none specified)_";
}
function mdCell(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s*\n+\s*/g, " ").trim() || "—";
}
function renderGoalMarkdown(h) {
  return [
    `### Objective`, h.objective || "_(none)_",
    ``, `### Context`, h.context || "_(none)_",
    ``, `### Allowed files`, bullets(h.allowed_files),
    ``, `### Forbidden files`, bullets(h.forbidden_files),
    ``, `### Commands to run`, bullets(h.commands_to_run),
    ``, `### Success criteria`, bullets(h.success_criteria),
    ``, `### Failure criteria`, bullets(h.failure_criteria),
    ``, `### Required artifacts`, bullets(h.required_artifacts),
    ``, `### Stopping criteria`, bullets(h.stopping_criteria),
    ``, `### Do not overclaim`, h.do_not_overclaim || "_(none)_",
  ].join("\n");
}
function renderReport(d) {
  const rep = d.report || {};
  const highCount = d.critiques.filter((c) => c.severity === "high").length;
  const rows = d.critiques.length
    ? d.critiques.map((c) => `| ${mdCell(c.lens)} | ${c.severity} | ${mdCell(c.finding)} | ${mdCell(c.fix)} |`).join("\n")
    : `| — | — | _(no critiques)_ | — |`;
  const actions = (rep.top_actions || []).length
    ? rep.top_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "_(none)_";
  const resolved = d.verification.resolved || [];
  const checks = d.critiques.length
    ? d.critiques.map((c) => {
        const r = resolved.find((x) => x.lens === c.lens);
        const ok = !!(r && r.resolved);
        return `- [${ok ? "x" : " "}] **${c.lens}** — ${ok ? "resolved" : "UNRESOLVED"}${r && r.evidence ? `: ${mdCell(r.evidence)}` : ""}`;
      }).join("\n")
    : `_(no critiques to verify)_`;
  const residual = (d.verification.residual_risks || []).length
    ? `\n**Residual risks:**\n${d.verification.residual_risks.map((x) => `- ${x}`).join("\n")}`
    : "";
  return [
    `# GoalLint report`,
    ``,
    rep.headline ? `**${rep.headline}**\n` : "",
    `**Verdict:** ${rep.verdict || d.verification.verdict}  ·  **Original risk:** ${d.parsed.risk_level}  ·  ` +
      `**Critiques:** ${d.critiques.length} (${highCount} high)  ·  **Unresolved:** ${d.verification.unresolved_count}`,
    ``,
    rep.summary ? `${rep.summary}\n` : "",
    `## Top actions`,
    actions,
    ``,
    `## Original goal`,
    `> ${mdCell(d.GOAL)}`,
    ``,
    `## What was wrong`,
    `| Lens | Severity | Finding | Fix |`,
    `| :--- | :--- | :--- | :--- |`,
    rows,
    ``,
    `## Hardened /goal`,
    d.GOAL_MD,
    ``,
    `## Verification`,
    checks,
    residual,
    ``,
  ].join("\n");
}
