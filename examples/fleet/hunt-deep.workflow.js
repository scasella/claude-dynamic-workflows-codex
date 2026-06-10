// Fleet variant A — the DEEP bet: one long-lived sessionful investigator that
// keeps its context across rounds, with a supervisor checkpoint between rounds.
// The checkpoint is the steer channel: `continue` goes one level deeper on the
// current lead, free text is applied verbatim as a directive on the SAME warm
// thread, `stop` ends the hunt. Unanswered, it defaults to `stop` — the safe
// hands-off degradation (don't burn tokens unsupervised).
//
// Run it as part of the fleet (see this directory's README), or alone:
//   node runner/bin/run-workflow.js examples/fleet/hunt-deep.workflow.js \
//     --frontier --auto-effort --interactive --budget 1200000
// Answer its checkpoints from outside:
//   node runner/bin/fleet.js answer --journal <journal> --id round1 --answer \
//     'drop that lead; look at the test fixtures instead'

export const meta = {
  name: 'fleet-hunt-deep',
  description: 'One steerable deep investigator: rounds on a warm thread, supervisor checkpoint between rounds',
  phases: [{ title: 'Investigate' }, { title: 'Report' }],
}

const goal = (args && args.goal) ||
  'Find the most likely root cause of flaky or slow behavior in this repository.'
const maxRounds = (args && args.maxRounds) || 3

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['rootCause', 'confidence', 'evidence', 'wouldFalsify'],
  properties: {
    rootCause: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: { type: 'array', items: { type: 'string' } },
    wouldFalsify: { type: 'string' },
  },
}

phase('Investigate')
const worker = await agent.start(
  `${goal}\n\nInvestigate hands-on, depth-first: pick the single most promising lead and chase it.\n` +
    'End every reply with two lines:\nFINDING: <one sentence>\nCONFIDENCE: <low|medium|high>',
  { label: 'investigator', sandbox: 'read-only' },
)
let snap = await worker.wait()
let rounds = 1

while (rounds < maxRounds && snap.status === 'completed') {
  const tail = String(snap.text || snap.result || '').slice(-500)
  const directive = await human(
    `Deep investigator, round ${rounds}:\n${tail}\n\nDirective for round ${rounds + 1}? (free text = a steer)`,
    { id: `round${rounds}`, choices: ['continue', 'stop'], default: 'stop', timeoutMs: 300_000 },
  )
  if (directive === 'stop') break
  const msg =
    directive === 'continue'
      ? 'Go one level deeper on your current best lead. Same FINDING:/CONFIDENCE: footer.'
      : `Supervisor directive: ${directive}\nApply it before anything else. Same FINDING:/CONFIDENCE: footer.`
  snap = await worker.steer(msg) // same warm thread — no re-reading
  rounds++
}

phase('Report')
const verdict = await agent(
  'Write the final verdict from this investigation transcript tail. Be honest about confidence; ' +
    'separate observed evidence from inference.\n\n' + String(snap.text || snap.result || '').slice(-2500),
  { label: 'verdict', phase: 'Report', schema: VERDICT, sandbox: 'read-only' },
)
return { variant: 'deep', rounds, verdict }
