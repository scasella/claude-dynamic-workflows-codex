// Hedged "take-first-win" — race N strategies at one problem, keep the first good
// result, CANCEL the rest (agent.start + agent.waitAny + session.cancel).
//
// NEW capability: fire several independent approaches at ONE problem; act on the
// FIRST acceptable result and interrupt the losers to stop their spend.
//
// Why this needs the new feature: parallel() is a BARRIER — it waits for the
// SLOWEST worker and you pay for ALL of them to completion. Even a hand-rolled
// Promise.race over agent() can't cancel the losers (they finish, you pay) or keep
// the winner as a steerable handle. waitAny + cancel give first-to-finish AND abort
// — the canonical hedge the old runtime structurally could not express.
// (Sibling pattern, same primitives: a streaming "conveyor" that refills a worker
//  slot as each one lands — see references/authoring.md → Sessionful workers.)
//
//   node .../bin/run-workflow.js examples/hedged-take-first-win.workflow.js \
//     --frontier --sandbox read-only --budget 3000000 \
//     --args '{"problem":"...","strategies":["...","...","..."]}'
//
// Runs under --plan (the race loop is bounded by the number of strategies).

export const meta = {
  name: "hedged-take-first-win",
  description: "Race independent strategies at one problem; accept the first good result, cancel the rest",
  phases: [
    { title: "Race", detail: "start one worker per strategy; take the first acceptable result" },
    { title: "Settle", detail: "cancel the losing workers and report" },
  ],
};

const PROBLEM = (args && args.problem) ||
  "Determine the most likely root cause of intermittent 500s on a checkout endpoint, and how to confirm it.";
const STRATEGIES = (args && Array.isArray(args.strategies) && args.strategies.length) ? args.strategies : [
  "Work backward from the symptom: enumerate failure modes and rank them by likelihood given the symptom.",
  "Work forward from recent changes: assume a regression and reason about what could have introduced it.",
  "Work from first principles: model the request path and find where it is most fragile under load.",
];

const ATTEMPT = {
  type: "object", additionalProperties: false,
  required: ["approach", "answer", "confidence"],
  properties: {
    approach: { type: "string" },
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

// ── Race: one detached worker per strategy (they run concurrently) ─────────────
phase("Race");
const workers = (await parallel(
  STRATEGIES.map((s, i) => () =>
    agent.start(
      `Problem:\n${PROBLEM}\n\nUse THIS strategy only:\n${s}\n\nReturn your best answer and an honest self-rated confidence.`,
      { label: `strat-${i}`, phase: "Race", sandbox: "read-only", schema: ATTEMPT },
    )),
)).filter(Boolean);
if (!workers.length) return { note: "no workers started" };

// Take the first worker whose result is acceptable (confidence high); otherwise move
// to the next finisher. waitAny returns the first ACTIONABLE session each pass.
let remaining = workers.slice();
let accepted = null;
const considered = [];
while (remaining.length && !accepted) {
  const r = await agent.waitAny(remaining, { timeoutMs: 300_000 });
  if (r.timedOut) { log("waitAny timed out — stopping the race"); break; }
  const cand = r.snapshot;
  remaining = remaining.filter((w) => w !== r.session); // consume the finisher
  const ok = cand.status === "completed" && cand.result && cand.result.confidence === "high";
  considered.push({ label: cand.label, confidence: cand.result?.confidence, accepted: ok });
  log(`finisher: ${cand.label} confidence=${cand.result?.confidence} → ${ok ? "ACCEPT" : "keep racing"}`);
  if (ok) accepted = cand;
}

// ── Settle: cancel every still-running loser, then close all ───────────────────
phase("Settle");
const cancelled = (await parallel(remaining.map((w) => () => w.cancel()))).filter(Boolean).length;
for (const w of workers) await w.close();
log(`accepted=${accepted ? accepted.label : "none"} · cancelled ${cancelled} loser(s)`);

return {
  problem: PROBLEM,
  winner: accepted ? { label: accepted.label, result: accepted.result, tokens: accepted.tokens, ms: accepted.ms } : null,
  considered,
  cancelledLosers: cancelled,
};
