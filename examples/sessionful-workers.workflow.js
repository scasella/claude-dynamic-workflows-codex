// Sessionful workers: spawn long-lived Codex workers, wait for the first to become
// actionable, and let a CONTROLLER agent (not the human) decide whether to accept,
// steer the same worker on its existing thread, ask the human, or stop.
//
// Human interaction model (see SKILL.md and references/authoring.md → "Sessionful
// workers"):
//   • The human sets the mission + policy (goal, involvement mode, budget, stops).
//   • The workflow SCRIPT owns the mechanical loop.
//   • A CONTROLLER agent makes the semantic call (accept / steer / ask_human / stop).
//   • The human re-enters ONLY at a declared checkpoint — surfaced as a structured
//     { status: "needs_human", … } return value. v1 never blocks on live stdin.
//
//   node .../bin/run-workflow.js examples/sessionful-workers.workflow.js \
//     --frontier --auto-effort --sandbox read-only --budget 3000000 \
//     --args '{"goal":"Audit auth","areaA":"auth middleware","areaB":"route handlers"}'
//
// Patterns: start → waitAny → controller decision → steer (same thread) → wait.
// Runs under --plan with no Codex: planned sessions return schema skeletons and the
// planned controller decision is "accept", so the whole orchestration executes
// without spending tokens. The steer / ask_human branches activate in real runs.

export const meta = {
  name: "sessionful-worker-demo",
  description: "Spawn long-lived Codex workers; a controller accepts / steers / asks / stops",
  phases: [
    { title: "Explore", detail: "start two read-only workers; wait for the first result" },
    { title: "Control", detail: "a controller agent decides the next action" },
    { title: "Collect", detail: "steer or accept, then collect final worker results" },
  ],
};

const GOAL = (args && args.goal) || "Investigate two areas and produce actionable next steps.";
const AREA_A = (args && args.areaA) || "area A";
const AREA_B = (args && args.areaB) || "area B";

// The human's policy: the mission, the involvement mode, and what must escalate.
//   hands_off    — never pause; safe defaults, mark uncertainty, avoid risky actions
//   checkpointed — pause only at scope/cost/risk/value gates (the recommended default)
//   interactive  — live steering via a viewer/sidecar (future; not built in v1)
const policy = {
  involvement: (args && args.involvement) || "checkpointed",
  askHumanFor: ["scope_change", "extra_budget", "destructive_action", "value_judgment"],
};

const FINDINGS = {
  type: "object", additionalProperties: false,
  required: ["area", "findings", "confidence"],
  properties: {
    area: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

const DECISION = {
  type: "object", additionalProperties: false,
  required: ["action", "targetLabel", "steerMessage", "humanQuestion", "recommendedDefault", "reason"],
  properties: {
    action: { type: "string", enum: ["accept", "steer", "ask_human", "stop"] },
    targetLabel: { type: ["string", "null"] },
    steerMessage: { type: ["string", "null"] },
    humanQuestion: { type: ["string", "null"] },
    recommendedDefault: { type: ["string", "null"] },
    reason: { type: "string" },
  },
};

// ── Explore: two long-lived read-only workers, STARTED but not awaited ─────────
phase("Explore");
const [a, b] = await parallel([
  () => agent.start(
    `Investigate "${AREA_A}" for this goal:\n${GOAL}\nReport concise file:line findings only.`,
    { label: "area-a", phase: "Explore", sandbox: "read-only", schema: FINDINGS },
  ),
  () => agent.start(
    `Investigate "${AREA_B}" for this goal:\n${GOAL}\nReport concise file:line findings only.`,
    { label: "area-b", phase: "Explore", sandbox: "read-only", schema: FINDINGS },
  ),
]);
const workers = [a, b].filter(Boolean);
if (!workers.length) return { status: "error", note: "no workers started" };

// Wait for whichever worker becomes actionable (completes / fails / etc.) first.
const first = await agent.waitAny(workers, { timeoutMs: 180_000 });
log(
  `first actionable: ${first.snapshot ? `${first.snapshot.label} (${first.snapshot.status})` : "none (timed out)"}` +
    ` · ${first.pendingSessions.length} still running`,
);

// ── Control: a controller agent (NOT the human) decides the next action ───────
phase("Control");
const decision = await agent(
  `You are the controller for a multi-agent workflow.\n\n` +
    `Goal:\n${GOAL}\n\n` +
    `Human policy:\n${JSON.stringify(policy, null, 2)}\n\n` +
    `First actionable worker snapshot:\n${JSON.stringify(first.snapshot, null, 2)}\n\n` +
    `Decide the next orchestration action. Prefer:\n` +
    `- accept   if the done criteria are met\n` +
    `- steer    if the SAME worker has useful context and only needs a focused correction\n` +
    `- ask_human ONLY for a scope / cost / risk / destructive / value decision in the policy\n` +
    `- stop     if further work is low-value`,
  { label: "controller", phase: "Control", schema: DECISION },
);
log(`controller: ${decision.action} — ${decision.reason}`);

// ── Enforce the decision ──────────────────────────────────────────────────────
// Checkpoint-by-return: v1 never blocks on live human input. When the controller
// (within the human's policy) needs a human, return a structured checkpoint object.
if (decision.action === "ask_human" && policy.involvement !== "hands_off") {
  await parallel(first.pendingSessions.map((s) => () => s.cancel())); // free running workers
  return {
    status: "needs_human",
    checkpointId: "controller-escalation",
    question: decision.humanQuestion || "A decision outside the agent's authority is required.",
    recommendedDefault: decision.recommendedDefault,
    reason: decision.reason,
    goal: GOAL,
    snapshot: first.snapshot,
    resumeInstructions:
      "Decide, then rerun with --resume and pass the answer in --args " +
      `(e.g. --args '{"checkpointAnswers":{"controller-escalation":"<decision>"}}'), ` +
      "or launch a narrower follow-up workflow. (Sessions are live-only: --resume re-runs them.)",
  };
}

if (decision.action === "stop") {
  await parallel(first.pendingSessions.map((s) => () => s.cancel()));
  return { status: "stopped", reason: decision.reason, snapshot: first.snapshot };
}

// accept or steer: steer the SAME worker on its existing thread when asked to.
if (decision.action === "steer" && first.session) {
  await first.session.steer(
    decision.steerMessage || "Narrow to the two highest-risk findings; list exact files to inspect next.",
    { wait: true },
  );
}

// ── Collect: gather every worker's final result, then close them ──────────────
phase("Collect");
const finals = await Promise.all(workers.map((w) => w.wait()));
for (const w of workers) await w.close();

return {
  status: "done",
  goal: GOAL,
  involvement: policy.involvement,
  decision,
  workers: finals.map((f) => ({ label: f.label, status: f.status, result: f.result })),
};
