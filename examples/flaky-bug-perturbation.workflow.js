// Flaky-bug perturbation harness — hold a non-reconstructible LIVE state, then
// perturb it across turns (session.steer + isolation:'worktree').
//
// NEW capability: a worker reproduces an intermittent failure (the expensive,
// stateful part — it may take many runs to catch the race), then is steered to
// PERTURB that same reproduction across hypotheses without rebuilding it. The
// worktree and the worker's context persist across every steer.
//
// Why this needs the new feature: with one-shot agent(), the worker's state
// evaporates when the turn ends — each hypothesis would have to re-win the flake
// lottery from scratch (and sometimes it never recurs). steer() lets every
// hypothesis branch from the moment it broke. This is the PUREST steer-only use
// case: a caught race is live state you cannot reconstruct by re-pasting text.
//
//   node .../bin/run-workflow.js examples/flaky-bug-perturbation.workflow.js \
//     --frontier --sandbox workspace-write --budget 4000000 \
//     --args '{"testCmd":"node --test test/flaky.test.js","reproRuns":80}'
//
// Runs under --plan (the perturbation playbook is a fixed, bounded list).

export const meta = {
  name: "flaky-bug-perturbation",
  description: "Reproduce a flaky failure once, then steer the SAME worker through perturbations",
  phases: [
    { title: "Reproduce", detail: "one worker catches the intermittent failure and holds the state" },
    { title: "Perturb", detail: "steer the SAME worker through a perturbation playbook" },
    { title: "Diagnose", detail: "steer it to a root cause from everything it tried" },
  ],
};

// A real run needs a genuinely flaky command; the default lets --plan exercise the
// full flow. Override with --args '{"testCmd":"..."}'.
const TEST_CMD = (args && args.testCmd) || "npm test";
const REPO = (args && args.repoNote) || "this repository";
const REPRO_RUNS = (args && args.reproRuns) || 50;
// A FIXED playbook keeps the run bounded (and --plan finite). Tailor per bug.
const PLAYBOOK = (args && Array.isArray(args.playbook) && args.playbook.length) ? args.playbook : [
  "Re-run with randomized test ordering (a shuffle seed). Does it still fail?",
  "Force single-threaded / serial execution. Does the failure disappear?",
  "Add logging around the suspected shared state or lock, re-run, and report what you see.",
  "Insert a small delay before the suspected critical section. Does timing change the outcome?",
];

const REPRO = {
  type: "object", additionalProperties: false,
  required: ["reproduced", "runs_until_fail", "failing_output", "hypothesis"],
  properties: {
    reproduced: { type: "boolean" },
    runs_until_fail: { type: ["integer", "null"] },
    failing_output: { type: "string" },
    hypothesis: { type: "string" },
  },
};
const PERTURB = {
  type: "object", additionalProperties: false,
  required: ["perturbation", "still_failed", "observation"],
  properties: {
    perturbation: { type: "string" },
    still_failed: { type: ["boolean", "null"] },
    observation: { type: "string" },
  },
};
const DIAGNOSIS = {
  type: "object", additionalProperties: false,
  required: ["root_cause", "fix", "confidence"],
  properties: {
    root_cause: { type: "string" },
    fix: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

// ── Reproduce: catch the flake and HOLD the failing state on a worktree ────────
phase("Reproduce");
const hunter = await agent.start(
  `In ${REPO}, reproduce an intermittent failure. Run \`${TEST_CMD}\` in a loop up to ${REPRO_RUNS} times ` +
    `until it FAILS at least once. Keep the failing output and your working state — you will be asked ` +
    `follow-up perturbations on THIS thread. Report whether it reproduced, after how many runs, the ` +
    `failing output, and your initial hypothesis.`,
  { label: "repro", phase: "Reproduce", sandbox: "workspace-write", isolation: "worktree", schema: REPRO },
);
const repro = await hunter.wait();
log(`reproduce: ${repro.status} — reproduced=${repro.result?.reproduced} after ${repro.result?.runs_until_fail ?? "?"} runs`);
if (repro.result && repro.result.reproduced === false) {
  log("did not reproduce yet — continuing to perturb anyway (the worker still holds context).");
}

// ── Perturb: each hypothesis is a follow-up turn on the SAME warm reproduction ─
phase("Perturb");
const tried = [];
for (let i = 0; i < PLAYBOOK.length; i++) {
  const snap = await hunter.steer(
    `Perturbation ${i + 1}: ${PLAYBOOK[i]}\nApply it to the reproduction you ALREADY have (do not start over). ` +
      `Report whether it still failed and what you observed.`,
    { wait: true, schema: PERTURB },
  );
  tried.push({ ...(snap.result || {}), turnTokens: snap.tokens, ms: snap.ms });
  log(`perturb ${i + 1}: still_failed=${snap.result?.still_failed}`);
}

// ── Diagnose: one more steer, reasoning over everything tried on this repro ────
phase("Diagnose");
const diag = await hunter.steer(
  `Given the original failure and every perturbation you tried on this SAME reproduction, state the most ` +
    `likely root cause, the concrete fix, and your confidence.`,
  { wait: true, schema: DIAGNOSIS },
);

await hunter.close();
return { testCmd: TEST_CMD, reproduced: repro.result?.reproduced ?? null, perturbations: tried, diagnosis: diag.result };
