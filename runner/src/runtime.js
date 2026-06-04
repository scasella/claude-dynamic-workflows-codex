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
} = {}) {
  let agentCount = 0;
  let currentPhase = null; // last phase() title; the fallback when opts.phase is unset
  const AGENT_CAP = 1000;
  const meterSpent = () => (budgetMeter === "output" ? outputSpent() : tokensSpent());

  async function agent(prompt, opts = {}) {
    if (++agentCount > AGENT_CAP) {
      throw new Error(`Agent cap (${AGENT_CAP}) exceeded — runaway workflow?`);
    }
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
    let effortSrc;
    if (pinnedEffort != null) { merged.effort = pinnedEffort; effortSrc = "pin"; }
    else if (opts.effort != null) { merged.effort = opts.effort; effortSrc = "call"; }
    else if (autoEffort) { merged.effort = effortForLayerWidth(width); effortSrc = "auto"; }
    else if (defaults.effort != null) { merged.effort = defaults.effort; effortSrc = "flag"; }
    else { delete merged.effort; effortSrc = "default"; }

    // --plan dry run: record the would-be agent and return a schema skeleton so
    // the orchestration keeps running. No model call, no budget, no journal.
    if (plan) {
      onAgentPlan?.({ label, phase: effectivePhase, effort: merged.effort ?? null, width, schema: !!opts.schema });
      return schemaSkeleton(opts.schema);
    }

    if (budgetTotal && meterSpent() >= budgetTotal) {
      const err = new Error(`Token budget exhausted (${meterSpent()}/${budgetTotal} ${budgetMeter} tokens)`);
      err.code = "BUDGET_EXCEEDED";
      throw err;
    }

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
      onEvent?.({ type: "cached", label, phase: effectivePhase });
      return journal.get(key);
    }

    const reqModel = pinnedModel ?? opts.model ?? defaultModel ?? null;
    const effortTag = merged.effort
      ? `  ⟪${merged.effort}${effortSrc === "auto" ? `·layer×${width}` : ""}⟫`
      : "";
    onLog?.(`  · agent: ${label}${opts.schema ? "  [schema]" : ""}${effortTag}`);
    // Emit a lifecycle 'start' so live viewers can show this agent as running.
    onEvent?.({ type: "start", label, phase: effectivePhase, effort: merged.effort ?? null, model: reqModel });
    // Capture per-agent metrics off a side channel (the model-facing return value
    // is unchanged); fold them into the journal entry alongside phase/effort/model.
    let metrics = null;
    const result = await pooled(() =>
      runAgent(prompt, {
        ...merged, defaultModel, pinnedModel, log: onLog,
        onMetrics: (m) => { metrics = m; },
        onProgress: onProgress ? (text) => onProgress(label, text) : undefined,
      }),
    );
    onEvent?.({
      type: "end", label, phase: effectivePhase, effort: merged.effort ?? null,
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
      nested: true,
    });
  }

  return { agent, parallel, pipeline, phase, log, budget, args, workflow, CAP };
}
