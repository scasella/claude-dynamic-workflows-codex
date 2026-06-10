// Loads a Claude Code dynamic-workflow script verbatim and runs it with the
// Codex-backed globals injected — inside an isolated `node:vm` context.
//
// The native runtime guarantees "no direct filesystem or shell access from the
// workflow itself": the script only coordinates agents; the agents do the I/O.
// We honour that by running the body in a context whose global holds ONLY the
// injected workflow globals plus standard JS intrinsics (Object/Array/JSON/Math/
// Promise/Map/…). There is no `process`, `fetch`, `require`, dynamic `import()`,
// `fs`, or timers reachable from the script. We also block the non-deterministic
// builtins the native runtime forbids (Math.random / Date.now / argless new Date),
// since they would desync the resume journal.
//
// The body uses top-level `await` and `return`, so we host it inside an async
// IIFE compiled with vm.Script; the context shares the host event loop, so the
// returned promise is awaitable here and the injected (host) agent()/parallel()
// functions work normally across the boundary.

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRuntime } from "./runtime.js";

// Extract the `meta` literal (required to be a pure literal at the top) for
// display. Anchored to line-start so a comment mentioning `export const meta`
// can't shadow the real declaration.
export function extractMeta(src) {
  const m = src.match(/^[ \t]*export[ \t]+const[ \t]+meta[ \t]*=[ \t]*/m);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return new Function("return (" + src.slice(open, end + 1) + ")")();
  } catch {
    return null;
  }
}

export async function runWorkflowFile(scriptPath, options = {}) {
  const src = await readFile(scriptPath, "utf8");
  return runWorkflowSource(src, options);
}

export async function runWorkflowSource(src, options = {}) {
  const meta = extractMeta(src);
  const runtime = createRuntime(options);

  if (!options.nested && meta?.name) {
    runtime.log?.(`▶ ${meta.name}${meta.description ? " — " + meta.description : ""}`);
  }

  // Keep `meta` as a local; drop the `export` so the body can be hosted.
  const body = src.replace(/^([ \t]*)export[ \t]+const[ \t]+meta\b/m, "$1const meta");

  // The isolated global: only the injected workflow API. JS intrinsics are
  // provided automatically by vm.createContext; Node host globals are not.
  const sandbox = {
    agent: runtime.agent,
    parallel: runtime.parallel,
    pipeline: runtime.pipeline,
    phase: runtime.phase,
    log: runtime.log,
    args: runtime.args,
    budget: runtime.budget,
    workflow: runtime.workflow,
    human: runtime.human,
    console: safeConsole(runtime.log),
  };
  const context = vm.createContext(sandbox, {
    name: "workflow",
    codeGeneration: { strings: false, wasm: false }, // no eval/Function/wasm escape
  });
  installDeterminismGuards(context);

  // Wrap so top-level await + return work; result is a host-awaitable promise.
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow.js" });
  try {
    return await script.runInContext(context);
  } finally {
    // Close any sessionful workers the script left open — cancels their active turn
    // and removes any worktrees — whether the workflow returned or threw.
    try { await runtime.finalize?.(); } catch {}
  }
}

// console inside the sandbox routes to the runner's log (stderr), so it can't
// corrupt the stdout result contract and can't reach process.stdout directly.
function safeConsole(log) {
  const fmt = (args) =>
    args.map((x) => (typeof x === "string" ? x : safeStringify(x))).join(" ");
  const w = (...args) => log(fmt(args));
  return { log: w, info: w, warn: w, error: w, debug: w };
}

function safeStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// Block the non-deterministic builtins the native runtime forbids. Installed via
// runInContext (a host API, not subject to the context's codeGeneration limits).
function installDeterminismGuards(context) {
  vm.runInContext(
    `(() => {
      const block = (name) => () => {
        throw new Error(name + " is disabled in workflows (non-deterministic; would break resume). Pass values in via args, or stamp time after the run.");
      };
      Math.random = block("Math.random()");
      Date.now = block("Date.now()");
      const RealDate = Date;
      globalThis.Date = new Proxy(RealDate, {
        construct(target, a) {
          if (a.length === 0) {
            throw new Error("new Date() with no args is disabled in workflows (non-deterministic). Pass an explicit timestamp.");
          }
          return Reflect.construct(target, a);
        },
        apply(target, thisArg, a) { return Reflect.apply(target, thisArg, a); },
      });
    })();`,
    context,
  );
}
