// Fan-out + synthesize: gather today's US stock-market news from several angles in
// parallel, then write one cited brief. (The blog's fan-out-and-synthesize pattern.)
//
// Needs the Codex agents to reach live data — either a web-search tool or a
// network-enabled sandbox (run with `--sandbox danger-full-access`, or enable
// network for workspace-write in your Codex config). Agents are told to fetch live
// and to mark clearly when a figure is from prior knowledge instead, so the brief
// is honest either way. The sandboxed script can't read the clock, so the date
// comes in via --args (demo-live injects today's date automatically).
//
//   node runner/bin/run-workflow.js examples/market-news.workflow.js --frontier --auto-effort \
//     --sandbox danger-full-access --args '{"date":"June 3, 2026"}'

export const meta = {
  name: "market-news",
  description: "Gather today's US stock-market news across several angles, then synthesize a brief",
  phases: [
    { title: "Gather", detail: "one agent per angle, in parallel" },
    { title: "Synthesize", detail: "combine the angles into one cited brief" },
  ],
};

const DATE = (args && args.date) || "today";
// Each facet has a short key (for clean map labels) + the question to research.
// Override with --args '{"facets":["...","..."]}' (strings get auto-keyed).
const DEFAULT_FACETS = [
  { key: "indices", q: "the closing levels and percent change of the S&P 500, Dow Jones Industrial Average, and Nasdaq Composite" },
  { key: "movers", q: "the biggest individual stock movers (notable gainers and losers) and why they moved" },
  { key: "sectors", q: "sector performance — which S&P 500 sectors led and which lagged" },
  { key: "macro", q: "the macro drivers of the session: the Federal Reserve, interest rates, Treasury yields, and economic data releases" },
  { key: "catalysts", q: "the day's biggest corporate catalysts and earnings news" },
];
const FACETS =
  args && Array.isArray(args.facets) && args.facets.length
    ? args.facets.map((f, i) => (typeof f === "string" ? { key: "facet-" + (i + 1), q: f } : f))
    : DEFAULT_FACETS;

const GATHER = {
  type: "object",
  additionalProperties: false,
  required: ["facet", "summary", "points", "sources", "as_of", "live"],
  properties: {
    facet: { type: "string" },
    summary: { type: "string" },
    points: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } },
    },
    sources: { type: "array", items: { type: "string", description: "source URL" } },
    as_of: { type: "string", description: "the date/time the figures actually reflect" },
    live: { type: "boolean", description: "true only if fetched from the live web for the requested date; false if from prior knowledge" },
  },
};

phase("Gather");
const gathered = await parallel(
  FACETS.map((facet) => () =>
    agent(
      `Find US stock-market news for ${DATE} about ${facet.q}.\n` +
        `Use web search / fetch live sources and report concrete numbers, each with its source URL. ` +
        `Set "live": true ONLY if you actually retrieved data for ${DATE}. If you cannot reach live data, ` +
        `set "live": false, give your most recent known figures, and put the real date in "as_of".`,
      { label: "gather:" + facet.key, schema: GATHER },
    ),
  ),
);
const findings = gathered.filter(Boolean);

phase("Synthesize");
const SYNTH = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "brief", "key_numbers", "sources", "caveats"],
  properties: {
    headline: { type: "string", description: "one line — the day's market story" },
    brief: { type: "string", description: "2–4 short paragraphs of markdown" },
    key_numbers: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } },
    },
    sources: { type: "array", items: { type: "string" } },
    caveats: { type: "array", items: { type: "string", description: "anything unverified or not live" } },
  },
};
const brief = await agent(
  `Write a concise US stock-market wrap for ${DATE} from these gathered findings. Lead with the headline, ` +
    `then a short brief. Include the key index numbers, dedupe the sources, and list caveats for anything ` +
    `that was not live or could not be verified.\n\n` +
    findings.map((f, i) => `[${i + 1}] ${f.facet} (live=${f.live}, as_of=${f.as_of}): ${f.summary}`).join("\n"),
  { label: "synthesize:brief", schema: SYNTH },
);

return {
  date: DATE,
  headline: brief?.headline ?? null,
  brief,
  sources_gathered: findings.flatMap((f) => f.sources || []).length,
  gathered: findings,
};
