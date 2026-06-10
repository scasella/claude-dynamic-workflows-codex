// Fleet supervision checks — the agent-supervisor loop, no Codex, no tokens.
//
//  1. inspectRun's state machine (completed / running / stopped / stalled /
//     waiting-on-answer) against staged fixtures, with clock + pid-liveness
//     injected.
//  2. The `fleet answer` CLI: pending-only validation, qid resolution,
//     --answer-json, and the sidecar line format the runner's channel reads.
//  3. End-to-end: a REAL run-workflow child (human() gate only, zero agents,
//     --run-id isolation) is discovered by `fleet status`, answered by
//     `fleet answer`, and returns the supervisor's answer.
//
//   node test/fleet.test.js

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { inspectRun, resolveTargets, renderFleetText, pidAlive } from "../src/fleetStatus.js";

const FLEET = new URL("../bin/fleet.js", import.meta.url).pathname;
const RUN = new URL("../bin/run-workflow.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-fleet-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── 1 · inspectRun state machine ───────────────────────────────────────────
  const dir1 = join(ROOT, "runs");
  const jdir = join(dir1, ".workflow-journal");
  mkdirSync(jdir, { recursive: true });
  const NOW = Date.now();
  const T0 = NOW - 600_000; // all fixture runs "started" 10 minutes ago
  const J = (name) => join(jdir, name);

  // completed: result sidecar fresher than meta.startedAt
  writeFileSync(J("done.workflow.jsonl"),
    JSON.stringify({ key: "a#0", label: "scan", result: { ok: 1 }, phase: "Scan", tokens: 1000, ms: 5000 }) + "\n" +
    JSON.stringify({ key: "b#0", label: "fix", result: "done", phase: "Fix", tokens: 1000, ms: 5000 }) + "\n");
  writeFileSync(J("done.workflow.meta.json"), JSON.stringify({ pid: 99999999, startedAt: T0, budget: 500_000 }));
  writeFileSync(J("done.workflow.result.json"), JSON.stringify({ headline: "shipped" }));
  const done = inspectRun(J("done.workflow.jsonl"), { now: NOW, isAlive: () => false });
  assert.equal(done.state, "completed");
  assert.equal(done.tokens, 2000);
  assert.deepEqual(done.result, { headline: "shipped" });
  assert.equal(done.agents.done, 2);
  assert.equal(done.needsAttention, false, "a clean finished run needs no attention");

  // stopped: meta exists, pid dead, result STALE (older than this run's start)
  writeFileSync(J("stop.workflow.jsonl"), JSON.stringify({ key: "c#0", label: "probe", result: 1, tokens: 500 }) + "\n");
  writeFileSync(J("stop.workflow.meta.json"), JSON.stringify({ pid: 99999998, startedAt: T0 }));
  writeFileSync(J("stop.workflow.result.json"), JSON.stringify({ old: true }));
  utimesSync(J("stop.workflow.result.json"), new Date(T0 - 100_000), new Date(T0 - 100_000)); // previous run's result
  const stop = inspectRun(J("stop.workflow.jsonl"), { now: NOW, isAlive: () => false });
  assert.equal(stop.state, "stopped", "dead pid + stale result = stopped, not completed");
  assert.equal(stop.needsAttention, true);
  assert.equal(stop.result, undefined, "a stale result is not reported as the run's result");

  // running + a pending question: WAITING, not stalled (even with old events)
  writeFileSync(J("live.workflow.jsonl"), ""); // journal touched eagerly, no agent done yet
  writeFileSync(J("live.workflow.meta.json"), JSON.stringify({ pid: 1234, startedAt: T0, budget: 1_000_000, runId: "n1" }));
  writeFileSync(J("live.workflow.events.jsonl"),
    JSON.stringify({ t: NOW - 400_000, type: "start", id: "x#0", label: "hunt", phase: "Hunt" }) + "\n");
  writeFileSync(J("live.workflow.questions.json"), JSON.stringify([
    { id: "human:scope#0", qid: "scope", question: "Include admin routes?", choices: ["include", "exclude"], default: "exclude", askedAt: NOW - 30_000, answered: false },
  ]));
  const live = inspectRun(J("live.workflow.jsonl"), { now: NOW, stallAfterMs: 120_000, isAlive: () => true });
  assert.equal(live.state, "running");
  assert.equal(live.agents.running, 1);
  assert.equal(live.runId, "n1");
  assert.equal(live.pendingQuestions.length, 1);
  assert.equal(live.pendingQuestions[0].qid, "scope");
  assert.equal(live.stalled, false, "a run waiting on its supervisor is not stalled");
  assert.equal(live.needsAttention, true, "a pending question IS attention-worthy");

  // stalled: live pid, no pending question, no activity past the threshold —
  // including FILE activity (journal/progress mtimes count as activity, since a
  // streaming agent rewrites progress while the event stream is silent)
  writeFileSync(J("stall.workflow.jsonl"), "");
  writeFileSync(J("stall.workflow.meta.json"), JSON.stringify({ pid: 1234, startedAt: T0 }));
  writeFileSync(J("stall.workflow.events.jsonl"),
    JSON.stringify({ t: NOW - 400_000, type: "start", id: "y#0", label: "dig", phase: "Dig" }) + "\n");
  utimesSync(J("stall.workflow.jsonl"), new Date(NOW - 400_000), new Date(NOW - 400_000));
  const stall = inspectRun(J("stall.workflow.jsonl"), { now: NOW, stallAfterMs: 120_000, isAlive: () => true });
  assert.equal(stall.state, "running");
  assert.equal(stall.stalled, true);
  assert.equal(stall.needsAttention, true);

  // …but a fresh progress sidecar (an agent mid-stream) clears the stall
  writeFileSync(J("stall.workflow.progress.json"), JSON.stringify({ "y#0": "still reading files…" }));
  const streaming = inspectRun(J("stall.workflow.jsonl"), { now: NOW, stallAfterMs: 120_000, isAlive: () => true });
  assert.equal(streaming.stalled, false, "streaming output IS activity — no false stall during a long silent layer");
  rmSync(J("stall.workflow.progress.json"));

  // resolveTargets: a dir contributes ALL journals; sidecar .jsonl files are
  // NOT runs; explicit paths pass through; duplicates collapse
  writeFileSync(J("live.workflow.answers.jsonl"), JSON.stringify({ id: "x", answer: "y" }) + "\n");
  const targets = resolveTargets([dir1]);
  assert.equal(targets.length, 4, `4 runs, no sidecar decoys (got: ${targets.join(", ")})`);
  assert.ok(!targets.some((t) => t.includes(".answers.") || t.includes(".events.")));
  assert.deepEqual(resolveTargets([J("done.workflow.jsonl")]), [J("done.workflow.jsonl")]);
  assert.equal(resolveTargets([dir1, J("done.workflow.jsonl")]).length, 4, "dir + member journal dedupes");

  // render smoke: headline counts + every attention condition surfaces
  const text = renderFleetText([done, stop, live, stall]);
  assert.match(text, /fleet: 4 runs/);
  assert.match(text, /⚠ 3 need attention/);
  assert.match(text, /waiting .* on \[human:scope#0\]/);
  assert.match(text, /stalled — no activity/);
  assert.match(text, /stopped WITHOUT a result/);
  assert.match(text, /result: \{"headline":"shipped"\}/);
  assert.match(text, /fleet\.js answer --journal/, "pending questions carry a paste-ready answer command");

  // ── 2 · fleet answer CLI ───────────────────────────────────────────────────
  writeFileSync(J("live.workflow.questions.json"), JSON.stringify([
    { id: "human:scope#0", qid: "scope", question: "Include admin routes?", choices: ["include", "exclude"], default: "exclude", askedAt: NOW - 30_000, answered: false },
    { id: "human:old#0", qid: "old", question: "Earlier gate?", askedAt: NOW - 90_000, answered: true, answer: "yes" },
  ]));
  const run = (args) => spawnSync("node", [FLEET, ...args], { encoding: "utf8" });

  const list = run(["answer", "--journal", J("live.workflow.jsonl"), "--list"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /1 pending \/ 2 asked/);
  assert.match(list.stdout, /PENDING/);

  assert.equal(run(["answer", "--journal", J("live.workflow.jsonl"), "--id", "human:nope#0", "--answer", "x"]).status, 1, "unknown id rejected");
  const already = run(["answer", "--journal", J("live.workflow.jsonl"), "--id", "old", "--answer", "x"]);
  assert.equal(already.status, 1, "an answered gate can't be re-answered");
  assert.match(already.stderr, /not pending anymore/);

  // answer by qid; the sidecar line must be exactly what the runner's channel reads
  const ok = run(["answer", "--journal", J("live.workflow.jsonl"), "--id", "scope", "--answer", "include"]);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = readFileSync(J("live.workflow.answers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.id, "human:scope#0", "qid resolved to the full pending id");
  assert.equal(last.answer, "include");

  const okJson = run(["answer", "--journal", J("live.workflow.jsonl"), "--id", "scope", "--answer", '{"go":true}', "--answer-json"]);
  assert.equal(okJson.status, 0);
  const lines2 = readFileSync(J("live.workflow.answers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines2[lines2.length - 1].answer, { go: true }, "--answer-json parses structured answers");
  assert.equal(run(["answer", "--journal", J("live.workflow.jsonl"), "--id", "scope", "--answer", "{bad", "--answer-json"]).status, 1);

  // ── 3 · end-to-end: supervise a real run (no Codex, no tokens) ─────────────
  const gdir = join(ROOT, "gate");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "gate.workflow.js"), `export const meta = { name: 'gate-demo', description: 'a supervisor gate, zero agents', phases: [{ title: 'Gate' }] }
phase('Gate')
const go = await human("Ship the fix?", { id: "go", choices: ["yes", "no"], default: "no", timeoutMs: 30000 })
return { go }
`);
  const notifyLog = join(ROOT, "notify.log");
  const child = spawn(
    "node",
    [RUN, "gate.workflow.js", "--run-id", "alpha", "--no-summary",
      // --notify-cmd implies --interactive; the event JSON arrives via $WORKFLOW_EVENT
      "--notify-cmd", `printf '%s\\n' "$WORKFLOW_EVENT" >> '${notifyLog}'`],
    { cwd: gdir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));

  // --run-id isolates the journal; the eager touch makes the run discoverable at once
  const gj = join(gdir, ".workflow-journal", "gate.workflow--alpha.jsonl");
  const qPath = gj.replace(/\.jsonl$/, "") + ".questions.json";
  let pending = [];
  for (let i = 0; i < 100 && !pending.length; i++) {
    await sleep(100);
    try { pending = JSON.parse(readFileSync(qPath, "utf8")).filter((q) => !q.answered); } catch {}
  }
  assert.equal(pending.length, 1, `the gate should be pending (stderr so far: ${err})`);

  // the out-of-band notifier fired for the pending gate (detached shell hook)
  let notified = [];
  for (let i = 0; i < 50 && !notified.length; i++) {
    await sleep(100);
    try { notified = readFileSync(notifyLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
  }
  assert.equal(notified[0]?.event, "question", "--notify-cmd fired on the pending gate");
  assert.equal(notified[0]?.id, "human:go#0");
  assert.equal(notified[0]?.qid, "go");
  assert.ok(notified[0]?.journal?.endsWith("gate.workflow--alpha.jsonl"), "the event carries the journal path to answer against");

  // the supervisor's poll: fleet status sees a live run waiting on an answer
  const st = spawnSync("node", [FLEET, "status", gdir, "--json"], { encoding: "utf8" });
  assert.equal(st.status, 0, st.stderr);
  const infos = JSON.parse(st.stdout);
  assert.equal(infos.length, 1, "exactly one run (sidecars are not runs)");
  assert.equal(infos[0].state, "running");
  assert.equal(infos[0].pid, child.pid, "status reports the real runner pid");
  assert.equal(infos[0].runId, "alpha");
  assert.equal(infos[0].pendingQuestions[0]?.id, "human:go#0");
  assert.ok(pidAlive(child.pid));

  // the supervisor's verb: answer the gate through the CLI channel
  const ans = spawnSync("node", [FLEET, "answer", "--journal", gj, "--id", "go", "--answer", "yes"], { encoding: "utf8" });
  assert.equal(ans.status, 0, ans.stderr);

  const code = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);
  assert.equal(code, 0, `runner should exit cleanly (stderr: ${err})`);
  assert.deepEqual(JSON.parse(out), { go: "yes" }, "the workflow returned the SUPERVISOR'S answer, not the default");
  const jl = readFileSync(gj, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gate = jl.find((e) => e.key === "human:go#0");
  assert.equal(gate?.result, "yes");
  assert.equal(gate?.source, "live", "the answer was journaled as live-channel (replayable on --resume)");

  // the notifier also fired on the run's end, with the terminal status
  let endEvt = null;
  for (let i = 0; i < 50 && !endEvt; i++) {
    await sleep(100);
    try {
      const evs = readFileSync(notifyLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      endEvt = evs.find((e) => e.event === "end") ?? null;
    } catch {}
  }
  assert.equal(endEvt?.status, "completed", "--notify-cmd fired on run end with the terminal status");

  // after exit: the same poll shows completed + the result
  const st2 = spawnSync("node", [FLEET, "status", gdir, "--json"], { encoding: "utf8" });
  const infos2 = JSON.parse(st2.stdout);
  assert.equal(infos2.length, 1);
  assert.equal(infos2[0].state, "completed");
  assert.deepEqual(infos2[0].result, { go: "yes" });
  assert.equal(infos2[0].needsAttention, false);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log("fleet (supervisor loop) checks passed ✓");
