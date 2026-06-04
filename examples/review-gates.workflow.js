// Fresh-context review gates: no agent reviews its own work.
//
// A producer drafts an artifact; independent reviewers each see ONLY the artifact
// and a rubric (never the task prompt, the producer's reasoning, or each other's
// review); then a fresh gate — neither producer nor reviewer — reads the artifact
// plus all reviews and rules go / revise / no-go, citing them. The separation is
// the whole point: a producer rationalizes its own choices, so it must never judge
// them, and reviewers stay uncorrelated when they can't see each other.
//
//   node .../bin/run-workflow.js review-gates.workflow.js --frontier --auto-effort \
//     --sandbox read-only --budget 4000000 \
//     --args '{"task":"Design the data model + migration plan to add teams to a single-tenant app","kind":"implementation plan"}'
//
// Patterns: fresh-context review gate (producer != reviewer != synthesizer) +
// perspective-diverse, refute-by-default review. Under --auto-effort the lone
// producer and decision gates think hardest (xhigh); the review fan-out gets the
// floor (high). Works for any artifact: a plan, a design, a spec, a migration.

export const meta = {
  name: "review-gates",
  description: "Producer drafts an artifact; independent reviewers judge only the artifact; a fresh gate decides",
  phases: [
    { title: "Produce", detail: "one agent drafts the artifact" },
    { title: "Review", detail: "independent lenses critique ONLY the artifact + a rubric" },
    { title: "Decide", detail: "a fresh gate weighs the reviews and rules go / revise / no-go" },
  ],
};

const TASK = (args && args.task) || "";
const KIND = (args && args.kind) || "implementation plan";
if (!TASK) {
  log('No task given. Pass --args \'{"task":"...","kind":"implementation plan"}\'.');
  return { note: "no task" };
}

const ARTIFACT = {
  type: "object", additionalProperties: false,
  required: ["title", "artifact", "key_decisions", "assumptions"],
  properties: {
    title: { type: "string" },
    artifact: { type: "string", description: `the full ${KIND}, self-contained and concrete` },
    key_decisions: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
  },
};

const REVIEW = {
  type: "object", additionalProperties: false,
  required: ["lens", "verdict", "issues", "confidence"],
  properties: {
    lens: { type: "string" },
    verdict: { type: "string", enum: ["pass", "revise", "block"] },
    issues: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "issue", "fix"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          issue: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

const DECISION = {
  type: "object", additionalProperties: false,
  required: ["decision", "blocking_issues", "required_changes", "rationale"],
  properties: {
    decision: { type: "string", enum: ["go", "revise", "no-go"] },
    blocking_issues: { type: "array", items: { type: "string" } },
    required_changes: { type: "array", items: { type: "string" } },
    rationale: { type: "string", description: "cite the reviews by lens" },
  },
};

// Distinct review lenses — each is an independent, narrow critique.
const LENSES = [
  { key: "correctness", brief: "Does the approach actually solve the task? Gaps, wrong assumptions, missing cases." },
  { key: "security", brief: "Trust boundaries, authz, data exposure, injection, unsafe defaults." },
  { key: "simplicity", brief: "Is this the simplest thing that works? Over-engineering, needless moving parts." },
  { key: "tests-and-risk", brief: "How would this be tested? What's the riskiest step, and the rollback?" },
];

// ── Produce: one agent drafts the artifact (lone gate → xhigh under --auto-effort)
phase("Produce");
const draft = await agent(
  `Task: ${TASK}\n\nProduce a concrete, self-contained ${KIND}. Make your key decisions explicit ` +
    `and list the assumptions you made. Write it so a reviewer who sees ONLY your artifact (not this ` +
    `prompt) can judge it on its own terms.`,
  { schema: ARTIFACT, label: "produce:draft", phase: "Produce" },
);

// The artifact text is the ONLY thing reviewers see — not the task, not the
// producer's chain of thought. Fresh, narrow context per reviewer.
const ARTIFACT_TEXT =
  `# ${draft.title}\n\n${draft.artifact}\n\n` +
  `Key decisions:\n- ${(draft.key_decisions || []).join("\n- ")}\n\n` +
  `Stated assumptions:\n- ${(draft.assumptions || []).join("\n- ")}`;

// ── Review: independent lenses, each seeing only the artifact + its rubric ────
phase("Review");
const reviews = (
  await parallel(
    LENSES.map((L) => () =>
      agent(
        `You are reviewing a ${KIND} through the "${L.key}" lens.\n${L.brief}\n\n` +
          `Review ONLY the artifact below against that rubric. You did not write it; do not assume ` +
          `good intent or fill gaps charitably. Default to "revise"/"block" if a real issue is unaddressed.\n\n` +
          `--- ARTIFACT ---\n${ARTIFACT_TEXT}`,
        { schema: REVIEW, label: `review:${L.key}`, phase: "Review" },
      ),
    ),
  )
).filter(Boolean);

// ── Decide: a fresh gate (neither producer nor reviewer) rules, citing the reviews ──
phase("Decide");
const decision = await agent(
  `You are an independent gate deciding whether this ${KIND} is ready. You did not write it and ` +
    `did not review it. Weigh the reviews, resolve disagreements, and rule go / revise / no-go. Cite ` +
    `reviews by lens in your rationale, and list only the changes that actually block shipping.\n\n` +
    `--- ARTIFACT ---\n${ARTIFACT_TEXT}\n\n--- REVIEWS ---\n` +
    reviews
      .map((r) =>
        `[${r.lens}] verdict=${r.verdict} (confidence ${r.confidence})\n` +
        (r.issues || []).map((i) => `  (${i.severity}) ${i.issue} -> ${i.fix}`).join("\n"))
      .join("\n\n"),
  { schema: DECISION, label: "decide:gate", phase: "Decide" },
);

log(`decision: ${decision.decision} · ${reviews.length} reviews · ${(decision.blocking_issues || []).length} blocking`);
return { task: TASK, kind: KIND, artifact: draft, reviews, decision };
