#!/usr/bin/env node
// Sync this repo's skill surface to ~/.claude/skills/codex-workflows in one
// command — the skill lives in two places (the repo is the source of truth;
// the skills dir is what Claude Code loads) and they drift when synced by hand.
//
//   npm run sync-skill            # repo → ~/.claude/skills/codex-workflows
//
// Copies SKILL.md + references/ + examples/ + runner/, excluding OS noise and
// local run artifacts (but keeping the bundled demo's committed journal). The
// destination is replaced wholesale, so renames/deletions propagate too.

import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = process.argv[2] || join(homedir(), ".claude", "skills", "codex-workflows");

// Local artifacts that must not ship: OS noise, generated viewer pages, and
// run journals — EXCEPT the bundled demo's committed journal, which is the
// no-Codex-required showcase.
const KEEP_JOURNAL = join(SRC, "examples", "incident-demo", ".workflow-journal");
const skip = (p) => {
  const b = basename(p);
  if (b === ".DS_Store" || b === "node_modules") return true;
  if (b.endsWith(".run.html")) return true;
  if (b === ".workflow-journal" && p !== KEEP_JOURNAL) return true;
  return false;
};
const filter = (s) => !skip(s);

if (!existsSync(join(SRC, "SKILL.md"))) {
  console.error(`sync-skill: ${SRC} does not look like the repo root (no SKILL.md)`);
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(join(SRC, "SKILL.md"), join(DEST, "SKILL.md"));
for (const dir of ["references", "examples", "runner"]) {
  cpSync(join(SRC, dir), join(DEST, dir), { recursive: true, filter });
}

const ver = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
console.log(`synced skill (v${ver}) → ${DEST}`);
console.log(`  SKILL.md + references${sep} + examples${sep} + runner${sep}`);
console.log("  (excluded: .DS_Store, node_modules, *.run.html, local .workflow-journal dirs)");
