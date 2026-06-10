#!/usr/bin/env node
// Fleet supervision CLI — the supervisor's two verbs over running workflows:
//
//   fleet status [dir|journal ...] [--json] [--stall-after SECONDS]
//       One digest across every run found (a dir contributes ALL its journals):
//       state (running/completed/stopped/idle), phase + agent progress, tokens
//       vs budget, pending human() questions (with ready-to-paste answer
//       commands), stall flags, and each finished run's result. Designed to be
//       cheap enough for a supervising agent to poll in a loop.
//
//   fleet answer --journal J --id ID --answer TEXT [--answer-json]
//   fleet answer --journal J --list
//       Answer a pending human() question on a live run — the same channel the
//       --gui cockpit's answer card uses. Only a CURRENTLY-PENDING id is
//       accepted (you can't pre-answer or re-answer a gate). --answer-json
//       parses TEXT as JSON for non-string answers.
//
// The steer loop this enables: workflows authored with supervisor checkpoints
// (human() gates between rounds) read their next directive from the answer —
// `fleet answer … --answer 'drop the cache theory; go deep on the ORM layer'`
// IS the steer. Kill + `run-workflow --resume` forks/redirects everything else.

import { appendFileSync } from "node:fs";
import { inspectFleet, renderFleetText } from "../src/fleetStatus.js";
import { readQuestions, answersPathFor } from "../src/runModel.js";

function usage(code = 1) {
  console.error(
    "usage: fleet status [dir|journal ...] [--json] [--stall-after SECONDS]\n" +
      "       fleet answer --journal PATH (--list | --id ID --answer TEXT [--answer-json])",
  );
  process.exit(code);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "status") {
  const targets = [];
  let json = false;
  let stallAfterMs = 120_000;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--stall-after") stallAfterMs = Number(rest[++i]) * 1000;
    else if (a === "-h" || a === "--help") usage(0);
    else if (a.startsWith("--")) usage();
    else targets.push(a);
  }
  if (!Number.isFinite(stallAfterMs) || stallAfterMs <= 0) {
    console.error("--stall-after: expected a positive number of seconds");
    process.exit(1);
  }
  const infos = inspectFleet(targets, { stallAfterMs });
  if (json) console.log(JSON.stringify(infos, null, 2));
  else console.log(renderFleetText(infos));
  process.exit(0);
}

if (cmd === "answer") {
  let journal = null, id = null, answer = undefined, list = false, asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--journal") journal = rest[++i];
    else if (a === "--id") id = rest[++i];
    else if (a === "--answer") answer = rest[++i];
    else if (a === "--answer-json") asJson = true;
    else if (a === "--list") list = true;
    else if (a === "-h" || a === "--help") usage(0);
    else usage();
  }
  if (!journal) usage();

  const questions = readQuestions(journal);
  const pending = questions.filter((q) => !q.answered);

  if (list || id == null) {
    if (!questions.length) console.log("no questions asked yet on this run");
    else {
      console.log(`${pending.length} pending / ${questions.length} asked:`);
      for (const q of questions) {
        const status = q.answered ? (q.timedOut ? "timed out → default used" : `answered: ${JSON.stringify(q.answer)}`) : "PENDING";
        const choices = Array.isArray(q.choices) && q.choices.length ? `  choices: ${q.choices.join("|")}` : "";
        console.log(`  [${q.id}] ${status} — “${q.question}”${choices}${q.default != null ? `  default: ${q.default}` : ""}`);
      }
    }
    process.exit(list || !pending.length ? 0 : 1);
  }

  // Pending-only, exact-or-qid match — mirrors the serve endpoint's 409 rule.
  let q = pending.find((x) => x.id === id);
  if (!q) {
    const byQid = pending.filter((x) => x.qid === id);
    if (byQid.length === 1) q = byQid[0];
    else if (byQid.length > 1) {
      console.error(`qid '${id}' matches ${byQid.length} pending questions — use the full id: ${byQid.map((x) => x.id).join(", ")}`);
      process.exit(1);
    }
  }
  if (!q) {
    const asked = questions.find((x) => x.id === id || x.qid === id);
    if (asked) console.error(`question '${id}' is not pending anymore (${asked.timedOut ? "timed out — the default was used" : "already answered"})`);
    else console.error(`no pending question '${id}'${pending.length ? ` — pending: ${pending.map((x) => x.id).join(", ")}` : " — none pending"}`);
    process.exit(1);
  }
  if (answer === undefined) {
    console.error("--answer TEXT is required (or --list to inspect)");
    process.exit(1);
  }
  let value = answer;
  if (asJson) {
    try { value = JSON.parse(answer); } catch (e) {
      console.error(`--answer-json: not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  appendFileSync(answersPathFor(journal), JSON.stringify({ id: q.id, answer: value, at: Date.now(), via: "fleet-cli" }) + "\n");
  console.log(`answered [${q.id}] ← ${JSON.stringify(value)} (the runner picks it up within ~500ms)`);
  process.exit(0);
}

usage(cmd === "-h" || cmd === "--help" ? 0 : 1);
