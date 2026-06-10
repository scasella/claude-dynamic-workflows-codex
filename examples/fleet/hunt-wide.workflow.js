// Fleet variant B — the WIDE bet: independent one-shot sweeps over different
// evidence angles, a supervisor scope gate, then refute-by-default verification.
// Where variant A bets one deep context wins, this bets coverage + independence
// wins. Run both; let the supervisor compare.
//
//   node runner/bin/run-workflow.js examples/fleet/hunt-wide.workflow.js \
//     --frontier --auto-effort --interactive --budget 3500000
// (Budget note: the 4 sweep agents READ the repo, which costs ~500k each
// regardless of effort tier — size read-heavy fan-outs by that, not --plan's
// per-effort estimate. Measured live: 4 low-effort sweeps = 2.1M.)

export const meta = {
  name: 'fleet-hunt-wide',
  description: 'Wide independent sweep over evidence angles → supervisor scope gate → refute-by-default verify',
  phases: [{ title: 'Sweep' }, { title: 'Verify' }, { title: 'Rank' }],
}

const goal = (args && args.goal) ||
  'Find the most likely root cause of flaky or slow behavior in this repository.'

const ANGLES = [
  'recent changes — git log/diffs, what changed before the symptom',
  'configuration and environment — configs, env handling, version pins',
  'dependencies — lockfiles, upgrades, known-bad versions',
  'code hot spots — the paths the symptom implicates, read closely',
]

const LEAD = {
  type: 'object',
  additionalProperties: false,
  required: ['lead', 'evidence', 'confidence'],
  properties: {
    lead: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}
const CHECK = {
  type: 'object',
  additionalProperties: false,
  required: ['holds', 'why'],
  properties: { holds: { type: 'boolean' }, why: { type: 'string' } },
}

phase('Sweep')
const leads = (
  await parallel(
    ANGLES.map((angle) => () =>
      agent(
        `${goal}\n\nInvestigate ONLY through this lens: ${angle}.\n` +
          'Report your single best lead with concrete evidence (file:line, commit, config key). ' +
          'If this lens shows nothing, say so — a null lead beats a fabricated one.',
        { label: `sweep:${angle.split(' ')[0]}`, phase: 'Sweep', schema: LEAD, sandbox: 'read-only' },
      ),
    ),
  )
).filter(Boolean)

// Supervisor scope gate: verifying everything is the safe default; the
// supervisor can narrow to the strongest leads to save the budget for ranking.
const scope = await human(
  `Sweep done — ${leads.length} leads:\n` +
    leads.map((l, i) => `${i + 1}. [${l.confidence}] ${l.lead}`).join('\n') +
    '\n\nVerify all, or only the high-confidence ones?',
  { id: 'scope', choices: ['all', 'high-only'], default: 'all', timeoutMs: 240_000 },
)
const toVerify = scope === 'high-only' ? leads.filter((l) => l.confidence === 'high') : leads

phase('Verify')
const verified = await parallel(
  toVerify.map((l) => () =>
    agent(
      `Try to REFUTE this root-cause lead — default to holds:false unless the evidence survives your attack:\n` +
        JSON.stringify(l),
      { label: 'refute', phase: 'Verify', schema: CHECK, sandbox: 'read-only' },
    ).then((v) => ({ ...l, verdict: v })),
  ),
)
const confirmed = verified.filter(Boolean).filter((l) => l.verdict && l.verdict.holds)

phase('Rank')
const ranking = await agent(
  'Rank these CONFIRMED root-cause leads by likelihood; explain the ordering briefly. ' +
    'If none survived, say what that rules out.\n\n' + JSON.stringify(confirmed),
  { label: 'rank', phase: 'Rank', sandbox: 'read-only' },
)
return { variant: 'wide', sweeps: leads.length, confirmed, ranking }
