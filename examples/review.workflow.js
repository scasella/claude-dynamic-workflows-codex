// Reusable template: review a set of files for a given concern, with each
// finding adversarially verified as soon as its file is scanned (pipeline, no
// barrier). Parameterize via --args, e.g.:
//
//   node .../bin/run-workflow.js review.workflow.js \
//     --args '{"files":["src/auth.ts","src/routes.ts"],"focus":"missing authorization checks"}' \
//     --frontier --effort medium --sandbox read-only --budget 400000
//
// Pattern: pipeline(files, scan→schema, verify→parallel). Agents do the file
// reading (the script itself is sandboxed); findings that ≥1 skeptic confirms
// survive.

export const meta = {
  name: "review-files",
  description: "Scan each file for a concern, then adversarially verify each finding",
  phases: [
    { title: "Scan", detail: "one agent per file produces structured findings" },
    { title: "Verify", detail: "a skeptic tries to refute each finding" },
  ],
};

const FILES = (args && args.files) || [];
const FOCUS = (args && args.focus) || "bugs, security issues, and correctness problems";

if (!FILES.length) {
  log("No files given. Pass --args '{\"files\":[...],\"focus\":\"...\"}'.");
  return { findings: [], note: "no files" };
}

const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "line", "severity", "explanation"],
        properties: {
          title: { type: "string" },
          line: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          explanation: { type: "string" },
        },
      },
    },
  },
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reason"],
  properties: {
    real: { type: "boolean" },
    reason: { type: "string" },
  },
};

phase("Scan");

const perFile = await pipeline(
  FILES,
  // Stage 1 — scan one file (the agent reads it; script stays sandboxed).
  (file) =>
    agent(
      `Read the file ${file} and review it for: ${FOCUS}. Report concrete, located findings only.`,
      { schema: FINDINGS, label: `scan:${file}`, phase: "Scan" },
    ),
  // Stage 2 — verify each finding from that file, in parallel, the moment it lands.
  (scan, file) =>
    parallel(
      (scan.findings || []).map((f) => () =>
        agent(
          `In ${file}: "${f.title}" (${f.line}). ${f.explanation}\n` +
            `You are a skeptic. Try to REFUTE this. Default to real=false if uncertain.`,
          { schema: VERDICT, label: `verify:${file}`, phase: "Verify" },
        ).then((v) => ({ file, ...f, verdict: v })),
      ),
    ),
);

const confirmed = perFile
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict && f.verdict.real);

log(`Confirmed ${confirmed.length} finding(s) across ${FILES.length} file(s).`);

return { focus: FOCUS, files: FILES, confirmed };
