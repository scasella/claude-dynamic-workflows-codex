// Tournament / pairwise-sort: rank a large list by a *qualitative* criterion that
// no single sort key captures, without ever loading the whole list into one
// agent's context. Split into buckets, rank each bucket in parallel, then a single
// judge k-way-merges the bucket orders into one global ranking.
//
// This is the blog's "sort 1000+ rows without context overflow" pattern: bucket
// width bounds each agent's input; the lone merge agent is the only one that sees
// all the (already-ordered) candidates, and under --auto-effort it runs at xhigh.
//
//   node runner/bin/run-workflow.js examples/tournament-sort.workflow.js --frontier --auto-effort \
//     --args '{"criterion":"most likely to be a flaky test","items":["test_a timing out","test_b asserts on Date.now",...]}'

export const meta = {
  name: "tournament-sort",
  description: "Rank a list by a qualitative criterion via bucketed pairwise ranking + a merge judge",
  phases: [
    { title: "Rank buckets", detail: "rank each bucket of candidates in parallel" },
    { title: "Merge", detail: "one judge k-way-merges the bucket orders" },
  ],
};

const ITEMS = (args && Array.isArray(args.items) ? args.items : []).map(String);
const CRITERION = (args && args.criterion) || "best overall, most important first";
const BUCKET = Math.max(2, (args && Number(args.bucketSize)) || 8);

if (ITEMS.length < 2) {
  log('tournament-sort needs ≥2 items. Pass --args \'{"items":[...],"criterion":"..."}\'.');
  return { ranked: ITEMS, criterion: CRITERION, note: "nothing to rank" };
}

const ORDER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["order"],
  properties: {
    order: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "reason"],
        properties: { item: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

// Split into contiguous buckets (index math only — no Math.random, which the
// runtime blocks for resume safety).
const buckets = [];
for (let i = 0; i < ITEMS.length; i += BUCKET) buckets.push(ITEMS.slice(i, i + BUCKET));

phase("Rank buckets");
const rankedBuckets = await parallel(
  buckets.map((bucket, bi) => () =>
    agent(
      `Rank these ${bucket.length} candidates from MOST to LEAST by this criterion: "${CRITERION}".\n` +
        `Return every candidate exactly once, best first, each with a one-line reason.\n\n` +
        bucket.map((it, j) => `${j + 1}. ${it}`).join("\n"),
      { label: `rank:bucket-${bi + 1}`, schema: ORDER_SCHEMA },
    ),
  ),
);

// Drop any failed bucket to its original order so nothing is lost.
const orderedBuckets = rankedBuckets.map((r, bi) =>
  r && Array.isArray(r.order) && r.order.length ? r.order.map((o) => o.item) : buckets[bi],
);

phase("Merge");
const MERGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked"],
  properties: {
    ranked: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "rank", "reason"],
        properties: { item: { type: "string" }, rank: { type: "integer" }, reason: { type: "string" } },
      },
    },
  },
};
const merged = await agent(
  `You are merging ${orderedBuckets.length} already-ranked shortlists into ONE global ranking by this ` +
    `criterion: "${CRITERION}". Each list is already best-first. Produce a single ordered list of all ` +
    `${ITEMS.length} items, best first, with a rank (1 = best) and a one-line reason. Do not drop or invent items.\n\n` +
    orderedBuckets.map((b, i) => `List ${i + 1}:\n` + b.map((it, j) => `  ${j + 1}. ${it}`).join("\n")).join("\n\n"),
  { label: "merge:global-ranking", schema: MERGE_SCHEMA },
);

return {
  criterion: CRITERION,
  buckets: buckets.length,
  ranked: merged && Array.isArray(merged.ranked) ? merged.ranked : orderedBuckets.flat().map((item, i) => ({ item, rank: i + 1, reason: "merge unavailable — bucket order" })),
};
