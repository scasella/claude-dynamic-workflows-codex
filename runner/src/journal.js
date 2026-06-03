// Resume journal: persist each completed agent() result keyed by a stable hash
// of its identity (prompt + output-affecting opts) plus an occurrence index, so
// reruns can skip work that hasn't changed. This is the runner's analogue of the
// native `resumeFromRunId` cache: same script + same args => 100% cache hit;
// an edited prompt changes its hash and only that call (and same-prompt repeats
// after it) re-runs.

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

// Deterministic stringify (sorted keys) so hashing is stable across runs.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// Only the inputs that determine the model's output participate in identity.
// Cosmetic/environmental opts (label, cwd, isolation, timeoutMs, callbacks) do not.
const IDENTITY_KEYS = ["model", "effort", "sandbox", "systemPrompt", "personality", "schema"];

export function identityHash(prompt, opts = {}) {
  const identity = { prompt: String(prompt) };
  for (const k of IDENTITY_KEYS) if (opts[k] !== undefined) identity[k] = opts[k];
  return createHash("sha256").update(stableStringify(identity)).digest("hex").slice(0, 16);
}

export class Journal {
  #path;
  #reuse;
  #cache = new Map(); // key -> { key, label, result }
  #occ = new Map(); // baseHash -> next occurrence index

  constructor(path, { reuse = false } = {}) {
    this.#path = path;
    this.#reuse = reuse;
  }

  async load() {
    if (!this.#path) return;
    try {
      const text = await readFile(this.#path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e?.key) this.#cache.set(e.key, e);
        } catch {}
      }
    } catch {
      // No journal yet — first run.
    }
  }

  // Allocate the stable key for the next agent() call with this identity.
  // Must be called once per call, in deterministic order.
  nextKey(prompt, opts) {
    const base = identityHash(prompt, opts);
    const n = this.#occ.get(base) ?? 0;
    this.#occ.set(base, n + 1);
    return `${base}#${n}`;
  }

  hit(key) {
    return this.#reuse && this.#cache.has(key);
  }

  get(key) {
    return this.#cache.get(key)?.result;
  }

  // `meta` carries non-identity per-agent attribution (phase, effort, model,
  // tokens, ms) for the viewer. Only defined values are persisted, so old
  // journals and metric-less runs stay valid.
  async record(key, label, result, meta = {}) {
    const entry = { key, label, result };
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined && v !== null) entry[k] = v;
    }
    this.#cache.set(key, entry);
    if (!this.#path) return;
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, JSON.stringify(entry) + "\n");
  }
}
