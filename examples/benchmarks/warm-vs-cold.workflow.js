// Warm-vs-cold benchmark — measure the "load once, ask many" claim instead of
// asserting it. Two arms answer the SAME questions about the SAME corpus:
//
//   Warm  one sessionful worker ingests the corpus ONCE (turn 0), then answers
//         every question as a steer on its warm thread (no re-reading).
//   Cold  one fresh one-shot agent per question — each must re-read the corpus
//         from scratch (the only option in the native one-shot DSL).
//
// The measurement is the run's own journal: per-agent/per-turn tokens and wall
// time, split by phase. Read it with:
//   node runner/bin/summarize-run.js <run-dir>          (By-phase + Sessionful workers)
//   node runner/bin/summarize-run.js <run-dir> --json   (machine-readable)
// The workflow also returns the warm worker's per-turn numbers directly.
//
//   node runner/bin/run-workflow.js examples/benchmarks/warm-vs-cold.workflow.js \
//     --frontier --effort medium --sandbox read-only \
//     --args '{"scope":"runner/src","questions":["…","…","…"]}'
//
// Runs under --plan (no Codex, no tokens): counts 1 ingest + N steers + N cold agents.

export const meta = {
  name: "warm-vs-cold",
  description: "Benchmark: one warm worker steered through N questions vs N cold one-shot agents",
  phases: [
    { title: "Warm", detail: "ingest once, then steer each question on the warm thread" },
    { title: "Cold", detail: "a fresh agent per question — re-reads the corpus every time" },
  ],
};

const scope = (args && args.scope) || "runner/src";
const questions = (args && Array.isArray(args.questions) && args.questions.length)
  ? args.questions.map(String)
  : [
      "Which module owns retry/backoff policy, and what classes of error are retried?",
      "How does the resume journal decide whether a call replays from cache?",
      "What exactly does a budget of N tokens gate, and what happens when it trips?",
    ];

const READ = `Read the files under ${scope} in this repository (read-only).`;

phase("Warm");
const oracle = await agent.start(
  `${READ} Build a mental map of the modules and how they connect. Reply with READY plus a one-line inventory (module names only) — nothing else yet.`,
  { label: "oracle", phase: "Warm", sandbox: "read-only" },
);
const ingest = await oracle.wait();
const warm = [];
for (let i = 0; i < questions.length; i++) {
  const snap = await oracle.steer(
    `${questions[i]} Answer from what you already read — 3 sentences max, cite file names.`,
    { wait: true },
  );
  warm.push({ q: i + 1, status: snap.status, tokens: snap.tokens, ms: snap.ms, answer: snap.result ?? snap.text });
}
await oracle.close();

phase("Cold");
const cold = await parallel(questions.map((q, i) => () =>
  agent(
    `${READ} Then answer: ${q} 3 sentences max, cite file names.`,
    { label: `cold:q${i + 1}`, phase: "Cold", sandbox: "read-only" },
  ),
));

return {
  scope,
  questions: questions.length,
  warm: { ingest: { status: ingest.status, tokens: ingest.tokens, ms: ingest.ms }, turns: warm },
  coldAnswers: cold,
  how_to_read:
    "Compare the journal's By-phase table (summarize-run): Warm = 1 ingest + N steer turns; " +
    "Cold = N full re-reads. Per-question marginal cost is the steers' tokens/ms vs a cold agent's.",
};
