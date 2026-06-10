// Offline unit checks for the provider-neutral pieces — no app-server, no tokens.
// Covers the comment-shadowing regression and parallel/pipeline semantics.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMeta, runWorkflowSource } from "../src/runWorkflow.js";
import { effortForLayerWidth, schemaSkeleton, createRuntime, __activeSlots } from "../src/runtime.js";
import { isGitRepo, createWorktree } from "../src/worktree.js";
import { identityHash, Journal } from "../src/journal.js";
import { liveState, buildRunModel, locateRun, listJournals } from "../src/runModel.js";
import { resolveModel, pickFrontier } from "../src/modelMap.js";
import { loadAgentType } from "../src/agentTypes.js";
import { isRetryable, strictifySchema } from "../src/codexAgent.js";
import { recordTokenUsage, resetMeter, tokensSpent, outputSpent, tokensForThread, markResumedThread } from "../src/meter.js";
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

// ── Sessionful workers (agent.start / agent.waitAny / session.*) ─────────────
// A fake session driver stands in for codexSession.startCodexSession via the
// `startSession` seam, so these run with NO app-server and NO tokens. Each turn
// "completes" after a small delay parsed from the prompt (delay=NN ms), or is
// interrupted on demand — enough to exercise start/wait/waitAny/steer/cancel/close.
function makeFakeSessionFactory() {
  const drivers = [];
  let seq = 0;
  async function startSession(opts) {
    const threadId = `fake-thread-${++seq}`;
    const driver = {
      threadId, opts, turns: [], cleaned: 0, _active: false, _done: null,
      async beginTurn(prompt, turnOpts) {
        this.turns.push(String(prompt));
        const turnId = `${threadId}:t${this.turns.length}`;
        const ms = Number((String(prompt).match(/delay=(\d+)/) || [])[1] ?? 2);
        this._active = true;
        let settle;
        const completion = new Promise((res) => { settle = res; });
        let timer;
        const done = (status) => {
          if (!this._active) return;
          this._active = false;
          this._done = null;
          if (timer) clearTimeout(timer);
          const text = `echo:${prompt}`;
          settle({
            status,
            result: status === "completed" ? (turnOpts.schema ? { echoed: String(prompt) } : text) : null,
            text,
            error: status === "failed" ? "boom" : null,
            model: "fake-model", tokens: 7, ms, turnId,
          });
        };
        this._done = done;
        timer = setTimeout(() => done("completed"), ms);
        return { turnId, completion };
      },
      async interruptCurrent() { this._done?.("interrupted"); },
      async cleanup() { this.cleaned++; },
    };
    drivers.push(driver);
    return driver;
  }
  return { startSession, drivers };
}

// 26) agent.start() returns BEFORE the turn completes; wait() resolves completed.
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess1" };',
    'const s = await agent.start("worker delay=40", { label: "w" });',
    'const early = s.poll();',
    'const fin = await s.wait();',
    'return { early: early.status, threadId: s.threadId, fin: fin.status, result: fin.result, turnId: fin.turnId };',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(r.early, "running", "agent.start returns while the turn is still running");
  assert.ok(r.threadId && r.threadId.startsWith("fake-thread-"), "session exposes the thread id");
  assert.equal(r.fin, "completed", "wait() resolves to a completed snapshot");
  assert.equal(r.result, "echo:worker delay=40", "completed snapshot carries the result");
  assert.ok(r.turnId, "snapshot carries the turn id");
}

// 27) agent.waitAny returns the first finisher and lists the still-running ones.
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess2" };',
    'const a = await agent.start("A delay=80", { label: "a" });',
    'const b = await agent.start("B delay=3", { label: "b" });',
    'const first = await agent.waitAny([a, b]);',
    'const finalA = await a.wait();',
    // join the pending labels into a string: the array is built in the vm realm, so
    // deepEqual against a host array would fail on prototype identity (test artifact).
    'return { winner: first.snapshot.label, index: first.index, pending: first.pendingSessions.map((s) => s.label).join(","), pendingCount: first.pendingSessions.length, timedOut: first.timedOut, finalA: finalA.status };',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(r.winner, "b", "waitAny returns the first session to finish");
  assert.equal(r.index, 1, "winning index reported");
  assert.equal(r.pendingCount, 1, "exactly one session is still pending");
  assert.equal(r.pending, "a", "the still-running session is reported as pending");
  assert.equal(r.timedOut, false);
  assert.equal(r.finalA, "completed", "the slower session can still be awaited afterwards");
}

// 28) agent.waitAny times out cleanly without cancelling the running turn.
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess2b" };',
    'const a = await agent.start("A delay=10000", { label: "a" });',
    'const first = await agent.waitAny([a], { timeoutMs: 20 });',
    'await a.cancel();',
    'return { timedOut: first.timedOut, session: first.session, pending: first.pendingSessions.map((s) => s.label).join(","), pendingCount: first.pendingSessions.length };',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(r.timedOut, true, "waitAny reports a timeout when nothing finishes in time");
  assert.equal(r.session, null, "no winner on timeout");
  assert.equal(r.pendingCount, 1, "the still-running session remains pending after the timeout");
  assert.equal(r.pending, "a");
}

// 29) session.steer() starts a 2nd turn on the SAME thread (not a fresh agent).
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess3" };',
    'const s = await agent.start("first", { label: "w" });',
    'await s.wait();',
    'const before = s.threadId;',
    'const snap = await s.steer("second");',
    'return { same: s.threadId === before, status: snap.status, result: snap.result };',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(r.same, true, "steer continues on the SAME thread id");
  assert.equal(r.status, "completed");
  assert.equal(r.result, "echo:second", "steer's result reflects the follow-up prompt");
  assert.equal(fake.drivers.length, 1, "exactly one thread/session was created (no fresh agent)");
  assert.deepEqual(fake.drivers[0].turns, ["first", "second"], "both turns ran on the one thread");
}

// 30) steer() while a turn is running throws a clear, actionable error.
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess4" };',
    'const s = await agent.start("slow delay=80", { label: "w" });',
    'let err = null;',
    'try { await s.steer("nope"); } catch (e) { err = e.message; }',
    'await s.wait();',
    'return { err };',
  ].join("\n"), { startSession: fake.startSession });
  assert.match(r.err || "", /while a turn is already running/, "steer during a running turn throws a clear error");
}

// 31) session.cancel() interrupts the active turn and yields a cancelled snapshot.
{
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sess5" };',
    'const s = await agent.start("slow delay=10000", { label: "w" });',
    'const snap = await s.cancel();',
    'return { snap: snap.status, session: s.status };',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(r.snap, "cancelled", "cancel() returns a cancelled snapshot");
  assert.equal(r.session, "cancelled", "session status is cancelled after cancel()");
}

// 32) --plan handles start/wait/steer/waitAny WITHOUT calling the session driver.
{
  const recs = [];
  let called = false;
  const r = await runWorkflowSource([
    'export const meta = { name: "sessplan" };',
    'phase("Explore");',
    'const a = await agent.start("x", { label: "a", schema: { type: "object", properties: { items: { type: "array" } } } });',
    'const snap = await a.wait();',
    'const b = await agent.start("y", { label: "b" });',
    'const first = await agent.waitAny([a, b]);',
    'await a.steer("more");',
    'return { items: snap.result.items.length, winner: first.snapshot.label, status: snap.status };',
  ].join("\n"), {
    plan: true, autoEffort: true,
    onAgentPlan: (x) => recs.push(x),
    startSession: () => { called = true; throw new Error("startSession must not run in --plan"); },
  });
  assert.equal(called, false, "--plan never calls the session driver (no Codex, no tokens)");
  assert.equal(recs.filter((x) => x.kind === "session-start").length, 2, "two planned session starts are counted");
  assert.equal(recs.filter((x) => x.kind === "steer").length, 1, "one planned steer is counted");
  assert.equal(recs[0].phase, "Explore", "a planned session carries the phase");
  assert.equal(recs[0].effort, "xhigh", "a lone planned session start under --auto-effort -> xhigh");
  assert.equal(r.items, 0, "schema-skeleton arrays are empty in --plan");
  assert.equal(r.winner, "a", "waitAny returns the first planned session");
  assert.equal(r.status, "completed", "planned wait returns a completed skeleton snapshot");
}

// 33) session turns emit start/end lifecycle events carrying label/phase/metrics.
{
  const events = [];
  const fake = makeFakeSessionFactory();
  await runWorkflowSource([
    'export const meta = { name: "sessev" };',
    'phase("Explore");',
    'const s = await agent.start("go", { label: "worker" });',
    'await s.wait();',
    'await s.steer("again");',
    'return 1;',
  ].join("\n"), { startSession: fake.startSession, onEvent: (e) => events.push(e) });
  const starts = events.filter((e) => e.type === "start");
  const ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, 2, "one start per session turn (initial + steer)");
  assert.equal(ends.length, 2, "one end per session turn (keeps liveState balanced)");
  assert.equal(starts[0].kind, "session", "session turns are tagged kind:session");
  assert.equal(starts[0].label, "worker");
  assert.equal(starts[0].phase, "Explore", "start carries the phase");
  assert.equal(ends[0].status, "completed", "end carries the turn status");
  assert.equal(ends[0].tokens, 7, "end carries per-turn tokens");
  assert.equal(ends[0].ms, 2, "end carries per-turn wall time");
  assert.equal(ends[0].sessionId, starts[0].sessionId, "start/end share the sessionId");
  assert.equal(starts[1].turn, 1, "the steer is turn index 1");
}

// 34) session turns are journaled for observability but live-only: their key is in
//     the `sess:` namespace that agent() never generates, so resume can't serve them.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-sessj-"));
  const jpath = join(dir, "s.jsonl");
  const j = new Journal(jpath, { reuse: true });
  await j.load();
  const fake = makeFakeSessionFactory();
  await runWorkflowSource([
    'export const meta = { name: "sessj" };',
    'phase("Explore");',
    'const s = await agent.start("go", { label: "worker" });',
    'await s.wait();',
    'return 1;',
  ].join("\n"), { startSession: fake.startSession, journal: j });
  const lines = (await readFile(jpath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, "the session turn was journaled for the viewer/summary");
  assert.ok(lines[0].key.startsWith("sess:"), "session journal key is in the sess: namespace");
  assert.equal(lines[0].session, true, "entry is flagged session:true");
  assert.equal(lines[0].label, "worker");
  assert.equal(lines[0].phase, "Explore");
  assert.equal(lines[0].tokens, 7);
  assert.equal(lines[0].sessionId, "s1", "entry carries the worker id (the viewer groups turns by it)");
  assert.equal(lines[0].turn, 0, "entry carries the turn index");
  assert.ok(lines[0].threadId, "entry carries the Codex thread id (resume re-attach + provenance)");
  const agentKey = j.nextKey("go", { model: null });
  assert.ok(!agentKey.startsWith("sess:"), "agent() keys are NEVER in the sess: namespace (no fake resurrection)");
  await rm(dir, { recursive: true, force: true });
}

// 34b) warm-context session resume: with --resume + a re-attachable thread, the
//      journaled completed-turn prefix replays FREE and follow-up turns run live
//      on the SAME (warm) thread; a failed re-attach re-runs everything live.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-sessr-"));
  const jpath = join(dir, "s.jsonl");
  // run 1: live — journal two completed turns (threadId fake-thread-1)
  const j1 = new Journal(jpath, { reuse: false });
  await j1.load();
  const fake1 = makeFakeSessionFactory();
  const r1 = await runWorkflowSource([
    'export const meta = { name: "sessr" };',
    'const s = await agent.start("load corpus", { label: "w" });',
    'await s.wait();',
    'const t1 = await s.steer("question one");',
    'return t1.result;',
  ].join("\n"), { startSession: fake1.startSession, journal: j1 });
  assert.equal(r1, "echo:question one");

  // run 2: resume — re-attach succeeds; both journaled turns replay with NO model
  // work; a NEW steer runs live on the resumed thread.
  const j2 = new Journal(jpath, { reuse: true });
  await j2.load();
  const beginCalls = [];
  let resumeReq = null;
  const startSession2 = async (opts) => {
    resumeReq = opts.resumeThreadId ?? null;
    const threadId = opts.resumeThreadId ?? "fresh-thread";
    return {
      threadId, resumed: !!opts.resumeThreadId,
      async beginTurn(prompt) {
        beginCalls.push(String(prompt));
        return { turnId: threadId + ":t" + beginCalls.length, completion: Promise.resolve({ status: "completed", result: "live:" + prompt, text: "live:" + prompt, error: null, model: "fake", tokens: 5, ms: 1, turnId: "x" }) };
      },
      async interruptCurrent() {},
      async cleanup() {},
    };
  };
  const events2 = [];
  const r2 = await runWorkflowSource([
    'export const meta = { name: "sessr" };',
    'const s = await agent.start("load corpus", { label: "w" });',
    'const a = await s.wait();',
    'const b = await s.steer("question one");',
    'const c = await s.steer("question two");',
    'return { a: a.result, b: b.result, c: c.result, thread: s.threadId };',
  ].join("\n"), { startSession: startSession2, journal: j2, onEvent: (e) => events2.push(e) });
  assert.equal(resumeReq, "fake-thread-1", "the runtime passes the journaled thread id to re-attach");
  assert.equal(r2.a, "echo:load corpus", "turn 0 replays the journaled result");
  assert.equal(r2.b, "echo:question one", "turn 1 (steer) replays too");
  assert.equal(r2.c, "live:question two", "the NEW steer runs live on the warm thread");
  assert.equal(beginCalls.length, 1, "exactly one live turn — the replayed prefix never re-runs");
  assert.equal(r2.thread, "fake-thread-1", "the worker is on its original (re-attached) thread");
  assert.equal(events2.filter((e) => e.type === "cached" && e.kind === "session").length, 2,
    "replayed session turns emit 'cached' events (the viewer/summary count them as cache hits)");

  // run 3: resume but re-attach FAILS → the turn re-runs live (no fake resurrection).
  const j3 = new Journal(jpath, { reuse: true });
  await j3.load();
  const liveCalls = [];
  const startSession3 = async () => ({
    threadId: "fresh-2", resumed: false,
    async beginTurn(prompt) { liveCalls.push(String(prompt)); return { turnId: "t" + liveCalls.length, completion: Promise.resolve({ status: "completed", result: "live:" + prompt, text: "", error: null, model: "fake", tokens: 5, ms: 1, turnId: "y" }) }; },
    async interruptCurrent() {}, async cleanup() {},
  });
  const r3 = await runWorkflowSource([
    'export const meta = { name: "sessr" };',
    'const s = await agent.start("load corpus", { label: "w" });',
    'const a = await s.wait();',
    'return a.result;',
  ].join("\n"), { startSession: startSession3, journal: j3 });
  assert.equal(r3, "live:load corpus", "failed re-attach → the turn re-runs live");
  assert.equal(liveCalls.length, 1);
  await rm(dir, { recursive: true, force: true });
}

// 34b-prompt) warm resume is PROMPT-CHECKED, not blindly positional: if a turn's
// prompt CHANGES on resume (e.g. a steer built from an edited human() answer), the
// cached result must NOT be served — that turn AND every later turn re-run live so
// the warm thread context stays consistent. Regression for the positional-replay bug.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-sesspc-"));
  const jpath = join(dir, "s.jsonl");
  // run 1: journal turn 0 ("load") and turn 1 ("ask A") as completed.
  const j1 = new Journal(jpath, { reuse: false });
  await j1.load();
  const fake1 = makeFakeSessionFactory();
  await runWorkflowSource([
    'export const meta = { name: "pc" };',
    'const s = await agent.start("load", { label: "w" });',
    'await s.wait();',
    'await s.steer("ask A");',
    'return 1;',
  ].join("\n"), { startSession: fake1.startSession, journal: j1 });

  // run 2: resume, re-attach OK, but the SECOND turn's prompt is now "ask B" (changed).
  // turn 0 ("load") still matches → replays; turn 1 differs → re-runs live; and there's
  // no fake "ask A" answer served.
  const j2 = new Journal(jpath, { reuse: true });
  await j2.load();
  const liveCalls = [];
  const startSession2 = async (opts) => ({
    threadId: opts.resumeThreadId ?? "fresh", resumed: !!opts.resumeThreadId,
    async beginTurn(prompt) {
      liveCalls.push(String(prompt));
      return { turnId: "t" + liveCalls.length, completion: Promise.resolve({ status: "completed", result: "live:" + prompt, text: "live:" + prompt, error: null, model: "fake", tokens: 5, ms: 1, turnId: "z" }) };
    },
    async interruptCurrent() {}, async cleanup() {},
  });
  const r2 = await runWorkflowSource([
    'export const meta = { name: "pc" };',
    'const s = await agent.start("load", { label: "w" });',
    'const a = await s.wait();',
    'const b = await s.steer("ask B");', // CHANGED from "ask A"
    'return { a: a.result, b: b.result };',
  ].join("\n"), { startSession: startSession2, journal: j2 });
  assert.equal(r2.a, "echo:load", "turn 0 prompt unchanged → still replays from the journal");
  assert.equal(r2.b, "live:ask B", "turn 1 prompt CHANGED → runs live (the stale 'ask A' result is NOT served)");
  assert.equal(liveCalls.length, 1, "only the changed turn re-ran live");
  assert.deepEqual(liveCalls, ["ask B"], "the live turn used the NEW prompt");
  await rm(dir, { recursive: true, force: true });
}

// 34c) resumed-thread meter baseline: a re-attached thread may report cumulative
//      usage that includes PRIOR-run history — the meter must bill only this run.
{
  resetMeter();
  markResumedThread("th-resumed");
  const usage = (total, last) => ({
    threadId: "th-resumed",
    tokenUsage: {
      total: { totalTokens: total, inputTokens: total - 10, outputTokens: 8, reasoningOutputTokens: 2 },
      last: { totalTokens: last, inputTokens: last - 10, outputTokens: 8, reasoningOutputTokens: 2 },
    },
  });
  recordTokenUsage(usage(110_000, 10_000)); // 100k of history + 10k this turn
  assert.equal(tokensForThread("th-resumed").total, 10_000, "history is baselined away");
  recordTokenUsage(usage(130_000, 30_000));
  assert.equal(tokensForThread("th-resumed").total, 30_000, "later readings keep subtracting the baseline");
  assert.equal(tokensSpent(), 30_000, "budget meter bills only this run's spend");
  resetMeter();
}

// 35) runtime finalization closes sessions the workflow left open (cancel + cleanup).
{
  const fake = makeFakeSessionFactory();
  const result = await runWorkflowSource([
    'export const meta = { name: "sessfin" };',
    'const s = await agent.start("go delay=10000", { label: "leak" });',
    'return s;',
  ].join("\n"), { startSession: fake.startSession });
  assert.equal(result.status, "closed", "runtime finalization closed the open session");
  assert.equal(fake.drivers[0].cleaned, 1, "finalization cleaned up the driver");
  assert.equal(fake.drivers[0]._active, false, "finalization interrupted the still-running turn");
}

// 36) worktree isolation: a session's worktree persists across the steer and is
//     cleaned up exactly once, on close (not after the first turn).
{
  const repo = await mkdtemp(join(tmpdir(), "wf-sesswt-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  await writeFile(join(repo, "f.txt"), "hi\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "init"], { cwd: repo });

  const captured = {};
  async function startSessionWT() {
    const wt = await createWorktree(repo);
    const existsAtTurn = [];
    const driver = {
      threadId: "wt-thread", dir: wt.dir, existsAtTurn, cleaned: 0, _active: false,
      async beginTurn(prompt) {
        existsAtTurn.push(existsSync(wt.dir)); // worktree must exist during every turn
        this._active = true;
        const turnId = "t" + existsAtTurn.length;
        const completion = new Promise((res) =>
          setTimeout(() => { this._active = false; res({ status: "completed", result: "ok", text: "ok", error: null, model: "fake", tokens: 1, ms: 1, turnId }); }, 2));
        return { turnId, completion };
      },
      async interruptCurrent() {},
      async cleanup() { this.cleaned++; await wt.cleanup(); },
    };
    captured.driver = driver;
    return driver;
  }
  await runWorkflowSource([
    'export const meta = { name: "sesswt" };',
    'const s = await agent.start("a", { isolation: "worktree" });',
    'await s.wait();',
    'await s.steer("b");',
    'await s.close();',
    'return 1;',
  ].join("\n"), { startSession: startSessionWT });
  assert.deepEqual(captured.driver.existsAtTurn, [true, true], "worktree persists across the initial turn AND the steer");
  assert.equal(captured.driver.cleaned, 1, "worktree cleaned exactly once");
  assert.equal(existsSync(captured.driver.dir), false, "worktree removed on close");
  await rm(repo, { recursive: true, force: true });
}

// 37) a detached running session turn occupies a concurrency slot until it settles.
{
  const fake = makeFakeSessionFactory();
  const rt = createRuntime({ startSession: fake.startSession });
  const before = __activeSlots();
  const s = await rt.agent.start("hold delay=200", { label: "h" });
  const during = __activeSlots();
  const snap = await s.wait();
  const after = __activeSlots();
  assert.equal(during, before + 1, "a detached running session holds a concurrency slot");
  assert.equal(snap.status, "completed");
  assert.equal(after, before, "the slot is released when the turn finishes");
  await rt.finalize();
}

// 38) agent.start enforces the budget exactly like agent() (BUDGET_EXCEEDED).
{
  resetMeter();
  recordTokenUsage({ threadId: "pre", tokenUsage: { total: { inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0 } } });
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sessbud" };',
    'try { await agent.start("x", { label: "a" }); return "started"; }',
    'catch (e) { return e.code || e.message; }',
  ].join("\n"), { budgetTotal: 500, startSession: fake.startSession });
  assert.equal(r, "BUDGET_EXCEEDED", "agent.start gates on the budget before starting a turn");
  assert.equal(fake.drivers.length, 0, "no thread/session is created once the budget is exhausted");
  resetMeter();
}

// 39) backward compat: classic agent() and sessionful agent.start coexist.
{
  const echo = async () => "one-shot";
  const fake = makeFakeSessionFactory();
  const r = await runWorkflowSource([
    'export const meta = { name: "sessmix" };',
    'const a = await agent("classic");',
    'const s = await agent.start("session", { label: "w" });',
    'const snap = await s.wait();',
    'return { a, s: snap.result };',
  ].join("\n"), { runAgent: echo, startSession: fake.startSession });
  assert.equal(r.a, "one-shot", "classic agent() is unchanged alongside sessions");
  assert.equal(r.s, "echo:session", "agent.start works in the same workflow");
}

// ── human(question, opts?) — the interactive involvement mode ────────────────

// 37) resolution order: --plan and args.checkpointAnswers never block; with no
//     channel the default comes back immediately (hands_off degradation).
{
  const src = [
    'export const meta = { name: "hq" };',
    'const a = await human("Include admin routes?", { id: "scope", choices: ["include", "exclude"], default: "exclude" });',
    'return a;',
  ].join("\n");
  assert.equal(await runWorkflowSource(src, { plan: true }), "exclude", "--plan returns the default");
  assert.equal(await runWorkflowSource(src, { args: { checkpointAnswers: { scope: "include" } } }), "include",
    "args.checkpointAnswers wins (the documented resume convention)");
  assert.equal(await runWorkflowSource(src, {}), "exclude", "no channel → the default, no blocking");
  // no default and no choices → null, still no blocking
  const r = await runWorkflowSource('export const meta={name:"hq2"};return await human("free-form?");', {});
  assert.equal(r, null);

  // anon question numbering counts ONLY id-less calls, so an explicit-id call before
  // an anonymous one doesn't shift the anon key (which would break resume replay).
  const notified = [];
  await runWorkflowSource([
    'export const meta = { name: "hq3" };',
    'await human("named", { id: "guard", default: "g" });', // explicit id — must NOT consume q1
    'await human("anon one", { default: "a1" });',
    'await human("anon two", { default: "a2" });',
    'return 1;',
  ].join("\n"), { humanChannel: { notify: (q) => notified.push(q.qid), wait: async () => undefined } });
  assert.deepEqual(notified, ["guard", "q1", "q2"], "anon keys are q1/q2 regardless of the preceding id'd call");
}

// 38) the live channel: notify carries the question, the answer is returned and
//     JOURNALED (under human:<id>#<occ>), and a --resume run replays it free.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-human-"));
  const jpath = join(dir, "h.jsonl");
  const j1 = new Journal(jpath, { reuse: false });
  await j1.load();
  const notified = [];
  const channel = {
    notify: (q) => notified.push(q),
    wait: async (id) => ({ answer: "separate_section" }),
  };
  const src = [
    'export const meta = { name: "hl" };',
    'return await human("Scope?", { id: "scope", choices: ["include", "exclude", "separate_section"] });',
  ].join("\n");
  const r1 = await runWorkflowSource(src, { journal: j1, humanChannel: channel });
  assert.equal(r1, "separate_section", "the live answer is returned");
  assert.equal(notified.length, 1, "the channel was notified once");
  assert.equal(notified[0].id, "human:scope#0", "question id is the journal key (human: namespace)");
  // the choices array crosses the vm realm — compare by value, not prototype
  assert.equal(notified[0].choices.join(","), "include,exclude,separate_section");
  const lines = (await readFile(jpath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].key, "human:scope#0");
  assert.equal(lines[0].human, true);
  assert.equal(lines[0].result, "separate_section");
  assert.equal(lines[0].source, "live");

  // resume: the answer replays from the journal — the channel is NOT consulted.
  const j2 = new Journal(jpath, { reuse: true });
  await j2.load();
  let asked = 0;
  const r2 = await runWorkflowSource(src, {
    journal: j2,
    humanChannel: { notify: () => asked++, wait: async () => ({ answer: "WRONG" }) },
  });
  assert.equal(r2, "separate_section", "--resume replays the journaled answer");
  assert.equal(asked, 0, "the human is never re-asked on resume");
  await rm(dir, { recursive: true, force: true });
}

// 39) channel timeout → the default, journaled with source 'default'; human()
//     checkpoints never appear as agents in the run model.
{
  const dir = await mkdtemp(join(tmpdir(), "wf-human2-"));
  const jdir = join(dir, ".workflow-journal");
  await mkdir(jdir, { recursive: true });
  const jpath = join(jdir, "h.workflow.jsonl");
  const j = new Journal(jpath, { reuse: false });
  await j.load();
  const channel = { notify: () => {}, wait: async () => undefined }; // nobody answers
  const r = await runWorkflowSource([
    'export const meta = { name: "ht" };',
    'return await human("Risky write?", { id: "write-gate", choices: ["allow", "deny"], default: "deny", timeoutMs: 10 });',
  ].join("\n"), { journal: j, humanChannel: channel });
  assert.equal(r, "deny", "timeout falls back to the default");
  const run = buildRunModel({ journalPath: jpath, runDir: dir });
  assert.equal(run.agents.length, 0, "a human checkpoint is NOT an agent");
  assert.equal(run.checkpoints.length, 1, "…it surfaces as run.checkpoints");
  assert.equal(run.checkpoints[0].qid, "write-gate");
  assert.equal(run.checkpoints[0].answer, "deny");
  assert.equal(run.checkpoints[0].source, "default");
  await rm(dir, { recursive: true, force: true });
}

console.log("offline checks passed ✓");
