// Token accounting, fed by `thread/tokenUsage/updated` notifications.
//
// The notification carries `tokenUsage.total`, a per-thread *cumulative*
// TokenUsageBreakdown. We keep the latest breakdown per thread, which backs two
// things: the workflow `budget.spent()` global (summed across threads), and
// per-agent attribution for the run journal / viewer (`tokensForThread`).

const perThread = new Map(); // threadId -> { input, output, reasoning, total }

// Normalize a TokenUsageBreakdown into a flat {input, output, reasoning, total}.
function normalize(b) {
  if (!b || typeof b !== "object") return null;
  const input = b.inputTokens || 0;
  const output = b.outputTokens || 0;
  const reasoning = b.reasoningOutputTokens || 0;
  const total = typeof b.totalTokens === "number" ? b.totalTokens : input + output + reasoning;
  return { input, output, reasoning, total };
}

export function recordTokenUsage(params) {
  const threadId = params?.threadId;
  const n = normalize(params?.tokenUsage?.total);
  if (!threadId || !n) return;
  perThread.set(threadId, n);
}

// Total tokens across all threads (input + output + reasoning) — the default
// budget meter and the conservative cost bound.
export function tokensSpent() {
  let sum = 0;
  for (const v of perThread.values()) sum += v.total;
  return sum;
}

// Output-only tokens (generated + reasoning) across all threads — matches the
// native runtime's output-token budget pool (`--budget-meter output`).
export function outputSpent() {
  let sum = 0;
  for (const v of perThread.values()) sum += v.output + v.reasoning;
  return sum;
}

// Per-agent attribution: the cumulative breakdown for one thread (one agent()
// call), or null if no usage was reported for it.
export function tokensForThread(threadId) {
  return perThread.get(threadId) ?? null;
}

export function resetMeter() {
  perThread.clear();
}
