// Warm-context interrogation — "load once, ask many" (session.steer).
//
// NEW capability: one worker ingests an expensive corpus ONCE (a repo, a data
// room, a log bundle), then answers a STREAM of follow-up questions on the SAME
// thread via session.steer() — reusing the already-built context. Later questions
// can build on earlier answers, because the worker remembers them.
//
// Why this needs the new feature: with one-shot agent(), every question is a COLD
// thread, so each of N follow-ups re-reads the whole corpus from scratch (≈N×
// ingestion cost) and can't see the cross-references it built earlier. steer() pays
// ingestion once, then each question is a cheap delta on warm context. (Watch the
// per-turn token counts: the Ingest turn is large; the follow-ups are small.)
//
//   node .../bin/run-workflow.js examples/warm-context-interrogation.workflow.js \
//     --frontier --sandbox read-only --budget 3000000 \
//     --args '{"target":"runner/src","questions":["...","..."]}'
//
// Runs under --plan (planned sessions return schema skeletons; the question loop is
// bounded by the questions list).

export const meta = {
  name: "warm-context-interrogation",
  description: "Ingest a corpus once, then stream follow-up questions on the same warm worker (steer)",
  phases: [
    { title: "Ingest", detail: "one worker reads + indexes the corpus once (the expensive turn)" },
    { title: "Interrogate", detail: "steer the SAME worker with each follow-up (warm context)" },
  ],
};

const TARGET = (args && args.target) || ".";
const QUESTIONS = (args && Array.isArray(args.questions) && args.questions.length)
  ? args.questions
  : [
      "What is the overall architecture and what are the main entry points?",
      "Where is the riskiest or most complex code, and why?",
      "Building on your previous answer, what exactly would you read next to confirm that risk?",
    ];

const ANSWER = {
  type: "object", additionalProperties: false,
  required: ["answer", "citations", "confidence"],
  properties: {
    answer: { type: "string" },
    citations: { type: "array", items: { type: "string" }, description: "file:line or doc refs" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

// ── Ingest: one long-lived worker reads the corpus ONCE (the expensive turn) ───
phase("Ingest");
const examiner = await agent.start(
  `Read and build a thorough mental index of the material under "${TARGET}". You will answer a stream ` +
    `of follow-up questions about it on THIS thread, so retain what you learn. Reply "indexed" plus a ` +
    `one-line summary of what you ingested.`,
  { label: "examiner", phase: "Ingest", sandbox: "read-only" },
);
const ingest = await examiner.wait();
log(`ingest: ${ingest.status} (${ingest.tokens ?? "?"} tokens) — ${String(ingest.text || "").slice(0, 80)}`);

// ── Interrogate: each question is a follow-up turn on the SAME warm thread ─────
phase("Interrogate");
const qa = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  const snap = await examiner.steer(
    `Q${i + 1}: ${q}\nAnswer from the context you ALREADY ingested (do not re-read everything). ` +
      `Cite file:line or doc refs. You may build on your earlier answers.`,
    { wait: true, schema: ANSWER },
  );
  qa.push({ question: q, ...(snap.result || {}), turnTokens: snap.tokens, ms: snap.ms });
  log(`Q${i + 1} → ${snap.status} (${snap.tokens ?? "?"} tokens this turn)`);
}

await examiner.close();
return { target: TARGET, ingestedOnce: true, qa };
