// Classify-and-act (router): one classifier labels the task, then the workflow
// branches to a specialized handler. This is the blog's "classify-and-act"
// pattern — but note the deliberate divergence from the native example:
//
//   Native routes cheap stages to a smaller model (Sonnet vs Opus). This re-host
//   keeps ONE frontier model for every agent and lets *thinking effort* be the
//   lever instead: under --auto-effort the lone classifier and the lone handler
//   both run at xhigh, and you bound cost with --effort / --budget, not by
//   downgrading the model. (See references/authoring.md → "one model, effort is
//   the lever".)
//
//   node runner/bin/run-workflow.js examples/classify-route.workflow.js --frontier --auto-effort --sandbox read-only \
//     --args '{"task":"explain how the auth module works","dir":"src"}'

export const meta = {
  name: "classify-route",
  description: "Classify a task, then branch to a specialized handler (one model, effort scales)",
  phases: [
    { title: "Classify", detail: "label the task category + complexity" },
    { title: "Handle", detail: "branch to the matching specialist" },
  ],
};

const TASK = (args && args.task) || "";
const DIR = (args && args.dir) || ".";
if (!TASK) {
  log('classify-route needs a task. Pass --args \'{"task":"...","dir":"src"}\'.');
  return { note: "no task" };
}

const CATEGORIES = ["explain", "fix", "research", "review"];
const CLASS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "complexity", "rationale"],
  properties: {
    category: { type: "string", enum: CATEGORIES },
    complexity: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string" },
  },
};

phase("Classify");
const cls = (await agent(
  `Classify this task so it can be routed to a specialist. Categories: ${CATEGORIES.join(", ")}.\n` +
    `Return the best category, a complexity estimate, and a one-line rationale.\n\nTask: ${TASK}`,
  { label: "classify:task", sandbox: "read-only", schema: CLASS_SCHEMA },
)) || { category: "explain", complexity: "medium", rationale: "classifier unavailable — default route" };

// Branch: each specialist gets a prompt tuned to its job. Same model for all;
// effort is governed by --auto-effort (a lone handler is a critical gate → xhigh).
const HANDLERS = {
  explain: `Explain, with file:line citations from ${DIR}, how this works: ${TASK}. Be concrete and structured.`,
  fix: `Investigate and propose a concrete fix (diff-level steps, files to touch) for: ${TASK}. Read ${DIR} as needed.`,
  research: `Research this question across the codebase under ${DIR}, cross-checking sources: ${TASK}. Cite file:line.`,
  review: `Review the code under ${DIR} relevant to: ${TASK}. Report concrete issues with severity and a suggested fix.`,
};
const HANDLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "findings", "summary"],
  properties: {
    category: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["point", "evidence"],
        properties: { point: { type: "string" }, evidence: { type: "string", description: "file:line or quote" } },
      },
    },
  },
};

phase("Handle");
const handled = await agent(HANDLERS[cls.category], {
  label: `handle:${cls.category}`,
  sandbox: "read-only",
  schema: HANDLE_SCHEMA,
});

return { task: TASK, classification: cls, result: handled };
