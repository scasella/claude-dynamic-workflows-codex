// Human-gate cockpit — a live worker explores, then the run PAUSES at a declared
// fork and asks YOU, mid-run, in the live viewer; the worker stays warm and is
// steered with your answer.
//
// NEW capability: the `interactive` involvement mode. With --gui the served live
// viewer shows an "needs you" answer card (choice buttons + free text) the moment
// human() is reached; with --tui/--interactive you answer from any terminal:
//   echo '{"id":"human:scope#0","answer":"include"}' >> .workflow-journal/human-gate.workflow.answers.jsonl
//
// Why this needs the new feature: before human(), a fork meant ending the run with
// a structured needs_human return and re-running later — every worker's context
// thrown away. Now the fleet idles WARM while you decide, and the answer is
// journaled: a --resume replays it (never re-asks), and args.checkpointAnswers
// pre-answers it for unattended runs.
//
//   node .../bin/run-workflow.js examples/human-gate.workflow.js \
//     --frontier --auto-effort --sandbox read-only --gui \
//     --args '{"topic":"missing input validation"}'
//
//   # unattended (CI): pre-answer the gate — no pause at all
//   ... --args '{"topic":"…","checkpointAnswers":{"scope":"exclude"}}'
//
// Runs under --plan (human() returns its default; no Codex, no tokens).

export const meta = {
  name: "human-gate",
  description: "A warm worker explores; the run pauses at a declared human fork, then steers with the answer",
  phases: [
    { title: "Explore", detail: "a sessionful worker maps the territory" },
    { title: "Decide", detail: "human() — the live viewer's answer card; default after timeout" },
    { title: "Deepen", detail: "the SAME warm worker, steered with the decision" },
  ],
};

const topic = (args && args.topic) || "potential reliability problems";

phase("Explore");
const scout = await agent.start(
  `Survey this repository for ${topic}. Map the candidate areas — a short list with file paths and one-line reasons. Do not go deep yet.`,
  { label: "scout", phase: "Explore", sandbox: "read-only" },
);
const survey = await scout.wait();

phase("Decide");
// The declared fork: scope is a POLICY call, so it belongs to the human — not the
// script, not a controller agent. The run waits here (fleet warm), then proceeds
// with the answer or, after timeoutMs, with the safe default.
const scope = await human(
  `The scout mapped these areas:\n${String(survey.text ?? survey.result ?? "").slice(0, 1200)}\n\nGo deep on everything, or only the top candidate?`,
  { id: "scope", choices: ["everything", "top-candidate-only"], default: "top-candidate-only", timeoutMs: 600_000 },
);

phase("Deepen");
// Same thread, full context — the scout doesn't re-read what it already mapped.
const deep = await scout.steer(
  scope === "everything"
    ? "Go deep on EVERY area you mapped: concrete findings with file:line evidence, ranked by severity."
    : "Go deep on only the single most promising area you mapped: concrete findings with file:line evidence, ranked by severity.",
  { wait: true },
);
await scout.close();

return { scope, findings: deep.result ?? deep.text, worker: scout.id };
