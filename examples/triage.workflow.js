// Triage at scale: classify a pile of items, dedupe, then route to actions —
// with a *quarantine* between the untrusted content and any privileged step.
//
// The classify wave runs read-only (it can read the repo to judge an item, but
// can't act), so untrusted item text never reaches a write-capable agent. Dedupe
// is plain code. A single router then proposes actions from the *structured*
// labels — not the raw text — which shrinks the prompt-injection surface. Acting
// on those proposals is a separate, human-gated step, not part of this run.
//
//   node runner/bin/run-workflow.js examples/triage.workflow.js --frontier --auto-effort --sandbox read-only \
//     --args '{"items":[{"id":"1024","text":"crash on empty config"},{"id":"1030","text":"NPE in config loader"}]}'

export const meta = {
  name: "triage",
  description: "Classify + dedupe + route a batch of items, with privilege separation",
  phases: [
    { title: "Classify", detail: "one read-only agent per item (the quarantine)" },
    { title: "Route", detail: "a single router proposes actions from labels only" },
  ],
};

// Accept [{id,text}] or bare strings.
const RAW = (args && Array.isArray(args.items) ? args.items : []);
const ITEMS = RAW.map((it, i) =>
  typeof it === "string" ? { id: String(i + 1), text: it } : { id: String(it.id ?? i + 1), text: String(it.text ?? "") },
);
const CATEGORIES = (args && Array.isArray(args.categories) && args.categories.length)
  ? args.categories
  : ["bug", "feature-request", "question", "duplicate", "spam", "needs-info"];

if (!ITEMS.length) {
  log('triage needs items. Pass --args \'{"items":[{"id":"1","text":"..."}]}\'.');
  return { classified: [], routing: null, note: "no items" };
}

const CLASS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "severity", "dedupe_key", "summary"],
  properties: {
    category: { type: "string", enum: CATEGORIES },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    dedupe_key: { type: "string", description: "a normalized key; identical for items describing the same underlying thing" },
    summary: { type: "string" },
  },
};

phase("Classify");
const classified = await parallel(
  ITEMS.map((it) => () =>
    agent(
      `Classify this item for triage. Categories: ${CATEGORIES.join(", ")}.\n` +
        `Pick the best category and severity, write a one-line summary, and a normalized dedupe_key ` +
        `(short, lowercased, so two items about the same underlying problem share a key).\n\n` +
        `Item #${it.id}:\n${it.text}`,
      { label: `classify:${it.id}`, sandbox: "read-only", schema: CLASS_SCHEMA },
    ).then((c) => (c ? { id: it.id, ...c } : null)),
  ),
);

// Dedupe by dedupe_key — plain code, no agent. Keep the highest-severity exemplar
// of each group and record the members.
const SEV = { high: 3, medium: 2, low: 1 };
const groups = new Map();
for (const c of classified.filter(Boolean)) {
  const k = c.dedupe_key || c.id;
  const g = groups.get(k);
  if (!g) groups.set(k, { ...c, members: [c.id] });
  else {
    g.members.push(c.id);
    if ((SEV[c.severity] || 0) > (SEV[g.severity] || 0)) Object.assign(g, c, { members: g.members });
  }
}
const deduped = [...groups.values()];
log(`classified ${classified.filter(Boolean).length} → ${deduped.length} after dedupe`);

phase("Route");
const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "action", "ids", "rationale"],
        properties: {
          category: { type: "string" },
          action: { type: "string", description: "proposed next step (not executed here)" },
          ids: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
      },
    },
  },
};
// The router sees only the structured labels (category/severity/summary/ids) — not
// the raw, untrusted item text — so item content can't steer a privileged step.
const routing = await agent(
  `You are triaging a deduped batch. For each group below, propose ONE next action (e.g. "auto-close as ` +
    `duplicate", "label + assign", "request more info", "escalate"). Group by category. These actions are ` +
    `proposals for a human to approve — do not execute anything.\n\n` +
    deduped
      .map((g) => `- id(s) ${g.members.join(",")} · ${g.category} · ${g.severity} · ${g.summary}`)
      .join("\n"),
  { label: "route:proposals", schema: ROUTE_SCHEMA },
);

return {
  classified: classified.filter(Boolean),
  deduped_count: deduped.length,
  routing,
};
