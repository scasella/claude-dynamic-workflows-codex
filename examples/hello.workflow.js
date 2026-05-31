// Trivial 2-agent smoke test. Authored exactly like a Claude Code dynamic
// workflow — `export const meta` + a body using the injected globals — but
// every agent() here runs on the local Codex App Server.

export const meta = {
  name: "hello-codex",
  description: "Two Codex agents in parallel: one plain string, one schema-constrained",
  phases: [{ title: "Answer" }],
};

phase("Answer");

const [pong, capital] = await parallel([
  () => agent("Reply with exactly one word: pong. No punctuation, nothing else.", { effort: "low" }),
  () =>
    agent("What is the capital of France? Respond using the provided schema.", {
      effort: "low",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["capital"],
        properties: { capital: { type: "string" } },
      },
    }),
]);

log(`plain   → ${JSON.stringify(pong)}`);
log(`schema  → ${JSON.stringify(capital)}`);

return { pong, capital };
