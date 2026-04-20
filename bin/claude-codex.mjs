#!/usr/bin/env node

import { runMain } from "../plugins/claude/scripts/claude-companion.mjs";

const HELP_TEXT = `claude-codex (alias: ccx)

Use Claude Code from Codex CLI or your shell.

Usage:
  claude-codex setup [--json]
  claude-codex review [--scope auto|working-tree|branch] [--base <ref>] [--json]
  claude-codex adversarial-review [--scope auto|working-tree|branch] [--base <ref>] [--focus <text>] [--json]
  claude-codex task [--write] [--background] [--model <model>] [--effort <level>] <prompt>
  claude-codex status [--job-id <id>] [--wait] [--json]
  claude-codex result [--job-id <id>] [--json]
  claude-codex cancel [--job-id <id>] [--json]

Examples:
  ccx setup
  ccx review --scope auto
  claude-codex setup
  claude-codex review --scope auto
  claude-codex adversarial-review --focus "challenge the retry logic"
  claude-codex task --write "Fix the failing tests"
`;

async function cli(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  await runMain(argv);
}

cli().catch((error) => {
  const payload = { ok: false, error: error.message };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${error.message}\n`);
  }
  process.exitCode = 1;
});
