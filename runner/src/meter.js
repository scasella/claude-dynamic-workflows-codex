// Best-effort token accounting, fed by `thread/tokenUsage/updated` notifications.
//
// The notification carries `tokenUsage.total`, a per-thread *cumulative*
// TokenUsageBreakdown. We therefore keep the latest total per thread and sum
// across threads to back the workflow `budget.spent()` global.

const perThreadTotal = new Map(); // threadId -> cumulative token count

function breakdownTokens(b) {
  if (!b || typeof b !== "object") return 0;
  if (typeof b.totalTokens === "number") return b.totalTokens;
  const input = b.inputTokens || 0;
  const output = b.outputTokens || 0;
  const reasoning = b.reasoningOutputTokens || 0;
  return input + output + reasoning;
}

export function recordTokenUsage(params) {
  const threadId = params?.threadId;
  const total = params?.tokenUsage?.total;
  if (!threadId || !total) return;
  perThreadTotal.set(threadId, breakdownTokens(total));
}

export function tokensSpent() {
  let sum = 0;
  for (const v of perThreadTotal.values()) sum += v;
  return sum;
}

export function resetMeter() {
  perThreadTotal.clear();
}
