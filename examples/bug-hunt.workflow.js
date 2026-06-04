// Loop-until-dry bug hunt with majority refute-by-default verification.
//
// Unknown-size discovery: several finder lenses sweep the target in parallel each
// round, candidates are deduped against everything seen, and the hunt loops until
// it goes K rounds without finding anything new (or hits a round cap). Survivors
// are then checked by independent skeptics — each told to REFUTE by default — and a
// candidate is kept only if a *majority* of skeptics cannot refute it.
//
//   node .../bin/run-workflow.js bug-hunt.workflow.js --frontier --auto-effort \
//     --sandbox read-only --budget 6000000 \
//     --args '{"target":"src/","focus":"correctness, security, and resource leaks"}'
//
// Patterns: loop-until-dry (dedupe vs a `seen` Set, stop after K empty rounds) +
// majority adversarial verify (refute-by-default; killed only if the majority
// refute). The agents read the target; the script itself stays sandboxed. Size
// --budget for the whole fan-out — run --plan first to count agents.

export const meta = {
  name: "bug-hunt",
  description: "Loop-until-dry discovery + majority refute-by-default verification",
  phases: [
    { title: "Hunt", detail: "finder lenses sweep in parallel each round until K dry rounds" },
    { title: "Verify", detail: "independent skeptics refute-by-default; the majority decides" },
  ],
};

const TARGET = (args && args.target) || ".";
const FOCUS = (args && args.focus) || "correctness bugs, security issues, and resource leaks";
const DRY_ROUNDS = (args && args.dryRounds) || 2; // stop after this many rounds with nothing new
const MAX_ROUNDS = (args && args.maxRounds) || 5; // hard cap (also bounds a --plan dry run)
const SKEPTICS = (args && args.skeptics) || 3; // independent verifiers per surviving candidate

// Distinct finder lenses — every round runs all of them in parallel. The point is
// diversity: each lens surfaces a class of issue a single generic pass would miss.
const LENSES = [
  { key: "logic", brief: "logic & control-flow errors, off-by-one, inverted conditionals" },
  { key: "edge", brief: "unhandled edge cases: empty / null / overflow / boundary inputs" },
  { key: "security", brief: "injection, authz gaps, unsafe deserialization, leaked secrets" },
  { key: "resource", brief: "leaks, unclosed handles, unbounded growth, missing cleanup" },
  { key: "concurrency", brief: "races, deadlocks, shared-state mutation, await ordering" },
];

const BUGS = {
  type: "object", additionalProperties: false, required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "file", "line", "severity", "why"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "string", description: "line number or range, or '?'" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string", description: "the concrete failure mode, not a vague worry" },
        },
      },
    },
  },
};

const VERDICT = {
  type: "object", additionalProperties: false, required: ["refuted", "reason"],
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
};

// Content key for dedup — stable across rounds so a re-found candidate doesn't requeue.
const key = (b) =>
  `${(b.file || "").trim()}:${(b.line || "").trim()}:${(b.title || "").trim().toLowerCase().slice(0, 60)}`;

// ── Hunt: loop until DRY_ROUNDS rounds find nothing new (or the round cap) ────
phase("Hunt");
const seen = new Set();
const candidates = [];
let dry = 0, round = 0;
while (dry < DRY_ROUNDS && round < MAX_ROUNDS) {
  round++;
  const found = (
    await parallel(
      LENSES.map((L) => () =>
        agent(
          `Hunt round ${round}. Inspect ${TARGET} through the "${L.key}" lens: ${L.brief}.\n` +
            `Overall focus: ${FOCUS}. Report only concrete, located bugs you can point to — no ` +
            `style nits. If earlier rounds likely caught the obvious ones, look harder for subtler issues.`,
          { schema: BUGS, label: `hunt:${L.key}#${round}`, phase: "Hunt", sandbox: "read-only" },
        ),
      ),
    )
  )
    .filter(Boolean)
    .flatMap((r) => r.bugs || []);

  // dedup within the round AND against everything seen so far
  const fresh = [];
  for (const b of found) {
    if (!b) continue;
    const k = key(b);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(b);
  }
  if (!fresh.length) { dry++; log(`round ${round}: nothing new (dry ${dry}/${DRY_ROUNDS})`); continue; }
  dry = 0;
  candidates.push(...fresh);
  log(`round ${round}: +${fresh.length} new (${candidates.length} unique so far)`);
}
log(`hunt done after ${round} round(s): ${candidates.length} unique candidate(s)`);

// ── Verify: independent skeptics, refute-by-default; killed only if a MAJORITY refute ──
phase("Verify");
const judged = await parallel(
  candidates.map((b) => () =>
    parallel(
      Array.from({ length: SKEPTICS }, (_, i) => () =>
        agent(
          `Candidate bug in ${b.file} (${b.line}): "${b.title}". ${b.why}\n` +
            `You are skeptic #${i + 1}, working independently. Try to REFUTE it — read the real code ` +
            `path and find why it is NOT a bug (guarded elsewhere, impossible input, intended behavior). ` +
            `Default refuted=true if you cannot convince yourself it's real.`,
          { schema: VERDICT, label: `verify:${b.file}`, phase: "Verify", sandbox: "read-only" },
        ),
      ),
    ).then((votes) => {
      const v = votes.filter(Boolean);
      const refuted = v.filter((x) => x.refuted).length;
      const survives = refuted < Math.floor(SKEPTICS / 2) + 1; // killed only if the majority refute
      return { ...b, skeptics: v.length, refuted, survives, dissent: v.filter((x) => x.refuted).map((x) => x.reason) };
    }),
  ),
);

const rank = { high: 0, medium: 1, low: 2 };
const confirmed = judged
  .filter(Boolean)
  .filter((b) => b.survives)
  .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
log(`confirmed ${confirmed.length}/${candidates.length} after majority refute-by-default`);

return { target: TARGET, focus: FOCUS, rounds: round, candidates: candidates.length, confirmed };
