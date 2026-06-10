#!/usr/bin/env node
// Single entrypoint for npx / git installs — dispatches to the runner's CLIs:
//
//   codex-workflows run <script.js> [flags]     execute a workflow (run-workflow)
//   codex-workflows fleet status|answer […]     supervise concurrent runs (fleet)
//   codex-workflows view [target] […]           generate/open the HTML run viewer
//   codex-workflows map [target] […]            render the ASCII execution map
//   codex-workflows summarize [target] […]      cost/performance/reliability report
//   codex-workflows doctor                      check the local Codex App Server
//
// e.g.  npx github:scasella/claude-dynamic-workflows-codex doctor

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "runner");
const MAP = {
  run: "bin/run-workflow.js",
  fleet: "bin/fleet.js",
  view: "bin/view-run.js",
  map: "bin/map-run.js",
  summarize: "bin/summarize-run.js",
  doctor: "test/handshake.js",
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !MAP[cmd]) {
  console.error(
    "usage: codex-workflows <command> [args]\n\n" +
      "  run <script.js> [flags]   execute a workflow against local Codex\n" +
      "  fleet status|answer […]   supervise concurrent runs\n" +
      "  view [target] […]         generate/open the HTML run viewer\n" +
      "  map [target] […]          render the ASCII execution map\n" +
      "  summarize [target] […]    cost/performance/reliability report\n" +
      "  doctor                    check the local Codex App Server is ready\n\n" +
      "Each command accepts its underlying CLI's flags (pass -h for them).",
  );
  process.exit(cmd ? 1 : 0);
}

const child = spawn(process.execPath, [join(RUNNER, MAP[cmd]), ...rest], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
