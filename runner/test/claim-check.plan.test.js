// Plan-mode smoke test for the ClaimCheck harness-zoo template. A --plan dry run
// executes the orchestration with agent() stubbed (schema skeletons) — no Codex, no
// tokens — so this verifies the phase/agent shape, that the script survives skeleton
// outputs, and that it still returns a structured JSON + Markdown proof ledger.
// (Mirrors the runtime --plan mechanics covered in offline.js, but against the real
// template.)
//
// Note on the dynamic fan-out: ClaimCheck's Verify stage fans out one agent per
// claim, and the claims come from the Extract agent — whose output is an EMPTY array
// in a --plan dry run. So without help the Verify count would be 0. ClaimCheck lets a
// caller PRE-SEED `claims` via args (it then skips model extraction), which makes the
// verify fan-out countable in --plan. The sample-args.json seeds 5 claims, so we can
// assert Verify=5; we also assert the no-seed case degrades gracefully to Verify=0.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runWorkflowFile } from "../src/runWorkflow.js";

const WF = new URL("../../examples/harness-zoo/claim-check/claim-check.workflow.js", import.meta.url).pathname;
const ARGS = JSON.parse(
  readFileSync(new URL("../../examples/harness-zoo/claim-check/sample-args.json", import.meta.url).pathname, "utf8"),
);

const plan = async (args) => {
  const recs = [];
  const result = await runWorkflowFile(WF, { args, plan: true, onAgentPlan: (r) => recs.push(r), onPhase: () => {}, onLog: () => {} });
  const byPhase = {};
  for (const r of recs) byPhase[r.phase] = (byPhase[r.phase] || 0) + 1;
  return { recs, byPhase, result };
};

// 1) Sample args (5 pre-seeded claims): the verify fan-out is countable, and the dry
//    run returns a structured ledger. Pre-seeding skips model extraction, so there is
//    NO Extract agent in this run — only the 5 verifiers + the ledger.
{
  const { recs, byPhase, result } = await plan(ARGS);
  assert.equal(byPhase.Extract || 0, 0, "Extract: 0 agents (claims pre-seeded → extraction skipped)");
  assert.equal(byPhase.Verify, 5, "Verify: 5 verifiers (one per seeded claim)");
  assert.equal(byPhase.Ledger, 1, "Ledger: 1 synthesizer");
  assert.equal(recs.length, 6, "6 agents total (0 Extract + 5 Verify + 1 Ledger)");
  assert.equal(recs[recs.length - 1].phase, "Ledger", "Ledger runs last");
  assert.ok(result && typeof result === "object", "returns an object");
  assert.equal(typeof result.ledger_markdown, "string");
  assert.ok(result.ledger_markdown.includes("ClaimCheck proof ledger"), "Markdown ledger is assembled in code (populated even on a dry run)");
  assert.ok(Array.isArray(result.verdicts), "returns a verdicts array");
  assert.equal(result.verdicts.length, 5, "5 verdicts (one per seeded claim)");
  assert.ok(result.counts && typeof result.counts === "object", "returns a counts object");
  assert.ok(result.final_ledger && typeof result.final_ledger === "object", "returns the structured final ledger");
  console.log("  ✓ seeded args: Extract=0 Verify=5 Ledger=1, proof ledger returned");
}

// 2) No pre-seeded claims (docPath only): Extract runs (1 agent), but its claims array
//    is EMPTY in a dry run, so the Verify fan-out is uncounted (0). The workflow must
//    still return a well-formed result and not crash on the empty fan-out.
{
  const { byPhase, recs, result } = await plan({ docPath: "README.md", focus: "deps" });
  assert.equal(byPhase.Extract, 1, "Extract: 1 reader");
  assert.equal(byPhase.Verify || 0, 0, "Verify: 0 — fan-out sized from Extract's EMPTY dry-run output (uncounted, handled gracefully)");
  assert.equal(byPhase.Ledger, 1, "Ledger: 1 synthesizer still runs");
  assert.equal(recs.length, 2, "2 agents counted in a dry run (Extract + Ledger); verifiers uncounted");
  assert.ok(result && typeof result.ledger_markdown === "string", "still returns a Markdown ledger on the empty fan-out");
  assert.ok(Array.isArray(result.verdicts) && result.verdicts.length === 0, "verdicts is an empty array, not undefined");
  console.log("  ✓ no-seed docPath: Extract=1, Verify=0 (uncounted fan-out handled), Ledger=1");
}

// 3) Bare-string document is accepted (typeof args === 'string') → taken as `doc`.
//    No seed, so Extract=1, Verify uncounted, Ledger=1.
{
  const { recs, byPhase } = await plan("This project has zero dependencies and runs on Node 18+.");
  assert.equal(byPhase.Extract, 1, "bare-string doc → Extract runs");
  assert.equal(recs.length, 2, "bare-string doc plans to Extract + Ledger (verifiers uncounted)");
  console.log("  ✓ bare-string document accepted");
}

// 4) maxClaims caps the verify fan-out when claims are pre-seeded.
{
  const seeded = { docPath: "README.md", maxClaims: 2, claims: ARGS.claims };
  const { byPhase, recs } = await plan(seeded);
  assert.equal(byPhase.Verify, 2, "maxClaims:2 → 2 verifiers even with 5 seeded claims");
  assert.equal(recs.length, 3, "0 Extract + 2 Verify + 1 Ledger = 3 agents");
  console.log("  ✓ maxClaims caps the verify fan-out");
}

// 5) No document → a note, zero agents (early return before any phase).
{
  const { recs, result } = await plan({});
  assert.equal(recs.length, 0, "no document → no agents");
  assert.equal(result.note, "no document");
  console.log("  ✓ empty document returns a note, spawns nothing");
}

console.log("\nclaim-check plan smoke: passed ✓");
