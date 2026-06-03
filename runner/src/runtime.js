// Provider-neutral re-implementation of the dynamic-workflow globals
// (agent / parallel / pipeline / phase / log / budget / args / workflow).
//
// Nothing here mentions Claude or Codex: this is the scheduling glue that the
// Workflow tool description specifies. Only agent() reaches a model, via the
// codexAgent seam. Concurrency is capped exactly like the native runtime:
// min(16, cores-2), with a hard 1000-agent backstop.

import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { codexAgent } from "./codexAgent.js";
import { tokensSpent } from "./meter.js";

const CAP = Math.min(16, Math.max(1, (os.cpus()?.length ?? 4) - 2));

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

export function createRuntime({
  args,
  budgetTotal = null,
  defaults = {},
  defaultModel,
  pinnedModel,
  autoEffort = false,
  pinnedEffort = null,
  onPhase,
  onLog,
  journal = null,
  runAgent = codexAgent, // seam: injected in tests to capture resolved opts
} = {}) {
  let agentCount = 0;
  const AGENT_CAP = 1000;

  async function agent(prompt, opts = {}) {
    if (budgetTotal && tokensSpent() >= budgetTotal) {
      throw new Error(`Token budget exhausted (${tokensSpent()}/${budgetTotal})`);
    }
    if (++agentCount > AGENT_CAP) {
      throw new Error(`Agent cap (${AGENT_CAP}) exceeded — runaway workflow?`);
    }
    const merged = { ...defaults, ...opts };
    const label =
      opts.label || (typeof prompt === "string" ? prompt.slice(0, 64) : "agent");

    // Resolve thinking effort. Precedence (highest first):
    //   pinnedEffort (--pin-effort)        authoritative, like --pin-model
    //   per-call opts.effort               the author's deliberate choice
    //   layer-width policy (--auto-effort)  1->xhigh, >=2->high (floor)
    //   defaults.effort (--effort)         flat fallback
    //   undefined                          Codex config default (effort omitted)
    // The effective effort is written back onto `merged`, so it both reaches the
    // agent and participates in the journal identity (a policy change busts cache).
    const width = currentLayerWidth();
    let effortSrc;
    if (pinnedEffort != null) { merged.effort = pinnedEffort; effortSrc = "pin"; }
    else if (opts.effort != null) { merged.effort = opts.effort; effortSrc = "call"; }
    else if (autoEffort) { merged.effort = effortForLayerWidth(width); effortSrc = "auto"; }
    else if (defaults.effort != null) { merged.effort = defaults.effort; effortSrc = "flag"; }
    else { delete merged.effort; effortSrc = "default"; }

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
      return journal.get(key);
    }

    const effortTag = merged.effort
      ? `  ⟪${merged.effort}${effortSrc === "auto" ? `·layer×${width}` : ""}⟫`
      : "";
    onLog?.(`  · agent: ${label}${opts.schema ? "  [schema]" : ""}${effortTag}`);
    const result = await pooled(() =>
      runAgent(prompt, { ...merged, defaultModel, pinnedModel, log: onLog }),
    );
    if (key) await journal.record(key, label, result);
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
    onPhase?.(title);
  }
  function log(message) {
    onLog?.(message);
  }

  const budget = {
    total: budgetTotal,
    spent: () => tokensSpent(),
    remaining: () => (budgetTotal ? Math.max(0, budgetTotal - tokensSpent()) : Infinity),
  };

  // Nested workflow: {scriptPath} form, one level deep (matches the native cap).
  async function workflow(ref, subArgs) {
    const scriptPath = typeof ref === "string" ? ref : ref?.scriptPath;
    if (!scriptPath) {
      throw new Error("workflow(): only the {scriptPath} form is supported in this runner");
    }
    const { runWorkflowFile } = await import("./runWorkflow.js");
    return runWorkflowFile(scriptPath, {
      args: subArgs,
      budgetTotal,
      defaults,
      defaultModel,
      pinnedModel,
      autoEffort,
      pinnedEffort,
      onPhase,
      onLog,
      journal,
      nested: true,
    });
  }

  return { agent, parallel, pipeline, phase, log, budget, args, workflow, CAP };
}
