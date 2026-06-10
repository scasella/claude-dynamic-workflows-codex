// Integration checks for the live cockpit channel: `view-run --serve` serves the
// page + sidecars over 127.0.0.1 and accepts POST /answer for the workflow's
// human() questions (appended to the answers sidecar the runner polls). No Codex,
// no tokens — a fixture journal and a real local HTTP round-trip.
//
//   node test/serve.test.js

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const VIEW = new URL("../bin/view-run.js", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "wf-serve-"));

const dir = join(ROOT, "run");
const jdir = join(dir, ".workflow-journal");
mkdirSync(jdir, { recursive: true });
const jpath = join(jdir, "audit.workflow.jsonl");
writeFileSync(jpath, JSON.stringify({ key: "a#0", label: "scan:auth", result: { ok: 1 }, phase: "Scan" }) + "\n");
// a pending human() question, exactly as the runner's channel writes it
writeFileSync(join(jdir, "audit.workflow.questions.json"), JSON.stringify([
  { id: "human:scope#0", qid: "scope", question: "Include internal admin-only routes?", choices: ["include", "exclude"], default: "exclude", askedAt: 1, answered: false },
]));

const child = spawn("node", [VIEW, "--journal", jpath, "--serve", "--watch"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("serve never announced its URL; stderr=" + stderr)), 10_000);
  child.stderr.on("data", (c) => {
    stderr += c.toString();
    const m = stderr.match(/(http:\/\/127\.0\.0\.1:\d+\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  child.on("exit", () => reject(new Error("view-run exited early; stderr=" + stderr)));
});

try {
  // 1) the page is served, with the pending question embedded for the answer card
  const page = await fetch(url);
  assert.equal(page.status, 200, "page serves over http");
  const html = await page.text();
  assert.match(html, /Include internal admin-only routes\?/, "the pending question is embedded in the live model");
  assert.match(html, /questionCard/, "the viewer app ships the answer-card renderer");

  // 2) the sidecar update channel serves too (the page polls these by basename)
  const gen = await fetch(new URL("audit.workflow.run.gen.js", url));
  assert.equal(gen.status, 200, "gen sidecar serves");

  // 3) POST /answer (same-origin, application/json) appends to the answers sidecar
  const JSONH = { "content-type": "application/json" };
  const post = await fetch(new URL("/answer", url), { method: "POST", headers: JSONH, body: JSON.stringify({ id: "human:scope#0", answer: "include" }) });
  assert.equal(post.status, 204, "answer accepted (same-origin, json, pending id)");
  const answers = readFileSync(join(jdir, "audit.workflow.answers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].id, "human:scope#0");
  assert.equal(answers[0].answer, "include");

  // 4) hardening — input validation
  assert.equal((await fetch(new URL("/answer", url), { method: "POST", headers: JSONH, body: "not json" })).status, 400, "garbage json → 400");
  assert.equal((await fetch(new URL("/answer", url), { method: "POST", headers: JSONH, body: JSON.stringify({ nope: 1 }) })).status, 400, "no id/answer → 400");

  // 5) CSRF guard — Content-Type must be application/json (blocks the text/plain
  //    "simple request" cross-site POST), and a cross-origin Origin is rejected.
  assert.equal((await fetch(new URL("/answer", url), { method: "POST", body: JSON.stringify({ id: "human:scope#0", answer: "x" }) })).status, 403,
    "no application/json content-type → 403 (text/plain CSRF blocked)");
  assert.equal((await fetch(new URL("/answer", url), { method: "POST", headers: { ...JSONH, origin: "https://evil.example.com" }, body: JSON.stringify({ id: "human:scope#0", answer: "x" }) })).status, 403,
    "cross-origin Origin → 403");

  // 6) forged/unasked id — only a CURRENTLY-PENDING question id is accepted
  assert.equal((await fetch(new URL("/answer", url), { method: "POST", headers: JSONH, body: JSON.stringify({ id: "human:deploy_to_prod#0", answer: "yes" }) })).status, 409,
    "answering an unasked/forged gate id → 409 (can't pre-answer)");

  // 7) crash-resistance — a malformed %-escape must 400, NOT kill the process
  assert.equal((await fetch(new URL("/%ZZ.html", url))).status, 400, "malformed percent-escape → 400, server survives");
  assert.equal((await fetch(url)).status, 200, "server still serving after the malformed request");

  // 8) GET allowlist — only this run's own page + sidecars; traversal + co-located files blocked
  assert.equal((await fetch(new URL("/audit.workflow.run.data.js", url))).status, 200, "this run's data.js sidecar IS served (the page polls it)");
  assert.equal((await fetch(new URL("/etc/passwd", url))).status, 404, "no extension / not allowlisted → 404");
  assert.equal((await fetch(new URL("/nope.html", url))).status, 404, "non-allowlisted .html → 404");
  // plant a co-located whitelisted-looking file; the exact-name allowlist must refuse it
  writeFileSync(join(dir, "secret.html"), "SECRET");
  assert.equal((await fetch(new URL("/secret.html", url))).status, 404, "co-located file not on the allowlist → 404 (no cross-run disclosure)");
  // traversal stays blocked
  for (const u of ["/../../../../etc/passwd", "/..%2f..%2fetc%2fpasswd", "/.workflow-journal/audit.workflow.jsonl"]) {
    assert.equal((await fetch(new URL(u, url))).status, 404, `traversal ${u} → 404`);
  }
  assert.equal((await fetch(url)).status, 200, "server healthy after all probes");
} finally {
  child.kill();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log("serve (interactive cockpit) checks passed ✓");
