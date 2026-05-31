// Map a model id requested by a workflow (often a Claude id, or a bare
// opus/sonnet/haiku alias from a Claude-authored script or an agentType
// definition) onto a model the local Codex app-server actually exposes.

export function modelId(m) {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.id ?? m.slug ?? m.model ?? m.name ?? null;
  return null;
}

// Claude tier -> ordered Codex preferences (first available wins).
const FAMILY_PREFERENCES = {
  opus: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2"],
  sonnet: ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex", "gpt-5.4-mini"],
  haiku: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.2"],
};

// Matches Claude full ids ("claude-opus-4-8") and bare aliases ("opus").
function claudeFamily(id) {
  const s = String(id).toLowerCase();
  if (/opus/.test(s)) return "opus";
  if (/sonnet/.test(s)) return "sonnet";
  if (/haiku/.test(s)) return "haiku";
  return null;
}

/**
 * Resolve `requested` to a Codex model id (or undefined to use Codex's config
 * default).
 *   undefined / "inherit" / "default" -> undefined
 *   Claude id or alias                -> mapped family preference (best available)
 *   already-available id              -> as-is
 *   unknown but unavailable           -> undefined (config default) + warn
 * If `available` is empty (model/list unavailable), Claude ids still map to their
 * top preference and other ids pass through unchanged.
 */
export function resolveModel(requested, available = [], log = () => {}) {
  if (!requested || /^(inherit|default)$/i.test(requested)) return undefined;

  const family = claudeFamily(requested);
  if (family) {
    const prefs = FAMILY_PREFERENCES[family] || [];
    const pick = available.length
      ? (prefs.find((m) => available.includes(m)) ??
         available.find((m) => !/mini|spark/.test(m)) ??
         available[0])
      : prefs[0];
    if (pick) {
      log(`model: '${requested}' (Claude) → '${pick}'`);
      return pick;
    }
    return undefined;
  }

  if (!available.length) return requested; // non-Claude id, can't validate — trust it
  if (available.includes(requested)) return requested;

  log(`model: '${requested}' not exposed by Codex → using config default (have: ${available.join(", ")})`);
  return undefined;
}

// Pick the latest frontier model from a `model/list` result: the newest,
// strongest general model. Excludes -mini/-spark variants and hidden models;
// ranks by version number parsed from the id (5.5 > 5.4 > 5.3-codex > 5.2),
// breaking ties toward the flagged default and the shorter (base) id.
export function pickFrontier(models = []) {
  const id = (m) => (typeof m === "string" ? m : m?.id ?? m?.model ?? m?.slug ?? m?.name);
  const ver = (s) => {
    const mt = String(s).match(/(\d+(?:\.\d+)?)/);
    return mt ? parseFloat(mt[1]) : -1;
  };
  const eligible = models
    .map((m) => ({
      id: id(m),
      isDefault: typeof m === "object" && !!m?.isDefault,
      hidden: typeof m === "object" && !!m?.hidden,
    }))
    .filter((m) => m.id && !m.hidden && !/(mini|spark)/i.test(m.id));
  if (!eligible.length) return undefined;
  eligible.sort(
    (a, b) =>
      ver(b.id) - ver(a.id) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.id.length - b.id.length,
  );
  return eligible[0].id;
}
