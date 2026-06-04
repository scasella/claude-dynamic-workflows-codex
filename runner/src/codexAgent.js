// The seam. Each agent() unit of work runs as one Codex thread + turn over the
// local `codex app-server`, returning the agent's final message (or, with a
// schema, the parsed structured object).
//
// Tier-1 hardening for cross-project use:
//   • reconnecting singleton client (a dead app-server no longer kills the run)
//   • model resolution (Claude ids / aliases -> available Codex models, via model/list)
//   • agentType -> developerInstructions (the .claude/agents registry)
//   • retry-with-backoff on transient Codex / transport errors

import { setTimeout as sleep } from "node:timers/promises";
import { AppServerClient } from "./appServerClient.js";
import { recordTokenUsage, tokensForThread } from "./meter.js";
import { resolveModel, modelId } from "./modelMap.js";
import { loadAgentType } from "./agentTypes.js";

// Normalize an authored JSON Schema for OpenAI strict structured outputs, which
// require EVERY property to be listed in `required` and `additionalProperties:false`
// on every object (optional fields are expressed as nullable types instead).
// Authors routinely omit a key, which 400s the turn — so make a valid-looking
// schema acceptable, recursively. This only sets required/additionalProperties; it
// never changes a field's declared type.
export function strictifySchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(strictifySchema);
  const out = { ...s };
  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    const props = {};
    for (const k of Object.keys(out.properties)) props[k] = strictifySchema(out.properties[k]);
    out.properties = props;
    out.required = Object.keys(props); // strict mode: every property is required
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (out.items) out.items = strictifySchema(out.items);
  for (const kw of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(out[kw])) out[kw] = out[kw].map(strictifySchema);
  for (const kw of ["$defs", "definitions"]) {
    if (out[kw] && typeof out[kw] === "object") {
      const d = {};
      for (const k of Object.keys(out[kw])) d[k] = strictifySchema(out[kw][k]);
      out[kw] = d;
    }
  }
  return out;
}

let clientPromise; // lazily-connected, self-healing singleton
let availableModels = []; // ids exposed by model/list, refreshed on each connect

const SANDBOX_MAP = {
  "read-only": "read-only",
  readOnly: "read-only",
  "workspace-write": "workspace-write",
  workspaceWrite: "workspace-write",
  "danger-full-access": "danger-full-access",
  dangerFullAccess: "danger-full-access",
};

// Returns a connected client, reconnecting if the previous process died.
export async function getClient(options) {
  if (clientPromise) {
    const existing = await clientPromise.catch(() => null);
    if (existing && existing.readyState === "ready") return existing;
    clientPromise = undefined; // dead/failed — recreate below
  }
  const client = new AppServerClient(options ?? {});
  client.on("notification", (n) => {
    if (n.method === "thread/tokenUsage/updated") recordTokenUsage(n.params);
  });
  const p = client.connect().then(async () => {
    try {
      availableModels = (await client.listModels()).map(modelId).filter(Boolean);
    } catch {
      availableModels = [];
    }
    return client;
  });
  clientPromise = p;
  p.catch(() => {
    if (clientPromise === p) clientPromise = undefined;
  });
  return p;
}

export async function shutdownClient() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = undefined;
  availableModels = [];
  if (client) await client.shutdown();
}

/**
 * Run `prompt` as one Codex agent turn (with retry). See README for opts.
 * Returns string | parsed object (schema) | null (interrupted).
 */
export async function codexAgent(prompt, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};

  // agentType -> system prompt (+ optional model) from the .claude/agents registry.
  let systemPrompt = opts.systemPrompt;
  let agentTypeModel;
  if (opts.agentType) {
    const def = await loadAgentType(opts.agentType, opts.cwd ?? process.cwd());
    if (def) {
      if (!systemPrompt) systemPrompt = def.systemPrompt;
      agentTypeModel = def.model;
    } else {
      log(`agentType '${opts.agentType}' not found — using default instructions`);
    }
  }
  // `pinnedModel` is authoritative: it overrides a per-call `model`, an
  // agentType model, and the CLI default — forcing every agent onto one model.
  if (opts.pinnedModel && opts.model && opts.model !== opts.pinnedModel) {
    log(`pinned model '${opts.pinnedModel}' overrides per-call model '${opts.model}'`);
  }
  const requestedModel = opts.pinnedModel ?? opts.model ?? agentTypeModel ?? opts.defaultModel;

  // Worktree isolation is set up once and reused across retry attempts.
  let cwd = opts.cwd ?? process.cwd();
  let worktree;
  if (opts.isolation === "worktree") {
    const { isGitRepo, createWorktree } = await import("./worktree.js");
    if (await isGitRepo(cwd)) {
      worktree = await createWorktree(cwd);
      cwd = worktree.dir;
    } else {
      log(`isolation:'worktree' ignored — ${cwd} is not a git repo`);
    }
  }

  try {
    return await withRetry(() => runOneTurn(prompt, { ...opts, systemPrompt, requestedModel, cwd, log }), {
      retries: opts.retries ?? 3,
      log,
      label: opts.label,
    });
  } finally {
    if (worktree) {
      const r = await worktree.cleanup();
      if (!r.removed) log(`worktree kept (modified): ${r.dir}`);
    }
  }
}

async function runOneTurn(prompt, opts) {
  const { log } = opts;
  const startedAt = Date.now(); // host clock — the script's Date.now is blocked, this isn't
  const client = await getClient(opts.clientOptions); // live (reconnects if needed)
  const model = resolveModel(opts.requestedModel, availableModels, log);

  const threadParams = {
    approvalPolicy: "never",
    sandbox: SANDBOX_MAP[opts.sandbox] ?? "workspace-write",
    cwd: opts.cwd,
  };
  if (model) threadParams.model = model;
  if (opts.systemPrompt) threadParams.developerInstructions = opts.systemPrompt;
  if (opts.personality) threadParams.personality = opts.personality;

  const startThreadRes = await client.startThread(threadParams);
  const threadId = startThreadRes?.thread?.id;
  if (!threadId) throw new Error("thread/start did not return thread.id");

  const turnParams = { threadId, input: [{ type: "text", text: String(prompt) }] };
  if (model) turnParams.model = model;
  if (opts.effort) turnParams.effort = opts.effort;
  if (opts.schema) turnParams.outputSchema = strictifySchema(opts.schema);

  let finalText = "";
  const deltas = new Map();
  const onNote = (n) => {
    const p = n.params ?? {};
    if (p.threadId !== threadId) return;
    if (n.method === "item/agentMessage/delta" && typeof p.delta === "string") {
      deltas.set(p.itemId, (deltas.get(p.itemId) ?? "") + p.delta);
      // surface the partial output so a live viewer can show progress while the
      // agent is still writing. Best-effort — must never break the turn.
      if (opts.onProgress) { try { opts.onProgress([...deltas.values()].join("")); } catch {} }
    } else if (n.method === "item/completed" && p.item?.type === "agentMessage") {
      finalText = p.item.text ?? finalText;
    }
  };
  client.on("notification", onNote);

  try {
    const startTurnRes = await client.startTurn(turnParams);
    const turnId = startTurnRes?.turn?.id;

    const completed = await client.waitForNotification(
      (n) =>
        n.method === "turn/completed" &&
        n.params?.threadId === threadId &&
        (!turnId || n.params?.turn?.id === turnId),
      opts.timeoutMs ?? 600_000,
    );

    const turn = completed.params?.turn ?? {};
    if (turn.status === "interrupted") return null;
    if (turn.status && turn.status !== "completed") {
      const err = new Error(turn.error?.message ?? `turn ended with status=${turn.status}`);
      err.codexErrorInfo = turn.error?.codexErrorInfo;
      throw err;
    }

    // Per-agent attribution for the journal/viewer: wall time for this turn, the
    // tokens this thread consumed (cumulative, by completion), and the model the
    // turn actually ran on. Off the hot path — a side-channel callback, so the
    // value returned to the script is unchanged.
    opts.onMetrics?.({
      ms: Date.now() - startedAt,
      model: model ?? null,
      tokens: tokensForThread(threadId),
    });

    const text = finalText || (deltas.size ? [...deltas.values()].join("") : "");
    if (opts.schema) {
      try {
        return JSON.parse(text);
      } catch {
        return extractJson(text);
      }
    }
    return text;
  } finally {
    client.off("notification", onNote);
  }
}

// ---- retry classification ----

const RETRYABLE_CODES = new Set([
  "UsageLimitExceeded",
  "HttpConnectionFailed",
  "ResponseStreamConnectionFailed",
  "ResponseStreamDisconnected",
  "ResponseTooManyFailedAttempts",
  "InternalServerError",
]);
const RETRYABLE_MSG =
  /(Transport is not connected|app-server exited|timed out|ECONNRESET|EPIPE|socket hang up|stream (disconnected|connection))/i;
const NONRETRYABLE_MSG = /(BadRequest|Unauthorized|ContextWindowExceeded|invalid request|outputSchema|did not return)/i;

function errorCode(e) {
  const ci = e?.codexErrorInfo;
  if (!ci) return null;
  return typeof ci === "string" ? ci : Object.keys(ci)[0] ?? null;
}

export function isRetryable(e) {
  const code = errorCode(e);
  if (code) return RETRYABLE_CODES.has(code);
  const msg = String(e?.message ?? "");
  if (NONRETRYABLE_MSG.test(msg)) return false;
  return RETRYABLE_MSG.test(msg); // unknown errors are NOT retried (conservative)
}

async function withRetry(fn, { retries, log, label }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      attempt++;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const wait = backoff + Math.floor(Math.random() * 250);
      log(`  ⟳ retry ${attempt}/${retries} (${label ?? "agent"}): ${String(e?.message ?? e).slice(0, 140)} — waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

// Tolerate a model that wraps JSON in prose or ```json fences despite outputSchema.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}
