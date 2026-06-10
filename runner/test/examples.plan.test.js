// The docs promise every bundled workflow is `--plan`-safe ("dry-run any with
// --plan, no Codex, no tokens"). Enforce it: a no-arg plan-mode run of EVERY
// examples/**/*.workflow.js must exit 0. Catches a DSL break, a script that
// forgot to default its args, or a meta typo — for the whole template library,
// in one sweep. (Found by the --multi rehearsal's claims-sweep: the promise
// existed, the enforcement didn't.)
//
//   node test/examples.plan.test.js

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = join(ROOT, "runner", "bin", "run-workflow.js");

const scripts = readdirSync(join(ROOT, "examples"), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".workflow.js"))
  .map((f) => join("examples", f))
  .sort();

assert.ok(scripts.length >= 15, `expected the full template library, found ${scripts.length}`);

const failures = [];
for (const script of scripts) {
  const r = spawnSync("node", [RUN, script, "--plan"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) failures.push(`${script}\n    ${(r.stderr || "").split("\n").find((l) => l.trim()) ?? "no stderr"}`);
}
assert.deepEqual(failures, [], `not --plan-safe:\n  ${failures.join("\n  ")}`);

console.log(`examples plan smoke: all ${scripts.length} bundled workflows are --plan-safe ✓`);
