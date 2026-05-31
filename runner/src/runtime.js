// Provider-neutral re-implementation of the dynamic-workflow globals
// (agent / parallel / pipeline / phase / log / budget / args / workflow).
//
// Nothing here mentions Claude or Codex: this is the scheduling glue that the
// Workflow tool description specifies. Only agent() reaches a model, via the
// codexAgent seam. Concurrency is capped exactly like the native runtime:
// min(16, cores-2), with a hard 1000-agent backstop.

import os from "node:os";
import { codexAgent } from "./codexAgent.js";
import { tokensSpent } from "./meter.js";

const CAP = Math.min(16, Math.max(1, (os.cpus()?.length ?? 4) - 2));

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
  onPhase,
  onLog,
  journal = null,
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

    // Resume journal: allocate a stable key (called on every run, even a cache
    // miss, to keep occurrence counters aligned) and short-circuit on a hit.
    // Identity includes the *effective* model (pinned, else script opt, else CLI
    // default) so a model change busts the cache; --fresh forces a full re-run.
    const key = journal
      ? journal.nextKey(prompt, { ...merged, model: pinnedModel ?? opts.model ?? defaultModel })
      : null;
    if (key && journal.hit(key)) {
      onLog?.(`  ◦ agent (cached): ${label}`);
      return journal.get(key);
    }

    onLog?.(`  · agent: ${label}${opts.schema ? "  [schema]" : ""}`);
    const result = await pooled(() =>
      codexAgent(prompt, { ...merged, defaultModel, pinnedModel, log: onLog }),
    );
    if (key) await journal.record(key, label, result);
    return result;
  }

  // BARRIER fan-out. A thunk that throws (or whose agent errors) resolves to null.
  async function parallel(thunks) {
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(t)
          .catch((e) => {
            onLog?.(`  ! parallel task failed: ${e?.message ?? e}`);
            return null;
          }),
      ),
    );
  }

  // Per-item staging with NO barrier between stages. A stage that throws drops
  // that item to null and skips its remaining stages.
  async function pipeline(items, ...stages) {
    return Promise.all(
      items.map(async (item, i) => {
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
      onPhase,
      onLog,
      journal,
      nested: true,
    });
  }

  return { agent, parallel, pipeline, phase, log, budget, args, workflow, CAP };
}
