#!/usr/bin/env node
// Wrap ANY long-running command in the fleet-protocol sidecars — the reference
// SECOND producer (see references/fleet-protocol.md). The wrapped job shows up
// in `fleet status` with a real state, streams its output as live progress,
// and can pause on supervisor gates answered via `fleet answer` (or the
// dashboard, or the --multi loop):
//
//   supervise [--name N] [--run-id ID] [--notify-cmd C] -- <command> [args…]
//
//   supervise --name nightly-evals -- python run_evals.py --suite all
//   supervise --name deploy -- ./deploy.sh staging
//
// Gates — the @@ASK convention: the wrapped job prints one line to stdout
//
//   @@ASK {"id":"ship","question":"Canary looks clean. Promote?","choices":["yes","no"],"default":"no"}
//
// and reads ONE line from stdin for the answer. From bash that is simply:
//
//   echo '@@ASK {"id":"ship","question":"Promote?","choices":["yes","no"],"default":"no"}'
//   read answer
//
// The shim publishes the question (questions sidecar + --notify-cmd push),
// polls the answers sidecar, and writes the answer (or the default on
// timeout — a gate never hangs) to the job's stdin. Answers are journaled.
//
// Stdout/stderr pass through untouched; exit code is the child's.

import { spawn } from "node:child_process";
import {
  mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync, existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = { name: null, runId: null, notifyCmd: null, cmd: null, args: [] };
  const rest = argv.slice(2);
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { i++; break; }
    else if (a === "--name") out.name = rest[++i];
    else if (a === "--run-id") out.runId = rest[++i];
    else if (a === "--notify-cmd") out.notifyCmd = rest[++i];
    else if (a === "-h" || a === "--help") return { help: true };
    else if (a.startsWith("--")) return { help: true, error: `unknown flag ${a}` };
    else { out.cmd = a; out.args = rest.slice(i + 1); return out; } // bare command (no --)
  }
  out.cmd = rest[i];
  out.args = rest.slice(i + 1);
  return out;
}

const opts = parseArgs(process.argv);
if (opts.help || !opts.cmd) {
  if (opts.error) console.error(opts.error);
  console.error(
    "usage: supervise [--name N] [--run-id ID] [--notify-cmd C] -- <command> [args…]\n" +
      "  Wraps the command in the fleet-protocol sidecars: it appears in `fleet status`,\n" +
      "  its output streams as live progress, and `@@ASK {json}` lines on its stdout\n" +
      "  become supervisor gates (answer via `fleet answer`; the reply arrives on the\n" +
      "  job's stdin; the default is used on timeout). See references/fleet-protocol.md.",
  );
  process.exit(opts.help && !opts.error ? 0 : 1);
}

const sanitize = (s) => String(s).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
const name = sanitize(opts.name ?? opts.cmd.split("/").pop());
const runSuffix = opts.runId ? `--${sanitize(opts.runId)}` : "";
const journalPath = resolve(`.workflow-journal/${name}${runSuffix}.jsonl`);
const B = journalPath.replace(/\.jsonl$/, "");
const startedAt = Date.now();

mkdirSync(dirname(journalPath), { recursive: true });
if (!existsSync(journalPath)) writeFileSync(journalPath, ""); // eager: discoverable at once
const atomic = (path, text) => { const tmp = path + ".tmp"; writeFileSync(tmp, text); renameSync(tmp, path); };

writeFileSync(B + ".meta.json", JSON.stringify({
  pid: process.pid, startedAt, script: [opts.cmd, ...opts.args].join(" "),
  runId: opts.runId ?? null, interactive: true, producer: "supervise",
}));
writeFileSync(B + ".events.jsonl", "");
atomic(B + ".questions.json", "[]");
if (!existsSync(B + ".answers.jsonl")) writeFileSync(B + ".answers.jsonl", "");

const event = (e) => { try { appendFileSync(B + ".events.jsonl", JSON.stringify({ t: Date.now(), ...e }) + "\n"); } catch {} };
const notify = opts.notifyCmd
  ? (evt) => {
      try {
        spawn("/bin/sh", ["-c", opts.notifyCmd], {
          env: { ...process.env, WORKFLOW_EVENT: JSON.stringify(evt) },
          stdio: "ignore", detached: true,
        }).unref();
      } catch {}
    }
  : null;

const JOB = "job#0";
event({ type: "start", id: JOB, label: name, phase: "Job" });

const child = spawn(opts.cmd, opts.args, { stdio: ["pipe", "pipe", "pipe"] });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(sig); } catch {} });

// ── live progress: tee all output into a bounded tail, throttled + atomic ────
let tail = "";
let progressTimer = null;
const bump = (chunk) => {
  tail = (tail + chunk).slice(-8000);
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    try { atomic(B + ".progress.json", JSON.stringify({ [JOB]: tail.slice(-4000) })); } catch {}
  }, 500);
};

// ── gates: @@ASK lines on stdout ─────────────────────────────────────────────
const questions = [];
const flushQuestions = () => { try { atomic(B + ".questions.json", JSON.stringify(questions)); } catch {} };
const readAnswers = () => {
  const out = new Map();
  try {
    for (const line of readFileSync(B + ".answers.jsonl", "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const a = JSON.parse(line); if (a && a.id !== undefined) out.set(String(a.id), a); } catch {}
    }
  } catch {}
  return out;
};
const journal = (entry) => { try { appendFileSync(journalPath, JSON.stringify(entry) + "\n"); } catch {} };

const occ = new Map();
function ask(spec) {
  const qid = sanitize(spec.id ?? `q${occ.size + 1}`);
  const n = occ.get(qid) ?? 0;
  occ.set(qid, n + 1);
  const id = `human:${qid}#${n}`;
  const def = spec.default !== undefined ? spec.default : Array.isArray(spec.choices) ? spec.choices[0] : null;
  const q = {
    id, qid, question: String(spec.question ?? qid),
    choices: Array.isArray(spec.choices) && spec.choices.length ? spec.choices.map(String) : null,
    default: def, askedAt: Date.now(), answered: false,
  };
  questions.push(q);
  flushQuestions();
  event({ type: "question", id, label: qid, kind: "human", question: q.question, choices: q.choices, default: def });
  notify?.({ event: "question", id, qid, question: q.question, choices: q.choices, default: def, journal: journalPath, script: opts.cmd });

  const deadline = Date.now() + (Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 600_000);
  const timer = setInterval(() => {
    const a = readAnswers().get(id);
    const timedOut = !a && Date.now() >= deadline;
    if (!a && !timedOut) return;
    clearInterval(timer);
    const answer = a ? a.answer : def;
    q.answered = true;
    q.answer = answer;
    if (!a) q.timedOut = true;
    flushQuestions();
    event({ type: "answered", id, label: qid, kind: "human", timedOut: !a });
    journal({ key: id, label: qid, result: answer, human: true, question: q.question, source: a ? "live" : "default" });
    // deliver to the job: one line on stdin (strings raw, anything else as JSON)
    try { child.stdin.write((typeof answer === "string" ? answer : JSON.stringify(answer)) + "\n"); } catch {}
  }, 500);
  timer.unref?.();
}

// line-scan stdout for @@ASK while passing everything through untouched
let lineBuf = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  bump(String(chunk));
  lineBuf += String(chunk);
  let nl;
  while ((nl = lineBuf.indexOf("\n")) !== -1) {
    const line = lineBuf.slice(0, nl);
    lineBuf = lineBuf.slice(nl + 1);
    const m = line.match(/^\s*@@ASK\s+(\{.*\})\s*$/);
    if (m) {
      try { ask(JSON.parse(m[1])); }
      catch (e) { process.stderr.write(`supervise: bad @@ASK line ignored (${e.message})\n`); }
    }
  }
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  bump(String(chunk));
});

child.on("error", (e) => {
  process.stderr.write(`supervise: failed to start ${opts.cmd}: ${e.message}\n`);
  event({ type: "end", id: JOB, status: "failed" });
  notify?.({ event: "end", status: "failed", journal: journalPath, script: opts.cmd });
  process.exit(127);
});

child.on("close", (code, signal) => {
  const ok = code === 0;
  const status = ok ? "completed" : "failed";
  const ms = Date.now() - startedAt;
  event({ type: "end", id: JOB, label: name, status, ms });
  journal({ key: JOB, label: name, phase: "Job", ms, status,
    result: { exitCode: code, signal: signal ?? undefined, outputTail: tail.slice(-2000) } });
  try { atomic(B + ".progress.json", "{}"); } catch {}
  if (ok) writeFileSync(B + ".result.json", JSON.stringify({ exitCode: 0, outputTail: tail.slice(-2000) }));
  notify?.({ event: "end", status: ok ? "completed" : "failed", journal: journalPath, script: opts.cmd });
  process.exit(signal ? 1 : code ?? 1);
});
