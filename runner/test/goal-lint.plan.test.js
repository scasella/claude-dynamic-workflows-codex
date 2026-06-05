// Plan-mode smoke test for the GoalLint flagship template. A --plan dry run executes
// the orchestration with agent() stubbed (schema skeletons) — no Codex, no tokens —
// so this verifies the phase/agent shape, that the script survives skeleton outputs,
// and that it still returns a structured JSON + Markdown report. (Mirrors the
// runtime --plan mechanics covered in offline.js, but against the real template.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runWorkflowFile } from "../src/runWorkflow.js";

const WF = new URL("../../examples/harness-zoo/goal-lint/goal-lint.workflow.js", import.meta.url).pathname;
const ARGS = JSON.parse(
  readFileSync(new URL("../../examples/harness-zoo/goal-lint/sample-args.json", import.meta.url).pathname, "utf8"),
);

const plan = async (args) => {
  const recs = [];
  const result = await runWorkflowFile(WF, { args, plan: true, onAgentPlan: (r) => recs.push(r), onPhase: () => {}, onLog: () => {} });
  const byPhase = {};
  for (const r of recs) byPhase[r.phase] = (byPhase[r.phase] || 0) + 1;
  return { recs, byPhase, result };
};

// 1) Object args (the sample): exact phase shape + a structured report on the dry run.
{
  const { recs, byPhase, result } = await plan(ARGS);
  assert.equal(byPhase.Parse, 1, "Parse: 1 agent");
  assert.equal(byPhase.Critique, 7, "Critique: 7 parallel critics");
  assert.equal(byPhase.Rewrite, 1, "Rewrite: 1 gate");
  assert.equal(byPhase.Verify, 1, "Verify: 1 fresh gate");
  assert.equal(byPhase.Report, 1, "Report: 1 synthesizer");
  assert.equal(recs.length, 11, "11 agents total (1 + 7 + 1 + 1 + 1)");
  assert.equal(recs[0].phase, "Parse", "Parse runs first");
  assert.equal(recs[recs.length - 1].phase, "Report", "Report runs last");
  assert.ok(result && typeof result === "object", "returns an object");
  assert.equal(typeof result.report_markdown, "string");
  assert.ok(result.report_markdown.includes("GoalLint report"), "Markdown report is assembled in code (populated even on a dry run)");
  assert.ok(Array.isArray(result.critiques), "returns a critiques array");
  assert.ok(result.hardened_goal && typeof result.hardened_goal === "object", "returns a hardened goal object");
  assert.ok(result.final_report && typeof result.final_report === "object", "returns the structured final report");
  console.log("  ✓ object args: Parse=1 Critique=7 Rewrite=1 Verify=1 Report=1, report returned");
}

// 2) Bare-string goal is accepted (typeof args === 'string').
{
  const { recs } = await plan("make the upload endpoint faster");
  assert.equal(recs.length, 11, "bare-string goal also plans to 11 agents");
  console.log("  ✓ bare-string goal accepted");
}

// 3) maxAgents caps the critic fan-out (the only variable-width stage).
{
  const { byPhase, recs } = await plan({ goal: "tidy up logging", maxAgents: 3 });
  assert.equal(byPhase.Critique, 3, "maxAgents:3 → 3 critics");
  assert.equal(recs.length, 7, "1 + 3 + 1 + 1 + 1 = 7 agents");
  console.log("  ✓ maxAgents caps the critic fan-out");
}

// 4) No goal → a note, zero agents (early return before any phase).
{
  const { recs, result } = await plan({});
  assert.equal(recs.length, 0, "no goal → no agents");
  assert.equal(result.note, "no goal");
  console.log("  ✓ empty goal returns a note, spawns nothing");
}

console.log("\ngoal-lint plan smoke: passed ✓");
