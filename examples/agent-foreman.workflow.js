// Agent-foreman supervised autonomy — a foreman controller drives live workers to
// finish a goal (accept / steer / spawn / cancel), escalating to the human ONLY at
// declared forks via a structured needs_human return.
//
// NEW capability: a long run supervised mid-flight by an AGENT, not the human. The
// foreman reads each worker report (agent.waitAny), nudges a stalled worker on its
// warm thread (steer), adds a helper (spawn), kills a stuck one (cancel), or — at a
// scope/risk/value fork — stops and returns a checkpoint for a human.
//
// Why this needs the new feature: the old runtime could only branch on full results
// at a barrier and spawn COLD workers; it could not nudge a single long-running
// worker through a stall on its accumulated context. Supervised autonomy over a
// LIVE, stateful worker is the unlock.
//
// Human model: you set POLICY (goal + involvement). hands_off = never pause (take the
// safe default); checkpointed (default) = stop at declared forks. v1 does NOT block on
// live human input — escalation returns a structured needs_human object and ends.
//
//   node .../bin/run-workflow.js examples/agent-foreman.workflow.js \
//     --frontier --sandbox read-only --budget 5000000 \
//     --args '{"goal":"Audit the repo for missing input validation and propose fixes","maxSteps":8,"involvement":"checkpointed"}'
//
// Runs under --plan (bounded by maxSteps; the planned foreman picks the first enum).

export const meta = {
  name: "agent-foreman",
  description: "A foreman agent supervises live workers to finish a goal, escalating only at declared forks",
  phases: [
    { title: "Work", detail: "the foreman drives live workers: accept / steer / spawn / cancel" },
    { title: "Report", detail: "return the result, or a structured needs_human checkpoint" },
  ],
};

const GOAL = (args && args.goal) || "Survey this repository and produce a prioritized list of the top risks.";
const MAX_STEPS = (args && args.maxSteps) || 8;
const MAX_WORKERS = (args && args.maxWorkers) || 4;
const policy = {
  involvement: (args && args.involvement) || "checkpointed", // hands_off | checkpointed
  escalateFor: ["scope_change", "destructive_action", "extra_budget", "value_judgment"],
};

const PROGRESS = {
  type: "object", additionalProperties: false,
  required: ["done", "progress", "blocker", "fork"],
  properties: {
    done: { type: "boolean" },
    progress: { type: "string" },
    blocker: { type: ["string", "null"] },
    fork: { type: ["string", "null"], description: "a scope/risk/value decision needing authority, or null" },
  },
};
const ORDER = {
  type: "object", additionalProperties: false,
  required: ["action", "directive", "human_question", "recommended_default", "reason"],
  properties: {
    // "steer" first so a --plan dry run exercises the warm-nudge path (bounded by maxSteps).
    action: { type: "string", enum: ["steer", "spawn", "accept", "escalate", "abort"] },
    directive: { type: ["string", "null"] },
    human_question: { type: ["string", "null"] },
    recommended_default: { type: ["string", "null"] },
    reason: { type: "string" },
  },
};

async function foreman(ledger, snapshot) {
  return await agent(
    `You are the foreman of an autonomous run.\nGoal:\n${GOAL}\n\nPolicy:\n${JSON.stringify(policy, null, 2)}\n\n` +
      `Progress log:\n${JSON.stringify(ledger, null, 2)}\n\nLatest worker report:\n${JSON.stringify(snapshot.result, null, 2)}\n\n` +
      `Choose ONE: "accept" (goal met) · "steer" (nudge this worker through a blocker on its warm context) · ` +
      `"spawn" (add a helper worker) · "escalate" (a declared fork needs a human — set human_question + ` +
      `recommended_default) · "abort" (unrecoverable). Put any worker instruction in "directive".`,
    { label: "foreman", phase: "Work", schema: ORDER },
  );
}

// ── Work: drive a small LIVE fleet toward the goal ─────────────────────────────
phase("Work");
let active = [
  await agent.start(
    `Goal: ${GOAL}\nStart working. Report progress, any blocker, and whether you've hit a scope/risk/value fork.`,
    { label: "worker-0", phase: "Work", sandbox: "read-only", schema: PROGRESS },
  ),
];
let opened = 1;
const ledger = [];
let result = null;

for (let step = 0; step < MAX_STEPS && active.length; step++) {
  const r = await agent.waitAny(active, { timeoutMs: 300_000 });
  if (r.timedOut) { log("step timed out"); break; }
  const worker = r.session;
  active = r.pendingSessions; // the rest of the fleet keeps working
  if (r.snapshot.result) ledger.push({ worker: worker.label, step, ...r.snapshot.result });

  const o = await foreman(ledger, r.snapshot);
  log(`step ${step}: foreman=${o.action} — ${o.reason}`);

  if (o.action === "accept") {
    result = r.snapshot.result;
    await parallel(active.map((s) => () => s.cancel()));
    active = [];
    break;
  }
  if (o.action === "abort") {
    await parallel(active.map((s) => () => s.cancel()));
    return { status: "aborted", goal: GOAL, reason: o.reason, ledger };
  }
  if (o.action === "escalate") {
    if (policy.involvement === "hands_off") {
      // never pause: take the safe default and keep the worker going on its warm thread
      await worker.steer(`Proceed with the safe default: ${o.recommended_default || "the most conservative option"}. Continue toward the goal.`,
        { wait: false, schema: PROGRESS });
      active.push(worker);
      continue;
    }
    // checkpointed: free the live fleet and hand a structured fork back to the human
    await parallel(active.map((s) => () => s.cancel()));
    return {
      status: "needs_human",
      checkpointId: `foreman-step-${step}`,
      question: o.human_question || "A decision outside the agent's authority is required.",
      recommendedDefault: o.recommended_default,
      reason: o.reason,
      goal: GOAL,
      ledger,
      resumeInstructions: "Decide, then rerun with --resume and pass the answer in --args (sessions are live-only, so the run re-executes).",
    };
  }
  if (o.action === "spawn" && opened < MAX_WORKERS) {
    const w = await agent.start(o.directive || `Help with: ${GOAL}`,
      { label: `worker-${opened}`, phase: "Work", sandbox: "read-only", schema: PROGRESS });
    opened++;
    active.push(w); // the reporting worker's progress is banked; it is not re-added
  } else { // steer (default): nudge the reporting worker on its warm context
    await worker.steer(o.directive || "Continue toward the goal; resolve the blocker you reported.",
      { wait: false, schema: PROGRESS });
    active.push(worker);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
phase("Report");
for (const s of active) await s.close();
return { status: result ? "done" : "max_steps_reached", goal: GOAL, involvement: policy.involvement, result, steps: ledger.length, ledger };
