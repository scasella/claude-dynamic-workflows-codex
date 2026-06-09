// Provider-neutral re-implementation of the dynamic-workflow globals
// (agent / parallel / pipeline / phase / log / budget / args / workflow).
//
// Nothing here mentions Claude or Codex: this is the scheduling glue that the
// Workflow tool description specifies. Only agent() reaches a model, via the
// codexAgent seam. Concurrency is capped exactly like the native runtime:
// min(16, cores-2), with a hard 1000-agent backstop.

import os from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { codexAgent } from "./codexAgent.js";
import { startCodexSession } from "./codexSession.js";
import { tokensSpent, outputSpent } from "./meter.js";

const CAP = Math.min(16, Math.max(1, (os.cpus()?.length ?? 4) - 2));

// A path-like workflow ref (has a separator or a .js/.mjs/.cjs extension) is used
// verbatim; anything else is a saved-workflow *name* resolved via the registry.
function looksLikePath(s) {
  return s.includes("/") || s.includes("\\") || /\.[cm]?js$/.test(s);
}

// Named-workflow registry: resolve `workflow("name")` to a script file, project
// scope (.claude/workflows/) shadowing home (~/.claude/workflows/), matching the
// native save locations. `<name>.js` and `<name>.workflow.js` both accepted.
function resolveNamedWorkflow(name) {
  const dirs = [
    join(process.cwd(), ".claude", "workflows"),
    join(os.homedir(), ".claude", "workflows"),
  ];
  const files = [`${name}.js`, `${name}.workflow.js`, `${name}.mjs`];
  for (const d of dirs) {
    for (const f of files) {
      const p = join(d, f);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `workflow("${name}"): no saved workflow found. Searched ${dirs.join(" and ")} ` +
      `for ${name}.js / ${name}.workflow.js`,
  );
}

// Build a minimal value that satisfies a JSON Schema, so a --plan dry run can let
// the orchestration logic run (property access, .map over arrays) without calling
// a model. Arrays come back EMPTY — fan-outs sized from agent output are therefore
// uncounted (a lower bound); the CLI flags this.
export function schemaSkeleton(schema) {
  if (!schema || typeof schema !== "object") return "";
  return skel(schema);
}
function skel(s) {
  if (!s || typeof s !== "object") return null;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.oneOf || s.anyOf) return skel((s.oneOf || s.anyOf)[0]);
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === "object" || (!t && s.properties)) {
    const o = {};
    for (const k of Object.keys(s.properties || {})) o[k] = skel(s.properties[k]);
    return o;
  }
  if (t === "array") return [];
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  if (t === "string") return "";
  return null;
}

// Layer-width context. parallel()/pipeline() publish how many agents run
// side-by-side in the current layer; agent() reads it (default 1 for a lone,
// un-fanned-out call) to scale thinking effort. AsyncLocalStorage propagates
// across awaits and through the vm-hosted thunks, so a queued or deeply-awaited
// agent still sees the width of the layer that spawned it.
const layerCtx = new AsyncLocalStorage();
function currentLayerWidth() {
  return layerCtx.getStore()?.width ?? 1;
}

// Thinking effort scales INVERSELY with layer width: a lone agent is a critical
// gate (consolidation / judge / report) and earns maximum reasoning. Every
// fan-out floors at `high` — we never drop to `medium`, even on wide layers.
// One knob, one place.
//   width 1   -> xhigh   (sole agent in its layer: critical gate)
//   width >= 2 -> high    (any fan-out: floor)
export function effortForLayerWidth(width) {
  if (width <= 1) return "xhigh";
  return "high";
}

// A single global semaphore — only agent() calls consume a slot, matching
// "Concurrent agent() calls are capped at min(16, cpu cores - 2)".
let active = 0;
const waiters = [];
function acquire() {
  if (active < CAP) {
    active++;
    return Promise.resolve();
  }
  return new Promise((res) => waiters.push(res));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}
async function pooled(thunk) {
  await acquire();
  try {
    return await thunk();
  } finally {
    release();
  }
}

// Test/observability hook: in-flight model slots (one-shot agents + live session
// turns) against the single process-wide semaphore. A detached running session
// turn occupies a slot until it settles — this lets tests prove that.
export function __activeSlots() {
  return active;
}

export function createRuntime({
  args,
  budgetTotal = null,
  budgetMeter = "total", // "total" (input+output, default) | "output" (native pool)
  defaults = {},
  defaultModel,
  pinnedModel,
  autoEffort = false,
  pinnedEffort = null,
  plan = false, // --plan dry run: count agents, never call a model
  onPhase,
  onLog,
  onAgentPlan, // dry-run sink: receives { label, phase, effort, width, schema } per agent
  onEvent, // lifecycle sink: { type:'start'|'end'|'cached', label, phase, ... } for live viewers
  onProgress, // live partial-output sink: (label, partialText) while an agent streams
  journal = null,
  runAgent = codexAgent, // seam: injected in tests to capture resolved opts
  startSession = startCodexSession, // seam: injected in tests for sessionful workers
} = {}) {
  let agentCount = 0;
  let currentPhase = null; // last phase() title; the fallback when opts.phase is unset
  const AGENT_CAP = 1000;
  const meterSpent = () => (budgetMeter === "output" ? outputSpent() : tokensSpent());

  let sessionSeq = 0; // deterministic session ids (s1, s2, …) within this runtime
  const openSessions = new Set(); // live sessions awaiting close() — drained by finalize()

  // Runaway backstop shared by agent() and every session turn.
  function bumpAgentCount() {
    if (++agentCount > AGENT_CAP) {
      throw new Error(`Agent cap (${AGENT_CAP}) exceeded — runaway workflow?`);
    }
  }
  // Budget gate shared by agent() and session start/steer. Throws BUDGET_EXCEEDED.
  function checkBudget() {
    if (budgetTotal && meterSpent() >= budgetTotal) {
      const err = new Error(`Token budget exhausted (${meterSpent()}/${budgetTotal} ${budgetMeter} tokens)`);
      err.code = "BUDGET_EXCEEDED";
      throw err;
    }
  }
  // Thinking-effort policy in ONE place (used by agent() and sessions). Precedence
  // (highest first): --pin-effort > per-call effort > --auto-effort (layer width) >
  // --effort flag > Codex config default (effort omitted). Returns { effort, src }.
  function resolveEffort(callOpts, width) {
    if (pinnedEffort != null) return { effort: pinnedEffort, src: "pin" };
    if (callOpts.effort != null) return { effort: callOpts.effort, src: "call" };
    if (autoEffort) return { effort: effortForLayerWidth(width), src: "auto" };
    if (defaults.effort != null) return { effort: defaults.effort, src: "flag" };
    return { effort: undefined, src: "default" };
  }

  async function agent(prompt, opts = {}) {
    bumpAgentCount();
    const merged = { ...defaults, ...opts };
    const label =
      opts.label || (typeof prompt === "string" ? prompt.slice(0, 64) : "agent");
    // Phase attribution: an explicit per-call `phase` wins (the reliable signal
    // inside concurrent pipeline/parallel stages, where the global phase() races),
    // else the last phase() title. Persisted to the journal for the viewer.
    const effectivePhase = opts.phase ?? currentPhase ?? null;

    // Resolve thinking effort. Precedence (highest first):
    //   pinnedEffort (--pin-effort)        authoritative, like --pin-model
    //   per-call opts.effort               the author's deliberate choice
    //   layer-width policy (--auto-effort)  1->xhigh, >=2->high (floor)
    //   defaults.effort (--effort)         flat fallback
    //   undefined                          Codex config default (effort omitted)
    // The effective effort is written back onto `merged`, so it both reaches the
    // agent and participates in the journal identity (a policy change busts cache).
    const width = currentLayerWidth();
    const { effort: resolvedEffort, src: effortSrc } = resolveEffort(opts, width);
    if (resolvedEffort === undefined) delete merged.effort;
    else merged.effort = resolvedEffort;

    // --plan dry run: record the would-be agent and return a schema skeleton so
    // the orchestration keeps running. No model call, no budget, no journal.
    if (plan) {
      onAgentPlan?.({ label, phase: effectivePhase, effort: merged.effort ?? null, width, schema: !!opts.schema });
      return schemaSkeleton(opts.schema);
    }

    checkBudget();

    // Resume journal: allocate a stable key (called on every run, even a cache
    // miss, to keep occurrence counters aligned) and short-circuit on a hit.
    // Identity includes the *effective* model (pinned, else script opt, else CLI
    // default) and effort (set above on `merged`) so a model/effort change busts
    // the cache; --fresh forces a full re-run.
    const key = journal
      ? journal.nextKey(prompt, { ...merged, model: pinnedModel ?? opts.model ?? defaultModel })
      : null;
    if (key && journal.hit(key)) {
      onLog?.(`  ◦ agent (cached): ${label}`);
      onEvent?.({ type: "cached", id: key, label, phase: effectivePhase });
      return journal.get(key);
    }

    const reqModel = pinnedModel ?? opts.model ?? defaultModel ?? null;
    const effortTag = merged.effort
      ? `  ⟪${merged.effort}${effortSrc === "auto" ? `·layer×${width}` : ""}⟫`
      : "";
    onLog?.(`  · agent: ${label}${opts.schema ? "  [schema]" : ""}${effortTag}`);
    // Emit a lifecycle 'start' so live viewers can show this agent as running.
    // `id` is the stable journal key (null only without a journal) — viewers and
    // the run summary key by it so agents that share a display label never collide.
    onEvent?.({ type: "start", id: key, label, phase: effectivePhase, effort: merged.effort ?? null, model: reqModel });
    // Capture per-agent metrics off a side channel (the model-facing return value
    // is unchanged); fold them into the journal entry alongside phase/effort/model.
    let metrics = null;
    const result = await pooled(() =>
      runAgent(prompt, {
        ...merged, defaultModel, pinnedModel, log: onLog,
        onMetrics: (m) => { metrics = m; },
        onProgress: onProgress ? (text) => onProgress(label, text, key) : undefined,
      }),
    );
    onEvent?.({
      type: "end", id: key, label, phase: effectivePhase, effort: merged.effort ?? null,
      model: metrics?.model ?? reqModel,
      tokens: metrics?.tokens?.total ?? null,
      ms: metrics?.ms ?? null,
    });
    if (key) {
      await journal.record(key, label, result, {
        phase: effectivePhase,
        effort: merged.effort ?? null,
        model: metrics?.model ?? reqModel,
        tokens: metrics?.tokens?.total ?? null,
        tokensOut: metrics?.tokens ? metrics.tokens.output + metrics.tokens.reasoning : null,
        ms: metrics?.ms ?? null,
      });
    }
    return result;
  }

  // BARRIER fan-out. A thunk that throws (or whose agent errors) resolves to null.
  // Each thunk runs under a layer-width store of thunks.length, so agent() calls
  // inside it can scale effort to the fan-out (see effortForLayerWidth).
  async function parallel(thunks) {
    const width = thunks.length;
    return Promise.all(
      thunks.map((t) =>
        layerCtx.run({ width }, () =>
          Promise.resolve()
            .then(t)
            .catch((e) => {
              onLog?.(`  ! parallel task failed: ${e?.message ?? e}`);
              return null;
            }),
        ),
      ),
    );
  }

  // Per-item staging with NO barrier between stages. A stage that throws drops
  // that item to null and skips its remaining stages. The whole per-item chain
  // runs under a layer-width store of items.length (the stage fan-out width).
  async function pipeline(items, ...stages) {
    const width = items.length;
    return Promise.all(
      items.map((item, i) =>
        layerCtx.run({ width }, async () => {
          let v = item;
          for (const stage of stages) {
            try {
              v = await stage(v, item, i);
            } catch (e) {
              onLog?.(`  ! pipeline item ${i} dropped: ${e?.message ?? e}`);
              return null;
            }
          }
          return v;
        }),
      ),
    );
  }

  function phase(title) {
    currentPhase = title;
    onPhase?.(title);
  }
  function log(message) {
    onLog?.(message);
  }

  const budget = {
    total: budgetTotal,
    spent: () => meterSpent(),
    remaining: () => (budgetTotal ? Math.max(0, budgetTotal - meterSpent()) : Infinity),
  };

  // Nested workflow, one level deep (matches the native cap). Accepts a
  // {scriptPath}, a path string, a saved-workflow name (registry), or {name}.
  async function workflow(ref, subArgs) {
    let scriptPath;
    if (ref && typeof ref === "object" && ref.scriptPath) {
      scriptPath = ref.scriptPath;
    } else {
      const name = typeof ref === "string" ? ref : ref?.name;
      if (!name) {
        throw new Error("workflow(): pass a {scriptPath}, a saved-workflow name, or {name}");
      }
      scriptPath = looksLikePath(name) ? name : resolveNamedWorkflow(name);
    }
    const { runWorkflowFile } = await import("./runWorkflow.js");
    return runWorkflowFile(scriptPath, {
      args: subArgs,
      budgetTotal,
      budgetMeter,
      defaults,
      defaultModel,
      pinnedModel,
      autoEffort,
      pinnedEffort,
      plan,
      onPhase,
      onLog,
      onAgentPlan,
      onEvent,
      journal,
      startSession,
      nested: true,
    });
  }

  // ── Sessionful workers (agent.start / agent.waitAny / session.*) ──────────────
  // Long-lived Codex workers the workflow can spawn, wait on, and steer with
  // follow-up turns on the SAME thread (see references/authoring.md → "Sessionful
  // workers" and examples/sessionful-workers.workflow.js). Live-only: a session is
  // NEVER served from the resume cache — its turns use a `sess:<id>#<turn>` journal
  // keyspace that agent() never generates, so a --resume run re-runs sessions live
  // (no fake thread resurrection).

  const TIMEOUT = Symbol("waitAny-timeout");
  const isRunningStatus = (s) => s === "starting" || s === "running";

  // The workflow-facing handle around a live CodexSessionDriver. Owns per-turn
  // concurrency-slot accounting, budget/cap gating, lifecycle events, journaling,
  // and the latest snapshot. Exposes ONLY safe methods to the script (no client).
  class LiveAgentSession {
    constructor({ id, driver, label, phase, reqModel, effort }) {
      this.id = id;
      this.label = label;
      this.phase = phase;
      this._driver = driver;
      this._reqModel = reqModel;
      this._effort = effort ?? null; // default effort for follow-up turns
      this._status = "starting";
      this._turnCount = 0;
      this._completion = null; // current turn's settle promise (-> snapshot)
      this._settled = true; // no active turn yet
      this._cancelRequested = false;
      this._snapshot = {
        id, label, phase, threadId: driver.threadId, turnId: null,
        status: "starting", result: null, text: null, error: null,
        model: reqModel, effort: this._effort, tokens: null, ms: null,
      };
    }

    get status() { return this._status; }
    get threadId() { return this._driver.threadId ?? null; }
    get currentTurnId() { return this._snapshot.turnId ?? null; }

    poll() { return { ...this._snapshot }; }

    _isRunning() { return isRunningStatus(this._status); }
    _isActionable() { return this._settled || this._status === "closed"; }
    // Resolves when the current turn settles (or immediately if none is active).
    _settledPromise() { return this._completion ?? Promise.resolve(this._snapshot); }

    // Begin one turn (the initial turn or a steer). The caller MUST have acquired a
    // concurrency slot; the turn's completion releases it exactly once. On a start
    // failure (turn could not be started) this throws and the caller releases.
    async _beginTurn(prompt, turnOpts, kind) {
      this._cancelRequested = false;
      const turnIndex = this._turnCount++;
      const sessKey = `sess:${this.id}#${turnIndex}`; // journal/event id (never a resume key)
      const effort = turnOpts.effort ?? this._effort ?? undefined;

      let begun;
      try {
        begun = await this._driver.beginTurn(prompt, {
          schema: turnOpts.schema,
          effort,
          timeoutMs: turnOpts.timeoutMs,
          onProgress: onProgress ? (text) => onProgress(this.label, text, sessKey) : undefined,
        });
      } catch (e) {
        this._turnCount--; // roll back so the session can be retried/steered
        throw e; // the caller (start/steer) releases the slot
      }

      this._status = "running";
      this._settled = false;
      this._snapshot = {
        id: this.id, label: this.label, phase: this.phase,
        threadId: this._driver.threadId, turnId: begun.turnId,
        status: "running", result: null, text: null, error: null,
        model: this._reqModel, effort: effort ?? null, tokens: null, ms: null,
      };
      onLog?.(`  ⟳ ${kind === "steer" ? "steer" : "agent.start"}: ${this.label}` +
        `${turnOpts.schema ? "  [schema]" : ""}${effort ? `  ⟪${effort}⟫` : ""}`);
      // Lifecycle 'start' (balanced by a terminal 'end' below, so liveState's
      // running/done counts stay correct even on cancel/fail). Extra session fields
      // are additive — existing viewers/summary ignore them.
      onEvent?.({
        type: "start", id: sessKey, label: this.label, phase: this.phase,
        effort: effort ?? null, model: this._reqModel,
        kind: "session", sessionId: this.id, turn: turnIndex,
      });

      // Settle in the background. IMPORTANT: do NOT return this promise — _beginTurn
      // must resolve once the turn has STARTED (so agent.start/steer return promptly);
      // the completion is stored on this._completion for wait()/waitAny()/cancel().
      this._completion = (async () => {
        let outcome;
        try {
          outcome = await begun.completion;
        } catch (e) {
          outcome = { status: "failed", error: String(e?.message ?? e), turnId: begun.turnId };
        }
        try {
          return await this._settleTurn(outcome, { sessKey, turnIndex, effort });
        } finally {
          release(); // free the slot held for THIS turn (exactly once)
        }
      })();
    }

    // Fold a turn outcome into the snapshot, emit the terminal event, and journal it
    // (observability only). Never throws, so the completion promise never rejects.
    async _settleTurn(outcome, { sessKey, turnIndex, effort }) {
      this._settled = true;
      const snapStatus =
        outcome.status === "completed" ? "completed" :
        outcome.status === "interrupted" ? (this._cancelRequested ? "cancelled" : "interrupted") :
        "failed";
      this._status = snapStatus;
      this._snapshot = {
        id: this.id, label: this.label, phase: this.phase,
        threadId: this._driver.threadId, turnId: outcome.turnId ?? this._snapshot.turnId,
        status: snapStatus, result: outcome.result ?? null, text: outcome.text ?? null,
        error: outcome.error ?? null, model: outcome.model ?? this._reqModel,
        effort: effort ?? null, tokens: outcome.tokens ?? null, ms: outcome.ms ?? null,
      };
      try {
        onEvent?.({
          type: "end", id: sessKey, label: this.label, phase: this.phase,
          effort: effort ?? null, model: this._snapshot.model,
          tokens: this._snapshot.tokens, ms: this._snapshot.ms,
          status: snapStatus, kind: "session", sessionId: this.id, turn: turnIndex,
        });
      } catch {}
      if (journal) {
        try {
          await journal.record(sessKey, this.label, this._snapshot.result ?? this._snapshot.text ?? null, {
            phase: this.phase, effort: effort ?? null, model: this._snapshot.model,
            tokens: this._snapshot.tokens, ms: this._snapshot.ms,
            session: true, turn: turnIndex, status: snapStatus,
          });
        } catch {}
      }
      return { ...this._snapshot };
    }

    async wait({ timeoutMs } = {}) {
      if (this._settled || !this._completion) return { ...this._snapshot };
      if (timeoutMs == null) {
        await this._completion.catch(() => {});
        return { ...this._snapshot };
      }
      let timer;
      const timeoutP = new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), timeoutMs); });
      const r = await Promise.race([this._completion.then(() => null, () => null), timeoutP]);
      clearTimeout(timer);
      if (r === TIMEOUT) return { ...this._snapshot, status: "timed_out" }; // turn keeps running
      return { ...this._snapshot };
    }

    async steer(message, opts = {}) {
      if (this._status === "closed") throw new Error(`Cannot steer closed session ${this.label}.`);
      if (!this._settled && this._completion) {
        throw new Error(`Cannot steer session ${this.label} while a turn is already running. Call wait(), waitAny(), or cancel() first.`);
      }
      bumpAgentCount();
      checkBudget();
      await acquire();
      try {
        await this._beginTurn(message, { schema: opts.schema, effort: opts.effort, timeoutMs: opts.timeoutMs }, "steer");
      } catch (e) {
        release();
        throw e;
      }
      if (opts.wait === false) return { ...this._snapshot }; // running snapshot
      await this._completion.catch(() => {});
      return { ...this._snapshot };
    }

    async cancel() {
      if (this._status === "closed") return { ...this._snapshot };
      if (this._settled || !this._completion) return { ...this._snapshot };
      this._cancelRequested = true;
      await this._driver.interruptCurrent();
      await this._completion.catch(() => {}); // resolves interrupted -> mapped to cancelled
      return { ...this._snapshot };
    }

    async close() {
      if (this._status === "closed") { openSessions.delete(this); return; }
      if (!this._settled && this._completion) { try { await this.cancel(); } catch {} }
      try { await this._driver.cleanup(); } catch {}
      this._status = "closed";
      this._snapshot = { ...this._snapshot, status: "closed" };
      openSessions.delete(this);
    }
  }

  async function startLiveSession(prompt, opts = {}) {
    const merged = { ...defaults, ...opts };
    const label = opts.label || (typeof prompt === "string" ? prompt.slice(0, 64) : "session");
    const phase = opts.phase ?? currentPhase ?? null;
    const width = currentLayerWidth();
    const { effort } = resolveEffort(opts, width);
    const reqModel = pinnedModel ?? opts.model ?? defaultModel ?? null;
    const id = `s${++sessionSeq}`;

    // Each turn is one unit of model work: count it and gate on budget, then hold a
    // concurrency slot for the WHOLE turn (a detached running turn occupies the cap).
    bumpAgentCount();
    checkBudget();
    await acquire();

    let driver;
    try {
      driver = await startSession({ ...merged, defaultModel, pinnedModel, log: onLog });
    } catch (e) {
      release();
      throw e;
    }

    const session = new LiveAgentSession({ id, driver, label, phase, reqModel, effort });
    openSessions.add(session);
    try {
      await session._beginTurn(prompt, { schema: opts.schema, effort, timeoutMs: opts.timeoutMs }, "start");
    } catch (e) {
      release(); // first turn never started — free the slot
      try { await driver.cleanup(); } catch {}
      openSessions.delete(session);
      throw e;
    }
    return session; // returns with the first turn RUNNING (not awaited)
  }

  async function waitAnyLive(sessionList, { timeoutMs } = {}) {
    const list = (Array.isArray(sessionList) ? sessionList : []).filter(Boolean);
    if (!list.length) return { session: null, index: null, snapshot: null, pendingSessions: [], timedOut: false };

    const pendingOf = (winner) => list.filter((s) => s !== winner && s._isRunning());

    // Already actionable? Return the lowest-index one immediately (deterministic).
    for (let i = 0; i < list.length; i++) {
      if (list[i]._isActionable()) {
        return { session: list[i], index: i, snapshot: list[i].poll(), pendingSessions: pendingOf(list[i]), timedOut: false };
      }
    }
    // Otherwise race the running sessions' settle promises (+ optional timeout).
    const racers = list.map((s, i) => s._settledPromise().then(() => ({ i })));
    let timer;
    const timeoutP = timeoutMs != null ? new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), timeoutMs); }) : null;
    const r = await Promise.race(timeoutP ? [...racers, timeoutP] : racers);
    if (timer) clearTimeout(timer);
    if (r === TIMEOUT) {
      return { session: null, index: null, snapshot: null, pendingSessions: list.filter((s) => s._isRunning()), timedOut: true };
    }
    const winner = list[r.i];
    return { session: winner, index: r.i, snapshot: winner.poll(), pendingSessions: pendingOf(winner), timedOut: false };
  }

  // ── Plan mode (--plan): no Codex. Sessions become deterministic skeletons so the
  // orchestration runs; every start/steer is COUNTED via onAgentPlan so the budget
  // estimate isn't misleading.
  class PlannedAgentSession {
    constructor({ id, label, phase, reqModel, effort, schema }) {
      this.id = id;
      this.label = label;
      this.phase = phase;
      this._reqModel = reqModel;
      this._effort = effort ?? null;
      this._schema = schema;
      this._status = "completed";
      this._turnCount = 1;
      this._snapshot = this._snap(schema, "completed", `plan-${id}-t0`);
    }
    _snap(schema, status, turnId) {
      return {
        id: this.id, label: this.label, phase: this.phase,
        threadId: `plan-${this.id}`, turnId,
        status, result: schema ? schemaSkeleton(schema) : "", text: "", error: null,
        model: this._reqModel, effort: this._effort, tokens: null, ms: null,
      };
    }
    get status() { return this._status; }
    get threadId() { return `plan-${this.id}`; }
    get currentTurnId() { return this._snapshot.turnId; }
    poll() { return { ...this._snapshot }; }
    async wait() { return { ...this._snapshot }; }
    async steer(message, opts = {}) {
      bumpAgentCount();
      const turnIndex = this._turnCount++;
      onAgentPlan?.({ label: this.label, phase: this.phase, effort: (opts.effort ?? this._effort) ?? null, width: 1, schema: !!opts.schema, kind: "steer" });
      this._snapshot = this._snap(opts.schema ?? this._schema, "completed", `plan-${this.id}-t${turnIndex}`);
      return { ...this._snapshot };
    }
    async cancel() { this._status = "cancelled"; this._snapshot = { ...this._snapshot, status: "cancelled" }; return { ...this._snapshot }; }
    async close() { this._status = "closed"; this._snapshot = { ...this._snapshot, status: "closed" }; }
  }

  async function startPlannedSession(prompt, opts = {}) {
    const label = opts.label || (typeof prompt === "string" ? prompt.slice(0, 64) : "session");
    const phase = opts.phase ?? currentPhase ?? null;
    const width = currentLayerWidth();
    const { effort } = resolveEffort(opts, width);
    const reqModel = pinnedModel ?? opts.model ?? defaultModel ?? null;
    const id = `s${++sessionSeq}`;
    bumpAgentCount();
    onAgentPlan?.({ label, phase, effort: effort ?? null, width, schema: !!opts.schema, kind: "session-start" });
    return new PlannedAgentSession({ id, label, phase, reqModel, effort, schema: opts.schema });
  }

  async function waitAnyPlanned(sessionList) {
    const list = (Array.isArray(sessionList) ? sessionList : []).filter(Boolean);
    const open = list.filter((s) => s.status !== "closed");
    if (!open.length) return { session: null, index: null, snapshot: null, pendingSessions: [], timedOut: false };
    const winner = open[0];
    return { session: winner, index: list.indexOf(winner), snapshot: winner.poll(), pendingSessions: open.slice(1), timedOut: false };
  }

  // Close any sessions the workflow left open (cancels their active turn + cleans
  // worktrees). Called by runWorkflowSource in a finally — NEVER exposed to the script.
  async function finalize() {
    for (const s of [...openSessions]) {
      try { await s.close(); } catch {}
    }
  }

  // Sessionful control hangs off agent (NOT new top-level globals), per the spec.
  agent.start = (prompt, opts) => (plan ? startPlannedSession(prompt, opts) : startLiveSession(prompt, opts));
  agent.waitAny = (sessions, opts) => (plan ? waitAnyPlanned(sessions, opts) : waitAnyLive(sessions, opts));

  return { agent, parallel, pipeline, phase, log, budget, args, workflow, CAP, finalize };
}
