// Checkout-incident root-cause lab — the bundled flagship demo. Diagnose a live
// latency regression the way you actually would: triage the signals in parallel,
// RACE several root-cause hypotheses as long-lived workers, keep the first that
// lands and cancel the rest, then INTERROGATE that warm worker to confirm the
// cause before proposing a fix — pausing once to let a human choose how to ship it.
//
// This one script exercises the whole toolbox:
//   • a classic parallel fan-out          (phase Triage)
//   • a race of sessionful workers + cancel the losers   (phase Hunt, agent.waitAny)
//   • steering the winner on warm context  (session.steer — a 2nd turn, no re-read)
//   • a human() decision gate              (answer it live in the viewer, or default)
//   • a lone synthesis gate                (phase Fix, xhigh under --auto-effort)
//
// The bundled run under .workflow-journal/ is what `npm run demo` opens. To run it
// for real:  node runner/bin/run-workflow.js examples/incident-demo/checkout-incident.workflow.js \
//              --frontier --auto-effort --sandbox read-only --gui
// Runs under --plan (no Codex, no tokens): human() returns its default; the race is counted.

export const meta = {
  name: "checkout-incident",
  description: "Diagnose a checkout p99 latency regression: triage, race hypotheses, confirm on a warm worker, gate the fix.",
  phases: [
    { title: "Triage", detail: "read the signals in parallel — metrics, logs, recent deploys" },
    { title: "Hunt", detail: "race root-cause hypotheses as live workers; keep the first, cancel the rest" },
    { title: "Fix", detail: "synthesize the confirmed cause into a reviewed patch" },
  ],
};

const RO = { sandbox: "read-only" };

// ① Triage — three cheap reads, in parallel, of what the incident looks like.
phase("Triage");
const [metrics, logs, deploys] = await parallel([
  () => agent("Summarize the checkout latency incident from the dashboards: which percentiles moved, error rate, throughput, and the exact onset. Signals with severity.", { label: "triage:metrics", phase: "Triage", ...RO }),
  () => agent("Scan the logs around onset for the dominant slow pattern. Distinguish N+1 queries from lock contention from timeouts.", { label: "triage:logs", phase: "Triage", ...RO }),
  () => agent("List every deploy and flag flip in the 2h before onset; rank suspicion.", { label: "triage:deploys", phase: "Triage", ...RO }),
]);

// ② Hunt — race three hypotheses as LIVE workers. Keep the first that lands; cancel
// the losers (no waiting for the slowest, no paying for work you won't use).
phase("Hunt");
const leads = [
  ["hunt:n+1", "Test the hypothesis that a recent refactor introduced an N+1 query in cart serialization. Find the exact file:line and the mechanism."],
  ["hunt:pool", "Test the hypothesis that this is DB connection-pool exhaustion under load."],
  ["hunt:cache", "Test the hypothesis that this is a cache stampede after a TTL expiry."],
];
// Start the workers inside parallel() so --auto-effort sees the real layer
// width (3 → `high`, the shape in the bundled journal); a plain loop starts
// each at width 1 → `xhigh`, so the documented rerun wouldn't reproduce it.
const workers = (
  await parallel(
    leads.map(([label, prompt]) => () =>
      agent.start(`${prompt}\n\nContext:\n${JSON.stringify({ metrics, logs, deploys })}`, { label, phase: "Hunt", ...RO }),
    ),
  )
).filter(Boolean);
const winner = await agent.waitAny(workers);
for (const s of winner.pendingSessions) await s.cancel(); // stop the losers

// Interrogate the winner on its WARM thread — a confirming follow-up, not a re-read.
const confirm = await winner.session.steer(
  "Confirm or refute on the held repro: force the suspected path and report the before/after p99 and query count.",
  { wait: true },
);
await winner.session.close();

// A fork only a human should own: how to ship the fix. Pauses HERE (fleet warm);
// with --gui an answer card appears in the viewer; unattended runs take the default.
const how = await human(
  `Root cause confirmed:\n${JSON.stringify(confirm.result)}\n\nShip the fix as a direct prod-config hotfix, or open a reviewed PR?`,
  { id: "ship", choices: ["hotfix-now", "open-pr"], default: "open-pr", timeoutMs: 600_000 },
);

// ③ Fix — one lone synthesis gate turns the confirmed cause into a concrete patch.
phase("Fix");
const patch = await agent(
  `Confirmed root cause:\n${JSON.stringify(winner.snapshot.result)}\nConfirmation:\n${JSON.stringify(confirm.result)}\n` +
    `Decision: ${how}. Produce the minimal patch (file:line), a regression test that would have caught it, the risk, and a rollout plan.`,
  { label: "fix:patch", phase: "Fix", ...RO },
);

return {
  headline: `Checkout p99 regression — ${winner.snapshot.label}`,
  root_cause: winner.snapshot.result,
  confirmation: confirm.result,
  decision: how,
  fix: patch,
};
