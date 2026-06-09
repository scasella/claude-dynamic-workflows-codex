// Lead-following research — a controller reads partial findings and decides MID-RUN
// to go deeper (steer), open a new lead (spawn), or stop. Dynamic investigation on
// warm context, not a fixed pre-planned fan-out.
//
// NEW capability: the orchestration plan is EMERGENT. A controller agent inspects
// each finding as it lands (agent.waitAny), then either steers the worker that
// found it (continue on its already-loaded context), spawns a fresh worker for a new
// lead, or stops.
//
// Why this needs the new feature: the old runtime could only branch on FULL results
// at a barrier and then spawn COLD workers — it could not steer an existing worker
// (reusing its loaded context) or react to the FIRST finding. Here the cheapest way
// to drill a lead is to steer the worker that already has it loaded.
//
//   node .../bin/run-workflow.js examples/lead-following-research.workflow.js \
//     --frontier --sandbox read-only --budget 5000000 \
//     --args '{"topic":"how request auth flows through this codebase","maxRounds":6,"maxThreads":4}'
//
// Runs under --plan (bounded by maxRounds; the controller's planned decision is the
// first enum, so a dry run exercises the steer path up to the cap).

export const meta = {
  name: "lead-following-research",
  description: "A controller follows the strongest lead mid-run: steer deeper, spawn a new thread, or stop",
  phases: [
    { title: "Investigate", detail: "live workers chase leads; the controller routes the first finding each round" },
    { title: "Synthesize", detail: "a fresh agent consolidates the findings" },
  ],
};

const TOPIC = (args && args.topic) || "How does this codebase work and where are its main risks?";
const MAX_ROUNDS = (args && args.maxRounds) || 6;
const MAX_THREADS = (args && args.maxThreads) || 4;

const FINDING = {
  type: "object", additionalProperties: false,
  required: ["lead", "summary", "evidence", "promising", "suggested_next"],
  properties: {
    lead: { type: "string" },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    promising: { type: "boolean" },
    suggested_next: { type: "string" },
  },
};
const DECISION = {
  type: "object", additionalProperties: false,
  required: ["action", "directive", "reason"],
  properties: {
    // "steer" first so a --plan dry run exercises the warm-continue path (bounded by maxRounds).
    action: { type: "string", enum: ["steer", "spawn", "stop"] },
    directive: { type: ["string", "null"], description: "the steer message or the spawn prompt" },
    reason: { type: "string" },
  },
};

async function decide(ledger, snapshot) {
  return await agent(
    `You are the controller for a lead-following investigation.\nTopic:\n${TOPIC}\n\n` +
      `Findings so far:\n${JSON.stringify(ledger, null, 2)}\n\nLatest finding:\n${JSON.stringify(snapshot.result, null, 2)}\n\n` +
      `Decide the next move:\n` +
      `- "steer": the SAME worker should go deeper on this lead (it has the context loaded)\n` +
      `- "spawn": open a NEW worker on a different lead worth pursuing\n` +
      `- "stop": there is enough signal; consolidate.\nPut the steer message or spawn prompt in "directive".`,
    { label: "controller", phase: "Investigate", schema: DECISION },
  );
}

// ── Investigate: chase leads, routing the FIRST finding each round ─────────────
phase("Investigate");
let active = [
  await agent.start(
    `Investigate: ${TOPIC}\nReport ONE concrete lead with file:line / source evidence and a suggested next step.`,
    { label: "lead-0", phase: "Investigate", sandbox: "read-only", schema: FINDING },
  ),
];
let opened = 1;
const ledger = [];

for (let round = 0; round < MAX_ROUNDS && active.length; round++) {
  const r = await agent.waitAny(active, { timeoutMs: 240_000 });
  if (r.timedOut) { log("round timed out"); break; }
  const worker = r.session;
  active = r.pendingSessions; // the other leads keep running
  if (r.snapshot.result) ledger.push({ worker: worker.label, ...r.snapshot.result });
  log(`round ${round}: ${worker.label} reported (promising=${r.snapshot.result?.promising})`);

  const d = await decide(ledger, r.snapshot);
  log(`  controller: ${d.action} — ${d.reason}`);
  if (d.action === "stop") { await parallel(active.map((s) => () => s.cancel())); active = []; break; }
  if (d.action === "steer") {
    await worker.steer(d.directive || "Go one level deeper on the most load-bearing part of that lead.",
      { wait: false, schema: FINDING });
    active.push(worker); // back into the race, warm
  } else if (d.action === "spawn" && opened < MAX_THREADS) {
    const w = await agent.start(d.directive || `Investigate a different aspect of: ${TOPIC}`,
      { label: `lead-${opened}`, phase: "Investigate", sandbox: "read-only", schema: FINDING });
    opened++;
    active.push(w); // the reporting worker's finding is banked; it is not re-added
  }
}
// drain any stragglers still running
await parallel(active.map((s) => () => s.cancel()));

// ── Synthesize: a FRESH agent (independence) consolidates the findings ─────────
phase("Synthesize");
const report = await agent(
  `Consolidate this lead-following investigation of "${TOPIC}" into a tight brief: the key findings, how ` +
    `they connect, and what is still uncertain. Cite the evidence.\n\n${JSON.stringify(ledger, null, 2)}`,
  { label: "synthesize", phase: "Synthesize" },
);

return { topic: TOPIC, leadsOpened: opened, findings: ledger, report };
