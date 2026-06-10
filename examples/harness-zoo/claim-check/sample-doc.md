# claude-dynamic-workflows-codex (sample document under review)

This is a small "before" document — the kind of README/blurb ClaimCheck is built to
audit. It makes several factual claims about *this* repository. Some hold up against
the actual artifacts; at least one deliberately does **not**, so a live run shows
ClaimCheck catching it.

- The project has **zero npm dependencies** — `package.json`'s `dependencies` block
  is empty.
- It targets **Node.js 18 or newer** (`engines.node` is `">=18"`).
- The flagship harness-zoo template is **GoalLint**, which hardens a vague agent
  `/goal` before you dispatch a fleet — it runs as **eleven agents** (1 Parse + 7
  Critique + 1 Rewrite + 1 Verify + 1 Report).
- Every workflow is written in **plain JavaScript** (not TypeScript) and hosted by
  the runner in an isolated context.
- The repo ships a `runner/test/` suite that you run with **`npm test`**.
- ClaimCheck and GoalLint together form a **"trust loop"**: harden the instruction
  before agents run; verify the claims after they write.
- The runner depends on the **`express`** package to serve the live viewer.

Of the above, the `express` claim is the planted falsehood: this project has **no**
runtime dependencies at all, so nothing — including the viewer — can depend on
`express`. A correct ClaimCheck run should mark that claim **contradicted** (or
**unsupported**) and suggest a safer rewrite, while marking the dependency-count and
Node-version claims **supported** with citations to `package.json`.
