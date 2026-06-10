// Checks for the ASCII map renderer (src/asciiMap.js) + its integration with the
// shared run model (src/runModel.js). No terminal, no tokens.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildRunModel, buildLiveRunModel, liveState, locateRun } from "../src/runModel.js";
import { renderMap, agentSnippet } from "../src/asciiMap.js";

const MAP_BIN = new URL("../bin/map-run.js", import.meta.url).pathname;

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI for assertions

// 1) Multi-phase enriched run: header, phase headers, metrics, barrier, +N collapse.
{
  const concept = [];
  for (let i = 0; i < 14; i++) {
    concept.push({ label: `concept:persona-${i + 1}`, order: 10 + i, phase: "Concept", model: "gpt-5.5", effort: "high", tokens: 300000, ms: 4000, result: {} });
  }
  const run = {
    name: "forge",
    description: "",
    phases: [{ title: "Audit" }, { title: "Concept" }, { title: "Synthesize" }],
    agents: [
      { label: "audit:hero", order: 0, phase: "Audit", model: "gpt-5.5", effort: "high", tokens: 300000, ms: 4200, result: { verdict: "ok" } },
      { label: "audit:cta", order: 1, phase: "Audit", model: "gpt-5.5", effort: "high", tokens: 370000, ms: 5700, result: {} },
      ...concept,
      { label: "synthesize:final", order: 99, phase: "Synthesize", model: "gpt-5.5", effort: "xhigh", tokens: 1200000, ms: 22000, result: { recommended_direction: "Persona-3 bold" } },
    ],
    models: { "gpt-5.5": 17 },
    totals: { tokens: 8000000, ms: 140000, hasMetrics: true },
    counts: { phases: 3, agents: 17 },
    sources: {},
  };
  const s = plain(renderMap(run, { color: false, width: 88, maxAgents: 12 }));
  assert.match(s, /◆ forge/, "orchestrator node has run name");
  assert.match(s, /17\/17 done/, "progress strip shows done count");
  assert.match(s, /Persona-3 bold/, "outcome summary pulled from recommended_direction");
  assert.match(s, /① Audit/, "phase 1 header");
  assert.match(s, /② Concept/, "phase 2 header");
  assert.match(s, /③ Synthesize/, "phase 3 header");
  assert.match(s, /AGENT\s+MODEL\s+EFFORT\s+TOKENS\s+WALL/, "fixed metric grid header");
  assert.match(s, /barrier · Audit → Concept/, "semantic barrier names the phases");
  assert.match(s, /\+3 more/, "14 agents collapse to +3 more at maxAgents 12");
  assert.match(s, /1\.2M\b/, "per-agent token cell (1.2M, no unit suffix in the grid)");
  assert.match(s, /xhigh/, "effort shown on the lone synthesizer");
  assert.match(s, /✦ result/, "result node present");
}

// 2) No metrics (old-style journal): renders, no token columns, no crash.
{
  const run = {
    name: "flat", description: "", phases: [{ title: "Agents" }],
    agents: [{ label: "summarize", order: 0, phase: "Agents", model: null, effort: null, tokens: null, ms: null, result: "hi" }],
    models: {}, totals: { tokens: 0, ms: 0, hasMetrics: false }, counts: { phases: 1, agents: 1 }, sources: {},
  };
  const s = plain(renderMap(run, { color: false, width: 80 }));
  assert.match(s, /◆ flat/);
  assert.match(s, /✓ summarize/);
  assert.doesNotMatch(s, /tok/, "no token column when hasMetrics is false");
}

// 3) Empty run renders gracefully.
{
  const run = { name: "empty", description: "", phases: [], agents: [], models: {}, totals: { tokens: 0, ms: 0, hasMetrics: false }, counts: { phases: 0, agents: 0 }, sources: {} };
  assert.match(plain(renderMap(run, { color: false, width: 80 })), /no agents/);
}

// 4) Color on → ANSI escapes present; off → none.
{
  const run = { name: "c", description: "", phases: [{ title: "P" }], agents: [{ label: "a", order: 0, phase: "P", model: "gpt-5.5", effort: "high", tokens: 1000, ms: 1000, result: {} }], models: { "gpt-5.5": 1 }, totals: { tokens: 1000, ms: 1000, hasMetrics: true }, counts: { phases: 1, agents: 1 }, sources: {} };
  assert.match(renderMap(run, { color: true, width: 80 }), /\x1b\[/, "ANSI when color on");
  assert.doesNotMatch(renderMap(run, { color: false, width: 80 }), /\x1b\[/, "no ANSI when color off");
}

// 5) Integration: buildRunModel from a journal → renderMap totals + phases.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-map-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "r.workflow.jsonl");
  await writeFile(jf, [
    JSON.stringify({ key: "a#0", label: "scan:x", result: { findings: [] }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 400000, ms: 5000 }),
    JSON.stringify({ key: "b#0", label: "report", result: { recommended_direction: "ship it" }, phase: "Report", model: "gpt-5.5", effort: "xhigh", tokens: 900000, ms: 12000 }),
  ].join("\n"));
  const run = buildRunModel({ journalPath: jf, runDir: dir });
  const s = plain(renderMap(run, { color: false, width: 80 }));
  assert.match(s, /Scan/);
  assert.match(s, /Report/);
  assert.match(s, /ship it/, "outcome from the final agent");
  assert.match(s, /1\.3M tok/, "run-total tokens = 400k + 900k = 1.3M");
  assert.equal(run.result, undefined, "no result key when no sidecar exists");
  await rm(dir, { recursive: true, force: true });
}

// 5b) Honest result: buildRunModel reads the *.result.json sidecar into run.result.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-res-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "r.workflow.jsonl");
  await writeFile(jf, JSON.stringify({ key: "a#0", label: "synthesize:plan", result: { headline: "X" }, phase: "Synthesize" }));
  const payload = { headline: "Ship the live viewer", quick_wins: ["atomic writes", "ticking elapsed"] };
  await writeFile(join(jdir, "r.workflow.result.json"), JSON.stringify(payload));
  const run = buildRunModel({ journalPath: jf, runDir: dir });
  assert.deepEqual(run.result, payload, "run.result mirrors the persisted return value");
  await rm(dir, { recursive: true, force: true });
}

// 5c) Live progress: buildLiveRunModel attaches the *.progress.json partial output
// to a still-running agent (shown streaming in the drawer); done agents get none.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-prog-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "r.workflow.jsonl");
  await writeFile(jf, JSON.stringify({ key: "d#0", label: "map:done", result: { ok: 1 }, phase: "Map" }));
  await writeFile(join(jdir, "r.workflow.events.jsonl"), [
    JSON.stringify({ t: 1000, type: "start", label: "map:done", phase: "Map" }),
    JSON.stringify({ t: 2000, type: "end", label: "map:done", phase: "Map" }),
    JSON.stringify({ t: 1500, type: "start", label: "map:live", phase: "Map", model: "gpt-5.5", effort: "high" }),
  ].join("\n"));
  await writeFile(join(jdir, "r.workflow.progress.json"), JSON.stringify({ "map:live": "partial streamed output…", "map:done": "stale, should be ignored" }));
  const run = buildLiveRunModel({ journalPath: jf, runDir: dir });
  const live = run.agents.find((a) => a.label === "map:live");
  const done = run.agents.find((a) => a.label === "map:done");
  assert.ok(live && live.status === "running", "running agent merged from the event stream");
  assert.equal(live.progress, "partial streamed output…", "progress attached to the running agent");
  assert.equal(done.progress, undefined, "no progress on a completed agent (it shows its real result)");
  await rm(dir, { recursive: true, force: true });
}

// 5d) Honest result in the ASCII map: the result node summarizes run.result —
// including a reportMarkdown shape (which the old "final agent" heuristic missed).
{
  const base = { name: "r", description: "", phases: [{ title: "Synthesize" }],
    agents: [{ label: "synthesize", order: 0, phase: "Synthesize", model: "gpt-5.5", effort: "xhigh", tokens: 46000, ms: 130000, result: { reportMarkdown: "# Brief" } }],
    models: { "gpt-5.5": 1 }, totals: { tokens: 46000, ms: 130000, hasMetrics: true }, counts: { phases: 1, agents: 1 }, sources: {} };
  // report-shaped result → first prose line of the markdown
  const md = plain(renderMap({ ...base, result: { reportMarkdown: "# Title\n\nThe top recommendation is to ship the MVP first." } }, { color: false, width: 80 }));
  assert.match(md, /ship the MVP first/, "result node summarizes reportMarkdown");
  assert.doesNotMatch(md, /no result/, "no '(no result)' when run.result is present");
  // headline-shaped result → the headline
  const hl = plain(renderMap({ ...base, result: { headline: "Ship the live viewer" } }, { color: false, width: 80 }));
  assert.match(hl, /Ship the live viewer/, "result node summarizes a headline result");
}

// 6) time formatting rolls over correctly (119.6s → 2m00s, never 1m60s).
{
  const run = {
    name: "t", description: "", phases: [{ title: "P" }],
    agents: [{ label: "a", order: 0, phase: "P", model: "gpt-5.5", effort: "high", tokens: 1000, ms: 119600, result: {} }],
    models: { "gpt-5.5": 1 }, totals: { tokens: 1000, ms: 119600, hasMetrics: true }, counts: { phases: 1, agents: 1 }, sources: {},
  };
  const s = plain(renderMap(run, { color: false, width: 80 }));
  assert.match(s, /2m00s/, "119.6s formats as 2m00s");
  assert.doesNotMatch(s, /1m60s|m60s/, "seconds never reach 60 (rollover)");
}

// 7) liveState: running = a 'start' not yet matched by an 'end'; counts + timing.
{
  const events = [
    { t: 100, type: "start", label: "scan:a", phase: "Scan", model: "gpt-5.5", effort: "high" },
    { t: 150, type: "start", label: "scan:b", phase: "Scan", model: "gpt-5.5", effort: "high" },
    { t: 400, type: "end", label: "scan:a", phase: "Scan", tokens: 1000, ms: 300 },
    { t: 420, type: "start", label: "report", phase: "Report", model: "gpt-5.5", effort: "xhigh" },
  ];
  const ls = liveState(events);
  assert.deepEqual(ls.running.map((r) => r.label).sort(), ["report", "scan:b"], "b + report running; a done");
  assert.equal(ls.runStartedAt, 100);
  assert.equal(ls.lastEventAt, 420);
  assert.equal(liveState([]), null, "no events -> null");
}

// 8) renderMap shows running agents with a spinner + elapsed, and a done/running split.
{
  const run = {
    name: "live", description: "", phases: [{ title: "Scan" }],
    agents: [
      { label: "scan:a", order: 0, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 400000, ms: 5000, result: {} },
      { label: "scan:b", order: 1, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: null, ms: null, result: undefined, status: "running", startedAt: 1000 },
    ],
    models: { "gpt-5.5": 2 }, totals: { tokens: 400000, ms: 5000, hasMetrics: true }, counts: { phases: 1, agents: 2 }, sources: {},
  };
  const s = plain(renderMap(run, { color: false, width: 88, now: 9000, spinner: "⠹" }));
  assert.match(s, /1 done · 1 running/, "phase header shows the done/running split");
  assert.match(s, /⠹ b\b/, "running agent uses the spinner glyph (label shown as 'b')");
  assert.match(s, /✓ a\b/, "completed agent still shows ✓");
  assert.match(s, /8\.0s/, "running agent shows live elapsed (9000-1000=8s) in the WALL column");
  assert.match(s, /--/, "running agent shows -- for not-yet-known tokens");
}

// 9) end-to-end: map-run on a run dir picks the journal (not the .events.jsonl
//    sidecar) and merges running agents from the event stream.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-evt-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  await writeFile(join(jdir, "r.workflow.jsonl"),
    JSON.stringify({ key: "a#0", label: "rank:bucket-1", result: { order: [] }, phase: "Rank", model: "gpt-5.5", effort: "high", tokens: 22000, ms: 37000 }));
  await writeFile(join(jdir, "r.workflow.events.jsonl"), [
    JSON.stringify({ t: 100, type: "start", label: "rank:bucket-1", phase: "Rank", model: "gpt-5.5", effort: "high" }),
    JSON.stringify({ t: 37100, type: "end", label: "rank:bucket-1", phase: "Rank", tokens: 22000, ms: 37000 }),
    JSON.stringify({ t: 37200, type: "start", label: "merge:final", phase: "Merge", model: "gpt-5.5", effort: "xhigh" }),
  ].join("\n"));

  const loc = locateRun({ target: dir });
  assert.ok(loc.journalPath.endsWith("r.workflow.jsonl"), "locateRun picks the journal, not the .events.jsonl sidecar");

  const out = plain(execFileSync("node", [MAP_BIN, dir, "--no-color"], { encoding: "utf8" }));
  assert.match(out, /✓ bucket-1/, "completed agent from the journal");
  assert.match(out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] final/, "running merge agent shown with a spinner from the event stream");
  assert.match(out, /Merge/, "the Merge phase appears as soon as its agent starts");
  await rm(dir, { recursive: true, force: true });
}

// 10) graph layout: node-boxes + per-agent result snippet under each node.
{
  assert.equal(agentSnippet({ summary: "hi there" }), "hi there", "prefers summary");
  assert.equal(agentSnippet({ recommended_direction: "go" }), "go");
  assert.equal(agentSnippet("plain text result"), "plain text result");
  assert.equal(agentSnippet({ nested: { x: 1 } }), null, "no usable string -> null");
  assert.equal(agentSnippet(null), null);

  const run = {
    name: "news", description: "", phases: [{ title: "Gather" }],
    agents: [{ label: "gather:indices", order: 0, phase: "Gather", model: "gpt-5.5", effort: "high", tokens: 52000, ms: 86000, result: { summary: "S&P 500 rose 0.4% to a record 6,012 at the close.", sources: ["http://x"] } }],
    models: { "gpt-5.5": 1 }, totals: { tokens: 52000, ms: 86000, hasMetrics: true }, counts: { phases: 1, agents: 1 }, sources: {},
  };
  const s = plain(renderMap(run, { color: false, width: 92 }));
  assert.match(s, /╭─ ◆ news/, "orchestrator node-box");
  assert.match(s, /▼ ① Gather/, "flow arrow into the phase layer");
  assert.match(s, /[├╰]─✓ indices/, "agent node on a branch edge");
  assert.match(s, /S&P 500 rose 0\.4%/, "the agent's summary renders as a snippet under its node");
  assert.match(s, /╭─ ✦ result/, "result node-box");
}

// 11) sessionful workers: turn agents group into ONE worker row with a per-turn
//     breakdown line; cancelled race losers get the ⊘ glyph; header counts workers.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-map-sess-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "race.workflow.jsonl");
  await writeFile(jf, [
    JSON.stringify({ key: "sess:s1#0", label: "oracle", result: { summary: "Repo ingested; 14 modules mapped." }, phase: "Explore", model: "gpt-5.5", effort: "high", tokens: 52000, ms: 86000, session: true, sessionId: "s1", turn: 0, status: "completed", threadId: "th-1" }),
    JSON.stringify({ key: "sess:s1#1", label: "oracle", result: { summary: "Auth flows traced." }, phase: "Explore", model: "gpt-5.5", effort: "high", tokens: 30000, ms: 40000, session: true, sessionId: "s1", turn: 1, status: "completed", threadId: "th-1" }),
    JSON.stringify({ key: "sess:s2#0", label: "rival", result: null, phase: "Explore", model: "gpt-5.5", effort: "high", tokens: 12000, ms: 20000, session: true, sessionId: "s2", turn: 0, status: "cancelled", threadId: "th-2" }),
    JSON.stringify({ key: "j#0", label: "judge:final", result: { one_line_verdict: "Oracle wins." }, phase: "Judge", model: "gpt-5.5", effort: "xhigh", tokens: 90000, ms: 60000 }),
  ].join("\n"));
  const run = buildRunModel({ journalPath: jf, runDir: dir });
  assert.equal(run.sessions.length, 2, "two workers grouped from turn agents");
  assert.equal(run.sessions[0].turns.length, 2, "oracle has 2 turns");
  assert.equal(run.sessions[0].tokens, 82000, "worker tokens = Σ turn tokens");
  assert.equal(run.sessions[0].status, "completed");
  assert.equal(run.sessions[1].status, "cancelled", "race loser carries its cancelled status");
  const s = plain(renderMap(run, { color: false, width: 88 }));
  assert.match(s, /2 workers/, "orchestrator header counts the workers");
  assert.equal((s.match(/✓ oracle/g) || []).length, 1, "ONE row for the oracle worker, not one per turn");
  assert.match(s, /⟳ 2 turns: ✓ 52k·1m26s → ✓ 30k·40s/, "per-turn breakdown line under the worker");
  assert.match(s, /⊘ rival/, "cancelled worker gets the ⊘ glyph");
  assert.match(s, /1 agent \+ 2 workers|2 workers/, "phase meta names workers");
  assert.match(s, /Auth flows traced\./, "snippet comes from the LAST turn with a result");
  await rm(dir, { recursive: true, force: true });
}

// 12) sessionful + live: a running steer turn (events) folds into its worker row
//     (spinner), never a separate agent row.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-map-sess-live-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "warm.workflow.jsonl");
  await writeFile(jf, JSON.stringify({ key: "sess:s1#0", label: "oracle", result: { summary: "Loaded." }, phase: "Explore", model: "gpt-5.5", effort: "high", tokens: 52000, ms: 86000, session: true, sessionId: "s1", turn: 0, status: "completed" }));
  await writeFile(join(jdir, "warm.workflow.events.jsonl"), [
    JSON.stringify({ t: 100, type: "start", id: "sess:s1#0", label: "oracle", phase: "Explore", model: "gpt-5.5", effort: "high", kind: "session", sessionId: "s1", turn: 0 }),
    JSON.stringify({ t: 86100, type: "end", id: "sess:s1#0", label: "oracle", phase: "Explore", kind: "session", sessionId: "s1", turn: 0, status: "completed", tokens: 52000, ms: 86000 }),
    JSON.stringify({ t: 90000, type: "start", id: "sess:s1#1", label: "oracle", phase: "Explore", model: "gpt-5.5", effort: "high", kind: "session", sessionId: "s1", turn: 1 }),
  ].join("\n"));
  const run = buildLiveRunModel({ journalPath: jf, runDir: dir });
  assert.equal(run.sessions.length, 1, "still ONE worker with a running steer");
  assert.equal(run.sessions[0].status, "running", "worker is running while its steer runs");
  assert.equal(run.sessions[0].turns.length, 2, "running steer appears as turn 1");
  assert.equal(run.sessions[0].turns[1].status, "running");
  const s = plain(renderMap(run, { color: false, width: 88, now: 95000 }));
  assert.equal((s.match(/oracle/g) || []).length, 1, "one worker row, no phantom second agent row");
  assert.match(s, /⟳ 2 turns: ✓ 52k·1m26s → ● running/, "turns line shows the live steer");
  await rm(dir, { recursive: true, force: true });
}

// 13) collapse pins workers + running units: a wide phase (>maxAgents) with a
//     sessionful worker must STILL show the worker row (it's the headline unit),
//     never fold it into "+N more" — matching the HTML viewer's phaseRow.
{
  const agents = [];
  for (let i = 0; i < 14; i++) {
    agents.push({ key: `a${i}#0`, label: `scan:f${i}`, result: { ok: 1 }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 100000, ms: 3000 });
  }
  // one worker (2 turns) appended last → highest order → would sort into "+N more"
  agents.push({ key: "sess:s1#0", label: "oracle", result: { summary: "Loaded." }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 52000, ms: 80000, session: true, sessionId: "s1", turn: 0, status: "completed", threadId: "th-1" });
  agents.push({ key: "sess:s1#1", label: "oracle", result: { summary: "Traced." }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 30000, ms: 40000, session: true, sessionId: "s1", turn: 1, status: "completed", threadId: "th-1" });
  const dir = await mkdtemp(join(tmpdir(), "wf-map-pin-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "wide.workflow.jsonl");
  await writeFile(jf, agents.map((a) => JSON.stringify(a)).join("\n"));
  const run = buildRunModel({ journalPath: jf, runDir: dir });
  const s = plain(renderMap(run, { color: false, width: 88, maxAgents: 12 }));
  assert.match(s, /✓ oracle/, "the worker row survives the >12-unit collapse (pinned, not folded)");
  assert.match(s, /⟳ 2 turns:/, "the worker's per-turn breakdown line is shown");
  assert.match(s, /\+\d+ more/, "the overflow bucket still appears for the folded one-shot agents");
  // the +N more count must equal what was actually hidden (16 units, worker pinned)
  const m = s.match(/\+(\d+) more/);
  assert.ok(m && Number(m[1]) >= 1, "overflow count is positive and honest");
  await rm(dir, { recursive: true, force: true });
}

// 14) collapse keeps a RUNNING steer visible: a wide phase with a live worker turn
//     must not fold the worker being watched live.
{
  const agents = [];
  for (let i = 0; i < 14; i++) agents.push({ key: `b${i}#0`, label: `scan:g${i}`, result: { ok: 1 }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 90000, ms: 3000 });
  agents.push({ key: "sess:w1#0", label: "watcher", result: { summary: "Loaded." }, phase: "Scan", model: "gpt-5.5", effort: "high", tokens: 40000, ms: 50000, session: true, sessionId: "w1", turn: 0, status: "completed", threadId: "th-w" });
  const dir = await mkdtemp(join(tmpdir(), "wf-map-pinlive-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jf = join(jdir, "wl.workflow.jsonl");
  await writeFile(jf, agents.map((a) => JSON.stringify(a)).join("\n"));
  await writeFile(join(jdir, "wl.workflow.events.jsonl"), [
    JSON.stringify({ t: 100, type: "start", id: "sess:w1#0", label: "watcher", phase: "Scan", model: "gpt-5.5", effort: "high", kind: "session", sessionId: "w1", turn: 0 }),
    JSON.stringify({ t: 50100, type: "end", id: "sess:w1#0", label: "watcher", phase: "Scan", kind: "session", sessionId: "w1", turn: 0, status: "completed", tokens: 40000, ms: 50000 }),
    JSON.stringify({ t: 60000, type: "start", id: "sess:w1#1", label: "watcher", phase: "Scan", model: "gpt-5.5", effort: "high", kind: "session", sessionId: "w1", turn: 1 }),
  ].join("\n"));
  const run = buildLiveRunModel({ journalPath: jf, runDir: dir });
  const s = plain(renderMap(run, { color: false, width: 88, maxAgents: 12, now: 65000 }));
  assert.match(s, /watcher/, "the running worker stays visible under collapse");
  assert.match(s, /⟳ 2 turns: ✓ .+ → ● running/, "its live steer is shown, not folded away");
  await rm(dir, { recursive: true, force: true });
}

console.log("map-run checks passed ✓");
