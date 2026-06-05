// Offline unit checks for the provider-neutral pieces — no app-server, no tokens.
// Covers the comment-shadowing regression and parallel/pipeline semantics.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMeta, runWorkflowSource } from "../src/runWorkflow.js";
import { effortForLayerWidth, schemaSkeleton } from "../src/runtime.js";
import { isGitRepo, createWorktree } from "../src/worktree.js";
import { identityHash, Journal } from "../src/journal.js";
import { liveState, buildRunModel, locateRun, listJournals } from "../src/runModel.js";
import { resolveModel, pickFrontier } from "../src/modelMap.js";
import { loadAgentType } from "../src/agentTypes.js";
import { isRetryable, strictifySchema } from "../src/codexAgent.js";
import { recordTokenUsage, resetMeter, tokensSpent, outputSpent, tokensForThread } from "../src/meter.js";
import { versionDriftNote } from "../src/codexVersion.js";

const exec = promisify(execFile);

// 1) extractMeta must ignore a comment that mentions `export const meta`.
{
  const src = [
    "// note: workflow uses `export const meta` at the top",
    'export const meta = { name: "x", description: "d" };',
    "return 1;",
  ].join("\n");
  const meta = extractMeta(src);
  assert.equal(meta?.name, "x", "extractMeta should read the real declaration");
}

// 2) The body transform must strip only the real export (regression for the bug
//    found during the live smoke test) and run with top-level return.
{
  const src = [
    "// mentions export const meta in a comment — must not be stripped",
    'export const meta = { name: "y" };',
    "return 40 + 2;",
  ].join("\n");
  const result = await runWorkflowSource(src, {});
  assert.equal(result, 42, "workflow body should run and return its value");
}

// 3) parallel(): a throwing thunk becomes null; others survive.
{
  const src = [
    'export const meta = { name: "p" };',
    "const r = await parallel([",
    "  () => 1,",
    "  () => { throw new Error('boom'); },",
    "  async () => 3,",
    "]);",
    "return r;",
  ].join("\n");
  const r = await runWorkflowSource(src, {});
  assert.deepEqual(r, [1, null, 3], "parallel should null out throwers");
}

// 4) pipeline(): a stage that throws drops that item to null; others flow through.
{
  const src = [
    'export const meta = { name: "pl" };',
    "const r = await pipeline(",
    "  [1, 2, 3],",
    "  (x) => x * 10,",
    "  (x) => { if (x === 20) throw new Error('drop'); return x + 1; },",
    ");",
    "return r;",
  ].join("\n");
  const r = await runWorkflowSource(src, {});
  assert.deepEqual(r, [11, null, 31], "pipeline should drop the failing item only");
}

// 5) budget global is present and sane without a configured total.
{
  const src = [
    'export const meta = { name: "b" };',
    "return { total: budget.total, remaining: budget.remaining(), spent: budget.spent() };",
  ].join("\n");
  const r = await runWorkflowSource(src, {});
  assert.equal(r.total, null);
  assert.equal(r.remaining, Infinity);
  assert.equal(typeof r.spent, "number");
}

// 6) journal: stable identity hash, occurrence counting, reuse hit/get.
{
  const h1 = identityHash("hello", { model: "m", effort: "low" });
  const h2 = identityHash("hello", { effort: "low", model: "m" }); // key order irrelevant
  const h3 = identityHash("hello", { model: "m", effort: "high" }); // opt change -> new id
  assert.equal(h1, h2, "identity hash must be order-independent");
  assert.notEqual(h1, h3, "changing an output-affecting opt must change the id");

  const j = new Journal(null, { reuse: true }); // null path => in-memory only
  const k0 = j.nextKey("hello", { model: "m" });
  const k1 = j.nextKey("hello", { model: "m" }); // same identity, 2nd occurrence
  assert.notEqual(k0, k1, "repeat identities get distinct occurrence keys");
  assert.equal(j.hit(k0), false, "no hit before record");
  await j.record(k0, "a", { ok: 1 });
  assert.equal(j.hit(k0), true, "hit after record (reuse on)");
  assert.deepEqual(j.get(k0), { ok: 1 });

  const jNoReuse = new Journal(null, { reuse: false });
  await jNoReuse.record("x#0", "a", 1);
  assert.equal(jNoReuse.hit("x#0"), false, "reuse off => never hits even if recorded");
}

// 7) worktree: create at HEAD, clean cleanup removes; dirty cleanup keeps.
{
  const repo = await mkdtemp(join(tmpdir(), "wf-repo-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  await writeFile(join(repo, "f.txt"), "hi\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "init"], { cwd: repo });

  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(tmpdir()), false, "tmpdir root is not a repo");

  // clean worktree => removed
  const wtClean = await createWorktree(repo);
  assert.ok((await stat(wtClean.dir)).isDirectory(), "worktree dir exists");
  const rClean = await wtClean.cleanup();
  assert.equal(rClean.removed, true, "clean worktree is removed");

  // dirty worktree => kept
  const wtDirty = await createWorktree(repo);
  await writeFile(join(wtDirty.dir, "new.txt"), "scratch\n");
  const rDirty = await wtDirty.cleanup();
  assert.equal(rDirty.removed, false, "dirty worktree is kept");
  assert.equal(rDirty.dirty, true);
  await exec("git", ["worktree", "remove", "--force", wtDirty.dir], { cwd: repo }).catch(() => {});
  await rm(repo, { recursive: true, force: true });
}

// 8) model resolution: Claude ids/aliases map; available passthrough; unknown -> default.
{
  const have = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];
  assert.equal(resolveModel("claude-opus-4-8", have), "gpt-5.5", "opus -> strongest");
  assert.equal(resolveModel("opus", have), "gpt-5.5", "bare opus alias maps");
  assert.equal(resolveModel("haiku", have), "gpt-5.4-mini", "haiku -> mini");
  assert.equal(resolveModel("gpt-5.4", have), "gpt-5.4", "available id passes through");
  assert.equal(resolveModel("inherit", have), undefined, "inherit -> config default");
  assert.equal(resolveModel(undefined, have), undefined, "undefined -> config default");
  assert.equal(resolveModel("made-up-model", have), undefined, "unknown -> config default");
  assert.equal(resolveModel("claude-opus", []), "gpt-5.5", "claude maps even with empty model list");
}

// 9) agentType: read system prompt + model from .claude/agents/<name>.md.
{
  const root = await mkdtemp(join(tmpdir(), "wf-agents-"));
  await mkdir(join(root, ".claude", "agents"), { recursive: true });
  await writeFile(
    join(root, ".claude", "agents", "terse.md"),
    "---\nname: terse\nmodel: opus\n---\nYou answer in exactly one lowercase word.\n",
  );
  const def = await loadAgentType("terse", root);
  assert.equal(def.model, "opus");
  assert.match(def.systemPrompt, /exactly one lowercase word/);
  assert.equal(await loadAgentType("does-not-exist", root), null, "unknown agentType -> null");
  await rm(root, { recursive: true, force: true });
}

// 10) retry classification: transient -> retry; permanent -> no retry.
{
  const transientCode = Object.assign(new Error("upstream blip"), {
    codexErrorInfo: "ResponseStreamDisconnected",
  });
  const httpObj = Object.assign(new Error("boom"), {
    codexErrorInfo: { HttpConnectionFailed: { httpStatusCode: 503 } },
  });
  assert.equal(isRetryable(transientCode), true, "stream disconnect is retryable");
  assert.equal(isRetryable(httpObj), true, "http failure (object form) is retryable");
  assert.equal(isRetryable(new Error("Transport is not connected")), true, "transport drop retryable");
  assert.equal(isRetryable(new Error("turn failed: invalid request")), false, "bad request not retryable");
  assert.equal(
    isRetryable(Object.assign(new Error("x"), { codexErrorInfo: "ContextWindowExceeded" })),
    false,
    "context window exceeded not retryable",
  );
  assert.equal(isRetryable(new Error("some unknown failure")), false, "unknown errors not retried");
}

// 11) frontier selection: newest non-mini/spark general model.
{
  const models = [
    { id: "gpt-5.4", isDefault: false },
    { id: "gpt-5.5", isDefault: true },
    { id: "gpt-5.4-mini" },
    { id: "gpt-5.3-codex" },
    { id: "gpt-5.3-codex-spark" },
    { id: "gpt-5.2" },
  ];
  assert.equal(pickFrontier(models), "gpt-5.5", "picks newest non-mini/spark");
  assert.equal(
    pickFrontier(["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"]),
    "gpt-5.4",
    "string ids: version-max, skips mini",
  );
  assert.equal(
    pickFrontier([{ id: "gpt-6", hidden: true }, { id: "gpt-5.5" }]),
    "gpt-5.5",
    "skips hidden",
  );
  assert.equal(pickFrontier([]), undefined, "empty → undefined");
}

// 12) auto-effort: layer width drives thinking effort. Exercises the vm path and
//     AsyncLocalStorage propagation through parallel()/pipeline() thunks. The
//     `runAgent` seam echoes the effort the runtime resolved for each agent.
{
  const echo = async (_prompt, o) => o.effort ?? "(none)";
  const src = [
    'export const meta = { name: "ae" };',
    "const wide = await parallel(Array.from({ length: 8 }, (_, i) => () => agent('w' + i)));",
    "const small = await parallel([() => agent('a'), () => agent('b'), () => agent('c')]);",
    "const seven = await parallel(Array.from({ length: 7 }, (_, i) => () => agent('s' + i)));",
    "const solo = await agent('solo');",
    "const piped = await pipeline([1, 2, 3, 4, 5, 6, 7, 8, 9], (x) => agent('p' + x));",
    "return { wide, small, seven, solo, piped };",
  ].join("\n");
  const r = await runWorkflowSource(src, { autoEffort: true, runAgent: echo });
  assert.deepEqual(r.wide, Array(8).fill("high"), "width 8 -> high (floor)");
  assert.deepEqual(r.small, ["high", "high", "high"], "width 3 -> high");
  assert.deepEqual(r.seven, Array(7).fill("high"), "width 7 -> high");
  assert.equal(r.solo, "xhigh", "lone agent (width 1) -> xhigh");
  assert.deepEqual(r.piped, Array(9).fill("high"), "pipeline width 9 -> high (floor)");
}

// 13) effort precedence: pin > per-call > auto > --effort flag > omitted.
{
  const echo = async (_prompt, o) => o.effort ?? "(none)";
  const r1 = await runWorkflowSource(
    'export const meta = { name: "p1" }; return await agent("x", { effort: "low" });',
    { autoEffort: true, runAgent: echo },
  );
  assert.equal(r1, "low", "explicit per-call effort overrides the auto policy");

  const r2 = await runWorkflowSource(
    'export const meta = { name: "p2" }; return await agent("x", { effort: "low" });',
    { autoEffort: true, pinnedEffort: "xhigh", runAgent: echo },
  );
  assert.equal(r2, "xhigh", "--pin-effort overrides per-call and auto");

  const r3 = await runWorkflowSource(
    'export const meta = { name: "p3" }; return await agent("x");',
    { defaults: { effort: "medium" }, runAgent: echo },
  );
  assert.equal(r3, "medium", "without --auto-effort, --effort is the fallback");

  const r4 = await runWorkflowSource(
    'export const meta = { name: "p4" }; return await agent("x");',
    { runAgent: echo },
  );
  assert.equal(r4, "(none)", "no effort anywhere -> omitted (Codex config default)");
}

// 14) effortForLayerWidth boundaries (the one tunable knob).
{
  assert.equal(effortForLayerWidth(1), "xhigh");
  assert.equal(effortForLayerWidth(2), "high");
  assert.equal(effortForLayerWidth(7), "high");
  assert.equal(effortForLayerWidth(8), "high", "floor is high, not medium");
  assert.equal(effortForLayerWidth(50), "high", "wide fan-out still floors at high");
  assert.equal(effortForLayerWidth(0), "xhigh", "degenerate width clamps to xhigh");
}

// 15) per-agent metrics + phase persisted to the journal. The runAgent seam
//     reports metrics via onMetrics; phase comes from phase()/opts.phase.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-journal-"));
  const jpath = join(dir, "m.jsonl");
  const j = new Journal(jpath, { reuse: false });
  await j.load();
  const echo = async (_p, o) => {
    o.onMetrics?.({ ms: 42, model: "gpt-5.5", tokens: { input: 10, output: 5, reasoning: 3, total: 18 } });
    return "ok";
  };
  await runWorkflowSource(
    [
      'export const meta = { name: "m" };',
      'phase("Scan");',
      'await agent("a");',
      'await agent("b", { phase: "Verify" });',
      "return 1;",
    ].join("\n"),
    { runAgent: echo, journal: j, autoEffort: true },
  );
  const lines = (await readFile(jpath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "two agents journaled");
  assert.equal(lines[0].phase, "Scan", "currentPhase attributed when opts.phase unset");
  assert.equal(lines[1].phase, "Verify", "opts.phase overrides currentPhase");
  assert.equal(lines[0].tokens, 18, "total tokens persisted");
  assert.equal(lines[0].tokensOut, 8, "output+reasoning persisted");
  assert.equal(lines[0].ms, 42, "wall time persisted");
  assert.equal(lines[0].model, "gpt-5.5", "resolved model persisted");
  assert.equal(lines[0].effort, "xhigh", "lone agent under --auto-effort -> xhigh");
  await rm(dir, { recursive: true, force: true });
}

// 16) schemaSkeleton: minimal value satisfying a schema; arrays come back empty.
{
  assert.deepEqual(
    schemaSkeleton({
      type: "object",
      properties: { findings: { type: "array" }, title: { type: "string" }, n: { type: "integer" }, ok: { type: "boolean" } },
    }),
    { findings: [], title: "", n: 0, ok: false },
  );
  assert.equal(schemaSkeleton(undefined), "", "no schema -> empty string (schema-less agent)");
  assert.equal(schemaSkeleton({ enum: ["a", "b"] }), "a", "enum -> first value");
}

// 17) --plan: agent() short-circuits to skeletons (no model), records per-agent.
{
  const recs = [];
  const r = await runWorkflowSource(
    [
      'export const meta = { name: "p" };',
      'phase("Scan");',
      'const a = await agent("x", { schema: { type: "object", properties: { items: { type: "array" } } } });',
      'const w = await parallel([() => agent("y"), () => agent("z")]);',
      "return { n: a.items.length, w: w.length };",
    ].join("\n"),
    { plan: true, autoEffort: true, onAgentPlan: (x) => recs.push(x) },
  );
  assert.equal(recs.length, 3, "all three agents recorded in plan");
  assert.equal(recs[0].phase, "Scan");
  assert.equal(recs[0].effort, "xhigh", "lone agent -> xhigh");
  assert.equal(recs[1].effort, "high", "width-2 fan-out -> high");
  assert.equal(r.n, 0, "schema array skeleton is empty (dynamic widths uncounted)");
  assert.equal(r.w, 2, "parallel still returns an array of skeletons");
}

// 18) token meter: total vs output, and per-thread attribution.
{
  resetMeter();
  recordTokenUsage({ threadId: "t1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 } } });
  recordTokenUsage({ threadId: "t2", tokenUsage: { total: { inputTokens: 50, outputTokens: 10, reasoningOutputTokens: 0 } } });
  assert.equal(tokensSpent(), 185, "total = input+output+reasoning across threads");
  assert.equal(outputSpent(), 35, "output = output+reasoning across threads");
  const t1 = tokensForThread("t1");
  assert.equal(t1.total, 125);
  assert.equal(t1.output, 20);
  assert.equal(tokensForThread("nope"), null, "unknown thread -> null");
  resetMeter();
}

// 19) workflow("name") resolves a saved workflow from .claude/workflows/.
{
  const root = await mkdtemp(join(tmpdir(), "wf-registry-"));
  await mkdir(join(root, ".claude", "workflows"), { recursive: true });
  await writeFile(join(root, ".claude", "workflows", "child.js"), 'export const meta = { name: "child" };\nreturn 7;\n');
  const prev = process.cwd();
  process.chdir(root);
  try {
    const r = await runWorkflowSource('export const meta = { name: "parent" };\nreturn await workflow("child");', {});
    assert.equal(r, 7, "named workflow resolved from .claude/workflows and ran");
  } finally {
    process.chdir(prev);
    await rm(root, { recursive: true, force: true });
  }
}

// 20) codex version drift note: null when matching/unknown, warns on mismatch.
{
  assert.equal(versionDriftNote("0.135.0", "0.135.0"), null, "match -> no note");
  assert.equal(versionDriftNote(null, "0.135.0"), null, "unknown version -> no note");
  assert.match(versionDriftNote("0.140.0", "0.135.0"), /0\.140\.0[\s\S]*0\.135\.0/, "drift -> warns with both versions");
}

// 21) lifecycle events: a start + end per agent, carrying phase/effort/metrics.
{
  const events = [];
  const echo = async (_p, o) => {
    o.onMetrics?.({ ms: 10, model: "gpt-5.5", tokens: { input: 1, output: 1, reasoning: 0, total: 2 } });
    return "ok";
  };
  await runWorkflowSource(
    'export const meta={name:"e"}; phase("Scan"); await agent("a"); await parallel([()=>agent("b"),()=>agent("c")]); return 1;',
    { runAgent: echo, autoEffort: true, onEvent: (e) => events.push(e) },
  );
  const starts = events.filter((e) => e.type === "start");
  const ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, 3, "one start per agent");
  assert.equal(ends.length, 3, "one end per agent");
  assert.equal(starts[0].label, "a");
  assert.equal(starts[0].phase, "Scan", "start carries the phase");
  assert.equal(starts[0].effort, "xhigh", "start carries the resolved effort (lone agent)");
  assert.equal(ends[0].label, "a");
  assert.equal(ends[0].ms, 10, "end carries per-agent metrics");
  assert.equal(ends[0].tokens, 2);
}

// strictifySchema — OpenAI strict mode needs every property in `required`
// (recursively). This is the exact shape that 400'd a real run: an array-of-objects
// whose items omit a property from `required`.
{
  const authored = {
    type: "object",
    additionalProperties: false,
    properties: {
      painPoints: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { pain: { type: "string" }, buyer: { type: "string" }, whoFeelsItNow: { type: "string" } },
          required: ["pain", "buyer"], // <-- whoFeelsItNow omitted (the bug)
        },
      },
      summary: { type: "string" },
    },
    required: ["painPoints"], // <-- summary omitted
  };
  const strict = strictifySchema(authored);
  assert.deepEqual(strict.required.sort(), ["painPoints", "summary"], "top-level: every property required");
  assert.deepEqual(
    strict.properties.painPoints.items.required.sort(),
    ["buyer", "pain", "whoFeelsItNow"],
    "nested array-item object: every property required (the field that 400'd is now included)",
  );
  assert.equal(strict.properties.painPoints.items.additionalProperties, false, "objects get additionalProperties:false");
  assert.equal(strict.properties.painPoints.items.properties.whoFeelsItNow.type, "string", "field types are unchanged");
  assert.deepEqual(authored.properties.painPoints.items.required, ["pain", "buyer"], "the input schema is not mutated");
  // non-object schemas pass through untouched
  assert.deepEqual(strictifySchema({ type: "string" }), { type: "string" });
}

// 22) lifecycle events carry the stable agent id (= journal key) on start/end, and
//     a cached replay carries it too — so viewers/summary key by id, not label.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-eventid-"));
  const jpath = join(dir, "e.jsonl");
  const j = new Journal(jpath, { reuse: false });
  await j.load();
  const echo = async () => "ok";
  const ev1 = [];
  await runWorkflowSource(
    'export const meta={name:"e"}; await agent("a",{label:"x"}); return 1;',
    { runAgent: echo, journal: j, onEvent: (e) => ev1.push(e) },
  );
  const jline = JSON.parse((await readFile(jpath, "utf8")).trim().split("\n")[0]);
  const start = ev1.find((e) => e.type === "start"), end = ev1.find((e) => e.type === "end");
  assert.ok(jline.key, "journal entry has a key");
  assert.equal(start.id, jline.key, "start event carries the journal key as id");
  assert.equal(end.id, jline.key, "end event carries the journal key as id");
  assert.equal(start.label, "x", "display label preserved on the event");
  // a second run reuses the journal → a cached event, also carrying the id
  const j2 = new Journal(jpath, { reuse: true });
  await j2.load();
  const ev2 = [];
  await runWorkflowSource(
    'export const meta={name:"e"}; await agent("a",{label:"x"}); return 1;',
    { runAgent: echo, journal: j2, onEvent: (e) => ev2.push(e) },
  );
  const cached = ev2.find((e) => e.type === "cached");
  assert.ok(cached, "second run hits the cache");
  assert.equal(cached.id, jline.key, "cached event carries the journal key as id");
  await rm(dir, { recursive: true, force: true });
}

// 23) liveState keys by id: two agents that share a label are tracked separately;
//     events without an id fall back to label (legacy).
{
  const ls = liveState([
    { t: 1, type: "start", id: "k1#0", label: "dup", phase: "P" },
    { t: 2, type: "start", id: "k2#0", label: "dup", phase: "P" },
    { t: 3, type: "end", id: "k1#0", label: "dup" },
  ]);
  assert.equal(ls.running.length, 1, "same label, distinct ids → only the unended one is running");
  assert.equal(ls.running[0].id, "k2#0", "running agent keyed by id");
  assert.equal(ls.running[0].label, "dup", "label preserved for display");
  const legacy = liveState([
    { t: 1, type: "start", label: "a" }, { t: 2, type: "start", label: "b" }, { t: 3, type: "end", label: "a" },
  ]);
  assert.equal(legacy.running.length, 1, "id-less events fall back to label");
  assert.equal(legacy.running[0].label, "b");
}

// 24) buildRunModel exposes a stable id and does NOT collapse same-label agents;
//     a keyless entry falls back to label as its id.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-rm-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jpath = join(jdir, "r.workflow.jsonl");
  await writeFile(jpath, [
    JSON.stringify({ key: "a#0", label: "dup", result: 1 }),
    JSON.stringify({ key: "b#0", label: "dup", result: 2 }),
  ].join("\n"));
  const run = buildRunModel({ journalPath: jpath });
  assert.equal(run.agents.length, 2, "two entries with the same label are not collapsed");
  assert.deepEqual(run.agents.map((a) => a.id).sort(), ["a#0", "b#0"], "each agent has its journal key as id");
  assert.ok(run.agents.every((a) => a.label === "dup"), "label preserved");
  await writeFile(jpath, JSON.stringify({ label: "solo", result: 1 }));
  assert.equal(buildRunModel({ journalPath: jpath }).agents[0].id, "solo", "no key → id falls back to label");
  await rm(dir, { recursive: true, force: true });
}

// 25) locateRun + listJournals: with several journals in one run dir, default to the
//     most recently MODIFIED (not alphabetical); --journal overrides.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-loc-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const older = join(jdir, "aaa.workflow.jsonl"); // sorts FIRST alphabetically
  const newer = join(jdir, "zzz.workflow.jsonl"); // sorts LAST alphabetically
  await writeFile(older, JSON.stringify({ key: "o#0", label: "o", result: 1 }));
  await writeFile(newer, JSON.stringify({ key: "n#0", label: "n", result: 1 }));
  await utimes(older, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  await utimes(newer, new Date(), new Date());
  const list = listJournals(dir);
  assert.equal(list[0].name, "zzz.workflow.jsonl", "listJournals: newest first by mtime");
  assert.equal(list.length, 2);
  const loc = locateRun({ target: dir });
  assert.ok(loc.journalPath.endsWith("zzz.workflow.jsonl"), "locateRun defaults to the most recently modified journal");
  const loc2 = locateRun({ target: dir, journal: older });
  assert.ok(loc2.journalPath.endsWith("aaa.workflow.jsonl"), "--journal overrides the mtime default");
  await rm(dir, { recursive: true, force: true });
}

console.log("offline checks passed ✓");
