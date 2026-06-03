// Offline unit checks for the provider-neutral pieces — no app-server, no tokens.
// Covers the comment-shadowing regression and parallel/pipeline semantics.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMeta, runWorkflowSource } from "../src/runWorkflow.js";
import { effortForLayerWidth } from "../src/runtime.js";
import { isGitRepo, createWorktree } from "../src/worktree.js";
import { identityHash, Journal } from "../src/journal.js";
import { resolveModel, pickFrontier } from "../src/modelMap.js";
import { loadAgentType } from "../src/agentTypes.js";
import { isRetryable } from "../src/codexAgent.js";

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

console.log("offline checks passed ✓");
