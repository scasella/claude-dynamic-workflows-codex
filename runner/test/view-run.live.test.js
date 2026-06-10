// Live-mode test for the run viewer: exercises the NO-RELOAD live update channel
// that the shape-smoke test (view-run.test.js) can't, because it needs a DOM that
// reports data-live="1", a working sessionStorage, queryable [data-elapsed-start]
// nodes, script-injection, and tracked timers. Validates:
//   • LIVE is detected from <html data-live="1">; sync + tick loops arm
//   • the watcher writes gen.js / data.js sidecars (the update channel)
//   • window.__wfPush(gen, data) swaps RUN and reconciles IN PLACE (no reload)
//   • a result/final push settles the page (LIVE off, sync interval cleared)
//   • tickLive updates running-agent elapsed text in place
//   • if the sidecar scripts can't load, it falls back to a reload loop
//   • a finished render (data-live="0") arms no sync, no tick, no reload
//
//   node test/view-run.live.test.js

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

const VIEW = new URL("../bin/view-run.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-livetest-"));

// ---- attribute/text-aware fake DOM ----
let REGISTRY = [];
function makeEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, _kids: [], _attrs: {}, _text: "", style: {}, className: "",
    scrollWidth: 0, scrollHeight: 0, scrollTop: 0,
    setAttribute(k, v) { this._attrs[k] = String(v); }, getAttribute(k) { return this._attrs[k]; },
    setAttributeNS() {}, addEventListener() {}, removeEventListener() {}, focus() {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    append(...ks) { for (const k of ks) if (k != null) this._kids.push(k); },
    appendChild(k) { this._kids.push(k); return k; }, insertBefore(k) { this._kids.push(k); return k; },
    querySelector: () => null, cloneNode() { return makeEl(tag); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 800, height: 600 }; },
    remove() {},
  };
  Object.defineProperty(el, "textContent", { get() { return el._text; }, set(v) { el._text = String(v); el._kids = []; } });
  REGISTRY.push(el);
  return el;
}
const withAttr = (attr) => REGISTRY.filter((e) => e._attrs && e._attrs[attr] != null);

function makeEnv(DATA, live, breakInject) {
  REGISTRY = [];
  const store = new Map();
  const ids = {};
  const getId = (id) => (ids[id] = ids[id] || makeEl("div"));
  const intervalFns = new Map();
  let timerId = 0;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.__reloads = 0;
  globalThis.location = { pathname: "/run/x.run.html", reload() { globalThis.__reloads++; } };
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  };
  globalThis.setTimeout = (fn) => { return ++timerId; };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = (fn) => { const id = ++timerId; intervalFns.set(id, fn); return id; };
  globalThis.clearInterval = (id) => { intervalFns.delete(id); };
  const win = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = win;
  const documentElement = makeEl("html");
  documentElement._attrs.live = live ? "1" : "0";
  Object.defineProperty(documentElement, "dataset", { get() { return { live: documentElement._attrs.live }; } });
  const head = breakInject ? { appendChild() { throw new Error("blocked"); } } : makeEl("head");
  if (breakInject) documentElement.appendChild = () => { throw new Error("blocked"); };
  globalThis.document = {
    documentElement, head, body: makeEl("body"), visibilityState: "visible", activeElement: null,
    createElement: (t) => makeEl(t), createElementNS: (n, t) => makeEl(t),
    createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
    getElementById: (id) => (id === "run-data" ? { textContent: DATA } : getId(id)),
    querySelector: () => null,
    querySelectorAll: (sel) => { const m = sel.match(/^\[([^\]]+)\]$/); return m ? withAttr(m[1]) : []; },
  };
  return { store, win, intervalFns };
}

function extract(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const m = html.match(/<script id="run-data"[^>]*>([\s\S]*?)<\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error("could not extract embedded data/app");
  return { DATA: m[1], APP: m[2] };
}

// A run with one finished + two running agents (running come from the event sidecar).
const J = (o) => JSON.stringify(o);
const lines = [J({ key: "g1#0", label: "gather:a", result: { summary: "done" }, phase: "Gather", model: "gpt-5.5", effort: "high", tokens: 52000, ms: 86000 })];
const events = [
  J({ t: 1000, type: "start", label: "gather:a", phase: "Gather", model: "gpt-5.5", effort: "high" }),
  J({ t: 87000, type: "end", label: "gather:a", phase: "Gather" }),
  J({ t: 1000, type: "start", label: "gather:b", phase: "Gather", model: "gpt-5.5", effort: "high" }),
  J({ t: 1000, type: "start", label: "gather:c", phase: "Gather", model: "gpt-5.5", effort: "high" }),
];

const dir = join(ROOT, "live"), jdir = join(dir, ".workflow-journal");
mkdirSync(jdir, { recursive: true });
writeFileSync(join(jdir, "live.workflow.jsonl"), lines.join("\n"));
writeFileSync(join(jdir, "live.workflow.events.jsonl"), events.join("\n"));

let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log(`  ✓ ${name}`); else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };

// Static render (no --watch): the canonical build. The APP is identical to the
// watch build; only the <html data-live> flag differs, and the env controls that.
const staticOut = join(ROOT, "static.html");
execFileSync("node", [VIEW, dir, "--out", staticOut], { stdio: ["ignore", "ignore", "pipe"] });
const { DATA, APP } = extract(staticOut);
const baseGen = JSON.parse(DATA).gen || 0;

// ---- watch render writes the live flag + the sidecar update channel ----
{
  const watchOut = join(ROOT, "watch.html");
  // Spawn the watcher and kill it the MOMENT its three artifacts exist — this
  // used to be a guaranteed 1.5s timeout-kill on every run (the single biggest
  // fixed wait in the suite); the 10s deadline below is a failure ceiling, not
  // a wait that successful runs pay.
  const watcher = spawn("node", [VIEW, dir, "--out", watchOut, "--watch"], { stdio: "ignore" });
  const artifacts = [watchOut, join(ROOT, "watch.gen.js"), join(ROOT, "watch.data.js")];
  const written = (p) => { try { return statSync(p).size > 0; } catch { return false; } };
  const deadline = Date.now() + 10_000;
  while (!artifacts.every(written) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  watcher.kill("SIGKILL");
  const html = readFileSync(watchOut, "utf8");
  ok("watch render flags data-live=\"1\"", /<html lang="en" data-live="1">/.test(html));
  ok("watch render carries no <meta refresh>", !/http-equiv="refresh"/.test(html));
  ok("watch writes gen.js sidecar", existsSync(join(ROOT, "watch.gen.js")) && /__wfGen\(\d+\)/.test(readFileSync(join(ROOT, "watch.gen.js"), "utf8")));
  ok("watch writes data.js sidecar", existsSync(join(ROOT, "watch.data.js")) && /__wfPush\(\d+,/.test(readFileSync(join(ROOT, "watch.data.js"), "utf8")));
}

// ---- LIVE behavior (env reports data-live="1") ----
{
  const env = makeEnv(DATA, true);
  let threw = null;
  try { new Function(APP)(); } catch (e) { threw = e; }
  ok("LIVE APP runs without throwing", !threw, threw && (threw.stack || String(threw)).slice(0, 200));
  ok("sync loop armed under LIVE", !!env.win.__wfSync);
  ok("tick loop armed under LIVE", !!env.win.__wfTick);
  ok("exposes __wfGen / __wfPush", typeof env.win.__wfGen === "function" && typeof env.win.__wfPush === "function");
  ok("saveState wrote sessionStorage", env.store.size > 0);
  ok("__wfState reports live + gen", env.win.__wfState && env.win.__wfState().live === true && env.win.__wfState().gen === baseGen);

  // tickLive updates running-agent elapsed text in place.
  const elapsedNodes = withAttr("data-elapsed-start");
  ok("running agents expose [data-elapsed-start]", elapsedNodes.length >= 2, `found ${elapsedNodes.length}`);
  const tick = env.intervalFns.get(env.win.__wfTick);
  if (tick) { elapsedNodes.forEach((n) => (n._text = "stale")); tick(); ok("tickLive refreshed elapsed labels", elapsedNodes.every((n) => n._text !== "stale")); }

  // __wfPush reconciles in place — RUN swaps, NO reload.
  const d2 = JSON.parse(DATA);
  d2.gen = baseGen + 1000;
  const run2 = d2.agents.find((a) => a.status === "running");
  if (run2) { delete run2.status; run2.tokens = 40000; run2.ms = 30000; run2.result = { summary: "now done" }; }
  globalThis.__reloads = 0;
  env.win.__wfPush(d2.gen, d2);
  ok("__wfPush advanced the generation", env.win.__wfState().gen === baseGen + 1000, `gen=${env.win.__wfState().gen}`);
  ok("__wfPush reconciled WITHOUT a reload", globalThis.__reloads === 0, `reloads=${globalThis.__reloads}`);
  ok("__wfPush dropped a running agent", env.win.__wfState().running === 1, `running=${env.win.__wfState().running}`);
  ok("stale (older gen) push is ignored", (() => { env.win.__wfPush(baseGen, JSON.parse(DATA)); return env.win.__wfState().gen === baseGen + 1000; })());

  // a result/final push settles the page: LIVE off, sync interval cleared.
  const d3 = JSON.parse(DATA);
  d3.gen = baseGen + 2000;
  d3.agents.forEach((a) => { if (a.status === "running") { delete a.status; a.tokens = 1000; a.ms = 1000; } });
  d3.result = { headline: "all done" };
  env.win.__wfPush(d3.gen, d3);
  ok("result push settles LIVE→false", env.win.__wfState().live === false);
  ok("settle cleared the sync interval", env.win.__wfSync == null && !env.intervalFns.has(env.win.__wfSync));
  ok("settle fired no reload", globalThis.__reloads === 0);
}

// ---- reload fallback: if sidecar scripts can't load, revert to a reload loop ----
{
  const env = makeEnv(DATA, true, /*breakInject*/ true);
  let threw = null;
  try { new Function(APP)(); } catch (e) { threw = e; }
  ok("LIVE APP runs even when injection is broken", !threw, threw && (threw.stack || String(threw)).slice(0, 160));
  // initLive() already kicked one liveSync (miss 1); two more crosses the threshold.
  const sync = env.intervalFns.get(env.win.__wfSync);
  if (sync) { sync(); sync(); }
  ok("falls back to a reload loop after repeated sidecar failures", !!env.win.__wfReload);
}

// ---- state restore: pre-seed sessionStorage, assert loadState rehydrates it ----
{
  const env = makeEnv(DATA, true);
  env.store.set("cw:view:" + (JSON.parse(DATA).sources.journal), JSON.stringify({
    theme: "light", view: "tree", sel: { type: "run" }, collapsed: { Gather: true },
    drawerAgent: null, mapZoom: 1, mapTx: 0, mapTy: 0, mapUserAdjusted: false, mainScroll: 0, sideScroll: 0,
  }));
  let threw = null;
  try { new Function(APP)(); } catch (e) { threw = e; }
  ok("restore APP runs without throwing", !threw, threw && (threw.stack || String(threw)).slice(0, 200));
  ok("loadState restored theme → light", globalThis.document.body.className === "theme-light");
}

// ---- STATIC behavior (env reports data-live="0"): no sync, no tick, no reload ----
{
  ok("static render flags data-live=\"0\"", /<html lang="en" data-live="0">/.test(readFileSync(staticOut, "utf8")));
  const env = makeEnv(DATA, false);
  let threw = null;
  try { new Function(APP)(); } catch (e) { threw = e; }
  ok("static APP runs without throwing", !threw, threw && (threw.stack || String(threw)).slice(0, 200));
  ok("static arms no sync loop", env.win.__wfSync == null);
  ok("static arms no tick loop", env.win.__wfTick == null);
  ok("static fires no reload", globalThis.__reloads === 0);
}

rmSync(ROOT, { recursive: true, force: true });
if (failed) { console.error(`\nview-run live: ${failed} check(s) FAILED`); process.exit(1); }
console.log("\nview-run live: all checks passed ✓");
