// Robustness test for the run viewer: generates synthetic codex-workflows runs
// covering the shapes a real run can take, builds a viewer for each, and smoke-
// renders it (map + tree + both themes + a drawer) in a fake DOM. No tokens, no
// browser. Exits non-zero if any shape fails to render.
//
//   node test/view-run.test.js

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const VIEW = new URL("../bin/view-run.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-viewtest-"));

// ---- fake DOM ----
function makeEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, _kids: [], style: {}, className: "", scrollWidth: 0, scrollHeight: 0,
    setAttribute() {}, setAttributeNS() {}, addEventListener() {},
    classList: { contains: () => false, add() {}, remove() {} },
    append(...ks) { for (const k of ks) if (k != null) this._kids.push(k); },
    appendChild(k) { this._kids.push(k); return k; }, insertBefore(k) { this._kids.push(k); return k; },
    querySelector() { return null; }, cloneNode() { return makeEl(tag); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    remove() {},
  };
  Object.defineProperty(el, "textContent", { get() { return ""; }, set() { el._kids = []; } });
  return el;
}
function smoke(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const m = html.match(/<script id="run-data"[^>]*>([\s\S]*?)<\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) return { ok: false, err: "could not extract embedded data/app" };
  const DATA = m[1], APP = m[2];
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.window = { addEventListener() {} };
  globalThis.document = {
    body: makeEl("body"), createElement: (t) => makeEl(t), createElementNS: (n, t) => makeEl(t),
    createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
    getElementById: (id) => (id === "run-data" ? { textContent: DATA } : makeEl("div")),
    querySelector: () => null,
  };
  // Exercise both views, both themes, and a drawer (drill-down) on the last agent.
  const exercise = `
    ;view='tree';render();view='map';theme='light';render();theme='dark';render();
    if(RUN.agents&&RUN.agents.length){openDrawer(RUN.agents[RUN.agents.length-1].label);closeDrawer();}
    globalThis.__OUT={phases:RUN.phases.length,agents:RUN.agents.length};`;
  try {
    new Function(APP + exercise)();
    return { ok: true, info: globalThis.__OUT };
  } catch (e) {
    return { ok: false, err: (e && e.stack) || String(e) };
  }
}

const J = (o) => JSON.stringify(o);
const cases = [
  { name: "flat-strings", lines: [
    J({ key: "a#0", label: "Summarize the architecture", result: "Single-file server + dashboard." }),
    J({ key: "b#0", label: "List the risks", result: "No tests; no auth." }),
    J({ key: "c#0", label: "Propose next steps", result: "Add auth, tests, CI." }) ] },
  { name: "large-fan", lines: Array.from({ length: 40 }, (_, i) =>
    J({ key: "f" + i + "#0", label: "finder:bug-" + i, result: { issue: "#" + i, severity: ["high", "medium", "low"][i % 3] } })) },
  { name: "pipeline-labels", lines: ["a.ts", "b.ts", "c.ts"].flatMap((f) => [
    J({ key: "s_" + f + "#0", label: "scan:" + f, result: { findings: [{ title: "x", severity: "low" }] } }),
    J({ key: "v_" + f + "#0", label: "verify:" + f, result: { real: true, reason: "ok" } }) ]) },
  { name: "single", lines: [J({ key: "s#0", label: "decide",
    result: { recommended_direction: "Ship it", why_this_wins: "simplest", hero: { headline: "go" } } })] },
  { name: "mixed-results", lines: [
    J({ key: "m1#0", label: "audit:obj", result: { verdict: "ok", problems: [{ issue: "a", severity: "high" }] } }),
    J({ key: "m2#0", label: "audit:str", result: "a plain string result" }),
    J({ key: "m3#0", label: "audit:nul", result: null }) ] },
  { name: "empty", lines: [] },
  { name: "scripted-pipeline", lines: ["x.ts", "y.ts"].flatMap((f) => [
    J({ key: "s_" + f + "#0", label: "scan:" + f, result: { findings: [] } }),
    J({ key: "v_" + f + "#0", label: "verify:" + f, result: { real: false, reason: "clean" } }) ]),
    script:
      "export const meta={name:'mini-review',description:'scan then verify',phases:[{title:'Scan'},{title:'Verify'}]}\n" +
      "phase('Scan')\n" +
      "const r=await pipeline(args.files,(f)=>agent('scan '+f,{label:`scan:${f}`,phase:'Scan',model:'gpt-5.5',effort:'high'}),\n" +
      "  (res,f)=>agent('verify '+f,{label:`verify:${f}`,phase:'Verify',model:'gpt-5.4',effort:'low'}))\nreturn r" },
];

let failed = 0;
for (const c of cases) {
  const dir = join(ROOT, c.name), jdir = join(dir, ".workflow-journal");
  mkdirSync(jdir, { recursive: true });
  writeFileSync(join(jdir, c.name + ".workflow.jsonl"), c.lines.join("\n"));
  if (c.script) writeFileSync(join(dir, c.name + ".workflow.js"), c.script);
  const out = join(ROOT, c.name + ".html");
  let r;
  try {
    execFileSync("node", [VIEW, dir, "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
    r = smoke(out);
  } catch (e) {
    r = { ok: false, err: "generate failed: " + ((e.stderr && e.stderr.toString()) || e.message) };
  }
  if (r.ok) {
    console.log(`  ✓ ${c.name.padEnd(18)} phases=${r.info.phases} agents=${r.info.agents}`);
  } else {
    failed++;
    console.error(`  ✗ ${c.name}: ${String(r.err).slice(0, 300)}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });
if (failed) { console.error(`\nview-run robustness: ${failed} shape(s) FAILED`); process.exit(1); }
console.log("\nview-run robustness: all shapes render ✓");
