// Offline unit checks for the protocol-level session driver (codexSession.js):
// CodexSessionDriver + startCodexSession. No app-server, no network, no tokens.
//
// The runtime-level orchestration (agent.start/waitAny/steer) is covered in
// offline.js (tests 26–39) via a fake `startSession` seam; THIS file targets the
// driver layer beneath it, which otherwise has zero direct coverage. We construct
// CodexSessionDriver directly with a hand-rolled fake client implementing the
// AppServerClient surface { startThread, startTurn, interruptTurn,
// waitForNotification, on, off } and emit raw `notification` frames to drive it.
//
// Style mirrors offline.js: plain node:assert/strict, top-level await blocks with
// a numbered/titled comment, a final "ok" line, no test framework.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexSessionDriver, startCodexSession } from "../src/codexSession.js";
import { recordTokenUsage, resetMeter, tokensForThread } from "../src/meter.js";

// ── Fake client ───────────────────────────────────────────────────────────────
// An EventEmitter implementing the AppServerClient surface the driver touches.
// `notification` events feed attachAgentMessageCollector exactly as the real
// client does. waitForNotification mirrors the real predicate/listener algorithm
// (so emitting a matching `turn/completed` resolves the turn naturally), but each
// test can override startTurn / interruptTurn / waitForNotification to inject
// behavior or chaos.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.startTurnCalls = [];
    this.startThreadCalls = [];
    this.interruptCalls = [];
    this._turnSeq = 0;
    // Per-instance hooks; default to benign behavior (unique turn id per call).
    this.startTurnImpl = async (params) => ({ turn: { id: `${params.threadId}:turn${++this._turnSeq}` } });
    this.startThreadImpl = async () => ({ thread: { id: "fake-thread" } });
    this.interruptImpl = async () => ({});
    // waitForNotification behavior is selectable: "wait" (real predicate listener,
    // resolved by a matching emit) or a function that returns a promise.
    this.waitImpl = null; // null => real predicate listener
  }

  async startThread(params) {
    this.startThreadCalls.push(params);
    return this.startThreadImpl(params);
  }

  async startTurn(params) {
    this.startTurnCalls.push(params);
    return this.startTurnImpl(params);
  }

  async interruptTurn(threadId, turnId) {
    this.interruptCalls.push({ threadId, turnId });
    return this.interruptImpl(threadId, turnId);
  }

  waitForNotification(predicate, timeoutMs) {
    if (typeof this.waitImpl === "function") return this.waitImpl(predicate, timeoutMs);
    // Real algorithm: resolve when a matching `notification` arrives.
    return new Promise((resolve) => {
      const listener = (n) => {
        if (!predicate(n)) return;
        this.off("notification", listener);
        resolve(n);
      };
      this.on("notification", listener);
    });
  }

  // Test helpers that emit the raw protocol frames the driver/collector consume.
  emitDelta(threadId, itemId, delta) {
    this.emit("notification", { method: "item/agentMessage/delta", params: { threadId, itemId, delta } });
  }
  emitMessageCompleted(threadId, text) {
    this.emit("notification", { method: "item/completed", params: { threadId, item: { type: "agentMessage", text } } });
  }
  emitTurnCompleted(threadId, turn) {
    this.emit("notification", { method: "turn/completed", params: { threadId, turn } });
  }

  // Count of `notification` listeners — the collector attaches exactly one per turn
  // and must detach it on settle (leak detector).
  noteListeners() {
    return this.listenerCount("notification");
  }
}

const driverFor = (client, extra = {}) =>
  new CodexSessionDriver({ client, threadId: "th", model: "fake-model", log: () => {}, ...extra });

// 1) Happy path: beginTurn resolves promptly (before turn/completed); deltas
//    accumulate; completion resolves "completed" with the final agentMessage text;
//    the collector detaches after settle (a later delta does not change the text).
{
  const client = new FakeClient();
  const driver = driverFor(client);
  const baseline = client.noteListeners();

  const { turnId, completion } = await driver.beginTurn("hello");
  assert.ok(turnId, "beginTurn returns a turnId before turn/completed");
  assert.equal(driver.currentTurnId, turnId, "currentTurnId tracks the active turn");
  assert.equal(driver._active, true, "driver is active while the turn runs");
  // During a turn there are two `notification` listeners: the collector AND the
  // waitForNotification predicate listener (same as the real client). Both detach.
  assert.equal(client.noteListeners(), baseline + 2, "collector + waitForNotification listeners are attached during the turn");

  client.emitDelta("th", "i1", "Hel");
  client.emitDelta("th", "i1", "lo!");
  client.emitMessageCompleted("th", "Hello!");
  client.emitTurnCompleted("th", { id: turnId, status: "completed" });

  const out = await completion;
  assert.equal(out.status, "completed");
  assert.equal(out.text, "Hello!", "final text is the authoritative item/completed text");
  assert.equal(out.result, "Hello!", "no schema -> result is the raw text");
  assert.equal(out.model, "fake-model");
  assert.equal(out.turnId, turnId);
  assert.equal(typeof out.ms, "number");
  assert.equal(driver._active, false, "driver is idle after the turn settles");
  assert.equal(client.noteListeners(), baseline, "collector detached on settle (no leak)");

  // A delta emitted AFTER settle must not mutate the already-returned outcome.
  client.emitDelta("th", "i1", "MORE");
  assert.equal(out.text, "Hello!", "post-settle deltas are ignored (collector detached)");
}

// 2) Schema parsing: turnOpts.schema -> completion.result is the parsed object,
//    and the fenced-JSON fallback works when the model wraps JSON in a code fence.
{
  // strict JSON
  {
    const client = new FakeClient();
    const driver = driverFor(client);
    const { turnId, completion } = await driver.beginTurn("q", { schema: { type: "object", properties: { a: { type: "number" } } } });
    client.emitMessageCompleted("th", '{"a":1}');
    client.emitTurnCompleted("th", { id: turnId, status: "completed" });
    const out = await completion;
    assert.deepEqual(out.result, { a: 1 }, "schema -> result is the parsed object");
    assert.equal(out.text, '{"a":1}', "raw text is preserved alongside the parsed result");
  }
  // fenced-JSON fallback
  {
    const client = new FakeClient();
    const driver = driverFor(client);
    const { turnId, completion } = await driver.beginTurn("q", { schema: { type: "object" } });
    client.emitMessageCompleted("th", "Here you go:\n```json\n{\"b\": 2}\n```");
    client.emitTurnCompleted("th", { id: turnId, status: "completed" });
    const out = await completion;
    assert.deepEqual(out.result, { b: 2 }, "fenced-JSON fallback parses despite surrounding prose");
  }
}

// 3) Per-turn token deltas: tokens are the delta over the thread's cumulative total
//    at turn start — NOT the cumulative total — across two sequential turns.
{
  resetMeter();
  const client = new FakeClient();
  const driver = driverFor(client);

  // Cumulative before turn 1: 100.
  recordTokenUsage({ threadId: "th", tokenUsage: { total: { inputTokens: 100, outputTokens: 0, reasoningOutputTokens: 0 } } });
  const t1 = await driver.beginTurn("first");
  // Turn 1 consumed 30 (cumulative climbs to 130).
  recordTokenUsage({ threadId: "th", tokenUsage: { total: { inputTokens: 120, outputTokens: 10, reasoningOutputTokens: 0 } } });
  client.emitTurnCompleted("th", { id: t1.turnId, status: "completed" });
  const out1 = await t1.completion;
  assert.equal(out1.tokens, 30, "turn 1 tokens = 130 - 100 (the delta, not the 130 cumulative)");
  assert.equal(tokensForThread("th").total, 130, "the cumulative meter still reads 130");

  const t2 = await driver.beginTurn("second");
  // Turn 2 consumed 45 (cumulative climbs to 175).
  recordTokenUsage({ threadId: "th", tokenUsage: { total: { inputTokens: 160, outputTokens: 15, reasoningOutputTokens: 0 } } });
  client.emitTurnCompleted("th", { id: t2.turnId, status: "completed" });
  const out2 = await t2.completion;
  assert.equal(out2.tokens, 45, "turn 2 tokens = 175 - 130 (the delta over turn-1's cumulative)");
  resetMeter();
}

// 4) interruptCurrent -> completion resolves status "interrupted" (never rejects).
{
  const client = new FakeClient();
  const driver = driverFor(client);
  const { turnId, completion } = await driver.beginTurn("slow");
  await driver.interruptCurrent();
  assert.deepEqual(client.interruptCalls, [{ threadId: "th", turnId }], "interruptCurrent calls turn/interrupt with the active ids");
  // The server reports the interruption as a turn/completed with status interrupted.
  client.emitTurnCompleted("th", { id: turnId, status: "interrupted" });
  const out = await completion;
  assert.equal(out.status, "interrupted", "an interrupted turn settles as interrupted, not failed");
  assert.equal(out.error, null, "an interrupted outcome carries no error");
  assert.equal(driver._active, false);
}

// 5) Interrupt race: interruptTurn rejects with /no active turn/i -> logged benign,
//    interruptCurrent does NOT throw.
{
  const logs = [];
  const client = new FakeClient();
  client.interruptImpl = async () => { throw new Error("turn/interrupt failed: no active turn for thread"); };
  const driver = driverFor(client, { log: (m) => logs.push(m) });
  const { turnId, completion } = await driver.beginTurn("x");
  await assert.doesNotReject(() => driver.interruptCurrent(), "a benign interrupt race must not throw");
  assert.ok(logs.some((m) => /no-op/i.test(m)), "the benign race is logged as a no-op");
  // The turn was actually already done; settle it so we don't leak a pending promise.
  client.emitTurnCompleted("th", { id: turnId, status: "completed" });
  await completion;
}

// 6) Turn timeout: waitForNotification rejects (timeout) -> completion resolves
//    "failed" with the error message, and interruptTurn was attempted best-effort.
{
  const client = new FakeClient();
  client.waitImpl = async () => { throw new Error("Timed out waiting for app-server notification"); };
  const driver = driverFor(client);
  const { turnId, completion } = await driver.beginTurn("x");
  const out = await completion;
  assert.equal(out.status, "failed", "a turn timeout settles as failed, not a rejection");
  assert.match(out.error, /Timed out waiting/, "the failed outcome carries the timeout message");
  assert.deepEqual(client.interruptCalls, [{ threadId: "th", turnId }], "the driver best-effort interrupts the abandoned turn");
  assert.equal(driver._active, false, "driver is idle after a timeout");
}

// 7) CHAOS — transport dies mid-turn: waitForNotification rejects with "Transport is
//    not connected" -> completion resolves "failed" (NOT a rejection), _active is
//    cleared, and a SUBSEQUENT beginTurn on the same driver works again (the session
//    object stays usable even though server-side thread state may be gone).
{
  const client = new FakeClient();
  client.waitImpl = async () => { throw new Error("Transport is not connected"); };
  // The best-effort interrupt also fails on a dead transport — must be swallowed.
  client.interruptImpl = async () => { throw new Error("Transport is not connected"); };
  const driver = driverFor(client);

  const { completion } = await driver.beginTurn("doomed");
  const out = await completion;
  assert.equal(out.status, "failed", "a mid-turn transport death settles as failed (completion never rejects)");
  assert.match(out.error, /Transport is not connected/);
  assert.equal(driver._active, false, "_active is cleared after the transport death (not stuck)");

  // Recovery: the transport comes back; a new turn on the SAME driver works.
  client.waitImpl = null; // real predicate listener again
  const baseline = client.noteListeners();
  const t2 = await driver.beginTurn("after-recovery");
  client.emitMessageCompleted("th", "recovered");
  client.emitTurnCompleted("th", { id: t2.turnId, status: "completed" });
  const out2 = await t2.completion;
  assert.equal(out2.status, "completed", "the driver is reusable after a transport death");
  assert.equal(out2.text, "recovered");
  assert.equal(client.noteListeners(), baseline, "the recovery turn left no listener behind");
}

// 8) CHAOS — dead transport at turn start: startTurn rejects -> beginTurn THROWS
//    (the documented "could not start" path) and the collector is detached (no leak).
{
  const client = new FakeClient();
  client.startTurnImpl = async () => { throw new Error("Transport is not connected"); };
  const driver = driverFor(client);
  const baseline = client.noteListeners();

  await assert.rejects(() => driver.beginTurn("x"), /Transport is not connected/, "beginTurn throws when the turn cannot be started");
  assert.equal(client.noteListeners(), baseline, "the collector listener was detached on the failed start (no leak)");
  assert.equal(driver._active, false, "a failed start leaves the driver idle");
  assert.equal(driver.currentTurnId, null, "a failed start does not set a current turn");
}

// 9) beginTurn while a turn is active throws the internal guard error.
{
  const client = new FakeClient();
  const driver = driverFor(client);
  const { turnId, completion } = await driver.beginTurn("first");
  await assert.rejects(() => driver.beginTurn("second"), /beginTurn called while a turn is active/, "the one-active-turn guard fires");
  // settle the first turn to avoid a dangling pending promise
  client.emitTurnCompleted("th", { id: turnId, status: "completed" });
  await completion;
}

// 10) Two sequential turns on one driver share the same threadId (warm context) and
//     produce independent outcomes.
{
  const client = new FakeClient();
  const driver = driverFor(client);

  const t1 = await driver.beginTurn("turn one");
  client.emitMessageCompleted("th", "one");
  client.emitTurnCompleted("th", { id: t1.turnId, status: "completed" });
  const out1 = await t1.completion;

  const t2 = await driver.beginTurn("turn two");
  client.emitMessageCompleted("th", "two");
  client.emitTurnCompleted("th", { id: t2.turnId, status: "completed" });
  const out2 = await t2.completion;

  assert.equal(client.startTurnCalls.length, 2, "two turns issued");
  assert.equal(client.startTurnCalls[0].threadId, "th");
  assert.equal(client.startTurnCalls[1].threadId, "th");
  assert.equal(client.startTurnCalls[0].threadId, client.startTurnCalls[1].threadId, "both turns ran on the SAME thread (warm context)");
  assert.equal(out1.text, "one");
  assert.equal(out2.text, "two");
  assert.notEqual(out1.turnId, out2.turnId, "independent turns have distinct turn ids");
}

// 11) cleanup(): a fake worktree.cleanup() is called once and is idempotent on a
//     second cleanup().
{
  const dir = "/tmp/fake-wt";
  let calls = 0;
  const worktree = { cleanup: async () => { calls++; return { removed: true, dir }; } };
  const client = new FakeClient();
  const driver = driverFor(client, { worktree });

  await driver.cleanup();
  assert.equal(calls, 1, "cleanup() removes the worktree once");
  await driver.cleanup();
  assert.equal(calls, 1, "a second cleanup() is a no-op (idempotent — worktree already released)");
}

// 11b) cleanup() logs when the worktree is kept (dirty) and swallows a cleanup error.
{
  const logs = [];
  const client = new FakeClient();
  const kept = driverFor(client, { worktree: { cleanup: async () => ({ removed: false, dir: "/tmp/dirty" }) }, log: (m) => logs.push(m) });
  await kept.cleanup();
  assert.ok(logs.some((m) => /worktree kept/.test(m)), "a kept (dirty) worktree is logged");

  const logs2 = [];
  const failing = driverFor(client, { worktree: { cleanup: async () => { throw new Error("rm -rf blew up"); } }, log: (m) => logs2.push(m) });
  await assert.doesNotReject(() => failing.cleanup(), "a worktree cleanup error must not propagate out of cleanup()");
  assert.ok(logs2.some((m) => /worktree cleanup failed/.test(m)), "the cleanup failure is logged");
}

// 12) Listener hygiene across many turns: after N=5 sequential turns, the client's
//     notification-listener count returns to baseline (no accumulation/leak).
{
  const client = new FakeClient();
  const driver = driverFor(client);
  const baseline = client.noteListeners();
  for (let i = 0; i < 5; i++) {
    const t = await driver.beginTurn(`turn ${i}`);
    assert.equal(client.noteListeners(), baseline + 2, `turn ${i}: collector + waitForNotification attached during the turn`);
    client.emitMessageCompleted("th", `r${i}`);
    client.emitTurnCompleted("th", { id: t.turnId, status: "completed" });
    const out = await t.completion;
    assert.equal(out.status, "completed");
    assert.equal(client.noteListeners(), baseline, `turn ${i}: collector detached after settle`);
  }
  assert.equal(client.noteListeners(), baseline, "no listeners leaked across 5 sequential turns");
}

// 13) startCodexSession with an injected fake client (opts.clientOptions): if the
//     real getClient honors clientOptions without a network we exercise the real
//     wiring; otherwise we skip and lean on the direct-driver coverage above.
//     getClient() ALWAYS spawns a real `codex app-server` child regardless of
//     clientOptions, so there is no network-free injection seam — the constructor
//     coverage above (driverFor) is the protocol-level surface, and the runtime
//     seam test (offline.js #26+) covers startSession orchestration. We assert only
//     that the export exists and is a function so the contract is pinned.
{
  assert.equal(typeof startCodexSession, "function", "startCodexSession is exported");
  // NOTE: not invoked — getClient() unconditionally spawns `codex app-server`
  // (see codexAgent.getClient), so it cannot run offline. Driver coverage above is
  // the priority and is exercised directly via the CodexSessionDriver constructor.
}

console.log("codex-session driver checks passed ✓");
