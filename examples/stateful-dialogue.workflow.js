// Stateful multi-round dialogue — two long-lived workers that each REMEMBER the
// whole exchange (agent.start + session.steer), judged by a fresh cold agent.
//
// NEW capability: each side is a persistent thread that retains its own position and
// the full back-and-forth. We relay only the OPPONENT's latest message into each
// steer; the worker already remembers everything it said.
//
// Why this needs the new feature: with one-shot agent(), every "round" is a COLD
// worker that must be re-fed the ENTIRE growing transcript to know what was said —
// O(rounds^2) tokens, and the "debater" has no persistent stance (it can forget it
// already conceded a point). steer() gives each side genuine memory at O(rounds).
//
// Note the deliberate split: the two DEBATERS are stateful sessions (memory is the
// point); the JUDGE is a cold one-shot agent() (independence is the point — a session
// would let it rationalize). That contrast is exactly when to use which.
//
//   node .../bin/run-workflow.js examples/stateful-dialogue.workflow.js \
//     --frontier --sandbox read-only --budget 3000000 \
//     --args '{"subject":"Should service X adopt event sourcing?","roleA":"proponent","roleB":"skeptic","rounds":3}'
//
// Runs under --plan (bounded by the rounds count).

export const meta = {
  name: "stateful-dialogue",
  description: "Two long-lived agents argue across rounds with full memory; a fresh judge rules",
  phases: [
    { title: "Open", detail: "each side stakes its initial position (two persistent threads)" },
    { title: "Exchange", detail: "relay each side's latest point to the other (warm memory)" },
    { title: "Judge", detail: "a fresh, independent agent scores the exchange" },
  ],
};

const SUBJECT = (args && args.subject) || "Should this project adopt sessionful worker orchestration as its default?";
const ROLE_A = (args && args.roleA) || "proponent";
const ROLE_B = (args && args.roleB) || "skeptic";
const ROUNDS = (args && args.rounds) || 3;

const TURN = {
  type: "object", additionalProperties: false,
  required: ["message", "key_point", "concedes"],
  properties: {
    message: { type: "string" },
    key_point: { type: "string" },
    concedes: { type: ["string", "null"], description: "a point you concede to the opponent, or null" },
  },
};
const VERDICT = {
  type: "object", additionalProperties: false,
  required: ["winner", "reasoning", "strongest_point"],
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    reasoning: { type: "string" },
    strongest_point: { type: "string" },
  },
};

const brief = (role) =>
  `You are the ${role} in a structured debate. Subject:\n${SUBJECT}\n\nThis is a multi-round exchange on ONE ` +
  `thread — remember everything you and your opponent say. Argue your side, be specific, and concede a point ` +
  `only when it is honest to do so. Keep each message tight.`;

// ── Open: each side stakes a position (two persistent threads) ─────────────────
phase("Open");
const A = await agent.start(`${brief(ROLE_A)}\n\nOpen with your strongest position.`,
  { label: "side-A", phase: "Open", sandbox: "read-only", schema: TURN });
let aT = await A.wait();
const B = await agent.start(`${brief(ROLE_B)}\n\nYour opponent opened:\n"${aT.result?.message ?? ""}"\n\nRespond.`,
  { label: "side-B", phase: "Open", sandbox: "read-only", schema: TURN });
let bT = await B.wait();
const transcript = [{ side: "A", ...(aT.result || {}) }, { side: "B", ...(bT.result || {}) }];

// ── Exchange: relay ONLY the opponent's latest line into each warm worker ──────
phase("Exchange");
for (let round = 1; round < ROUNDS; round++) {
  aT = await A.steer(
    `Your opponent just argued:\n"${bT.result?.message ?? ""}"\n\nRebut, building on YOUR earlier points (you remember them).`,
    { wait: true, schema: TURN });
  transcript.push({ side: "A", round, ...(aT.result || {}) });
  bT = await B.steer(
    `Your opponent just argued:\n"${aT.result?.message ?? ""}"\n\nRebut, remembering the full exchange.`,
    { wait: true, schema: TURN });
  transcript.push({ side: "B", round, ...(bT.result || {}) });
}
await A.close();
await B.close();

// ── Judge: a FRESH, independent one-shot agent (NOT a session) rules ───────────
phase("Judge");
const verdict = await agent(
  `You are an impartial judge who did NOT participate. Score this debate on "${SUBJECT}".\n` +
    `Side A = ${ROLE_A}, Side B = ${ROLE_B}.\n\n${JSON.stringify(transcript, null, 2)}\n\n` +
    `Decide the winner (A / B / tie), explain why, and name the single strongest point made.`,
  { label: "judge", phase: "Judge", schema: VERDICT },
);

return { subject: SUBJECT, roles: { A: ROLE_A, B: ROLE_B }, rounds: ROUNDS, transcript, verdict };
