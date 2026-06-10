// compare-runs: the across-runs analytics view. Fixtures cover run-id
// grouping, newest-first ordering, the latest-vs-previous token trend,
// by-design nulls not denting the completion rate, budget/null flags, empty
// journals skipped, and the CLI's --json shape. No Codex, no tokens.
//
//   node test/compare-runs.test.js

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { collectComparison, renderComparisonText } from "../src/compareRuns.js";

const BIN = new URL("../bin/compare-runs.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-compare-"));

try {
  const dir = join(ROOT, "proj");
  const jdir = join(dir, ".workflow-journal");
  mkdirSync(jdir, { recursive: true });
  const NOW = Date.now();
  const J = (n) => join(jdir, n);
  const jl = (es) => es.map(JSON.stringify).join("\n") + "\n";
  const at = (p, ms) => utimesSync(p, new Date(ms), new Date(ms));

  // two runs of the SAME workflow via --run-id: hunt--a (older, 1.0M) and
  // hunt--b (newer, 800k) → one rollup `hunt`, trend −20%
  writeFileSync(J("hunt--a.workflow.jsonl"), jl([
    { key: "x#0", label: "dig", result: 1, tokens: 600_000, ms: 60_000, phase: "Dig" },
    { key: "y#0", label: "dig", result: 1, tokens: 400_000, ms: 50_000, phase: "Dig" },
  ]));
  at(J("hunt--a.workflow.jsonl"), NOW - 3 * 86_400_000);
  writeFileSync(J("hunt--b.workflow.jsonl"), jl([
    { key: "x#0", label: "dig", result: 1, tokens: 500_000, ms: 45_000, phase: "Dig" },
    { key: "y#0", label: "dig", result: 1, tokens: 300_000, ms: 40_000, phase: "Dig" },
  ]));
  at(J("hunt--b.workflow.jsonl"), NOW - 86_400_000);

  // a run with a by-design null (cancelled race loser) AND a real null + budget flag
  writeFileSync(J("race.workflow.jsonl"), jl([
    { key: "sess:s1#0", label: "winner", session: true, sessionId: "s1", turn: 0, status: "completed", result: "found it", tokens: 700_000, ms: 90_000 },
    { key: "sess:s2#0", label: "loser", session: true, sessionId: "s2", turn: 0, status: "cancelled", tokens: 100_000, ms: 30_000 },
    { key: "z#0", label: "flaky", result: null, tokens: 50_000, ms: 10_000 },
  ]));
  writeFileSync(J("race.workflow.meta.json"), JSON.stringify({ budget: 1_000_000, startedAt: NOW - 7_200_000, pid: 99999999 }));
  at(J("race.workflow.jsonl"), NOW - 7_000_000);

  // an empty journal (a launched-but-never-completed run) is skipped
  writeFileSync(J("stillborn.workflow.jsonl"), "");

  const cmp = collectComparison([dir], { now: NOW });

  // rows: newest first (race ~1.9h < hunt--b 1d < hunt--a 3d), empty skipped
  assert.deepEqual(cmp.rows.map((r) => r.name), ["race", "hunt", "hunt"]);
  assert.equal(cmp.rows.length, 3, "the empty journal is not a comparable run");

  // grouping + trend: hunt--a/b roll up; latest (800k) vs prev (1.0M) = −20%
  const hunt = cmp.rollups.find((g) => g.name === "hunt");
  assert.equal(hunt.runs, 2);
  assert.equal(Math.round(hunt.avgTokens), 900_000);
  assert.ok(Math.abs(hunt.trendPct - -0.2) < 1e-9, `trend should be −20%, got ${hunt.trendPct}`);
  assert.equal(hunt.completion, 1);

  // by-design null doesn't dent ok%; the real null does (2 of 3 ok)
  const race = cmp.rows.find((r) => r.name === "race");
  assert.ok(Math.abs(race.completionRate - 2 / 3) < 1e-9, `cancelled-by-design is not a failure (got ${race.completionRate})`);
  assert.equal(race.sessions, 2);
  assert.ok(race.budget && race.budget.fraction >= 0.8, "850k of 1M budget → pressure flag material");

  // text render: table + rollup line + flags
  const text = renderComparisonText(cmp);
  assert.match(text, /compare-runs: 3 runs · 2 workflows/);
  assert.match(text, /hunt — 2 runs · avg 900k tok\/run · 100% ok · latest vs prev: -20% tokens/);
  assert.match(text, /budget≥80%/);
  assert.match(text, /1 null/);

  // CLI: --json round-trips the same shape
  const r = spawnSync("node", [BIN, dir, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rollups.find((g) => g.name === "hunt").runs, 2);
  assert.equal(spawnSync("node", [BIN, "--bogus"], { encoding: "utf8" }).status, 1, "unknown flag → usage error");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log("compare-runs (longitudinal analytics) checks passed ✓");
