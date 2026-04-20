import fs from "node:fs/promises";

import { getCurrentCodexSessionId } from "./state.mjs";
import { runCommand, runCommandStreaming } from "./process.mjs";

const READ_ONLY_TOOLS = "Read,Glob,Grep,Bash";

function getClaudeBaseCommand() {
  const command = process.env.CODEX_CLAUDE_BIN ?? "claude";
  const extraArgs = process.env.CODEX_CLAUDE_BIN_ARGS_JSON
    ? JSON.parse(process.env.CODEX_CLAUDE_BIN_ARGS_JSON)
    : [];

  return { command, extraArgs };
}

function parseClaudeJson(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning backwards for the final JSON object.
    }
  }

  return null;
}

function buildClaudeArgs(args) {
  const { command, extraArgs } = getClaudeBaseCommand();
  return { command, args: [...extraArgs, ...args] };
}

export function getSessionRuntimeDescriptor() {
  return {
    mode: "direct-cli",
    endpoint: "local-cli",
    codexSessionId: getCurrentCodexSessionId(),
    binary: getClaudeBaseCommand().command,
  };
}

export async function detectClaudeBinary() {
  const { command, args } = buildClaudeArgs(["--version"]);
  return runCommand(command, args);
}

export async function detectNpmBinary() {
  const command = process.env.CODEX_NPM_BIN ?? "npm";
  return runCommand(command, ["--version"]);
}

export async function getClaudeAuthStatus() {
  const { command, args } = buildClaudeArgs(["auth", "status", "--text"]);
  return runCommand(command, args);
}

export async function loadPromptText({ text, promptFile }) {
  if (promptFile) {
    return fs.readFile(promptFile, "utf8");
  }

  return text;
}

export function buildTaskArgs({ prompt, resumeSessionId, model, effort, write, jsonSchema }) {
  const args = [];

  if (resumeSessionId) {
    args.push("-r", resumeSessionId);
  }

  args.push("-p", prompt, "--output-format", "json");

  if (model) {
    args.push("--model", model);
  }

  if (effort) {
    args.push("--effort", effort);
  }

  if (write) {
    args.push("--tools", "default", "--permission-mode", "bypassPermissions");
  } else {
    args.push("--tools", READ_ONLY_TOOLS);
  }

  if (jsonSchema) {
    args.push("--json-schema", jsonSchema);
  }

  return args;
}

export async function runClaudeTask(
  request,
  { cwd = process.cwd(), env = {}, onSpawn, onStdout, onStderr, timeoutMs } = {},
) {
  const { command, args } = buildClaudeArgs(buildTaskArgs(request));
  const run = await runCommandStreaming(command, args, {
    cwd,
    env,
    onSpawn,
    onStdout,
    onStderr,
    timeoutMs,
  });

  const parsed = parseClaudeJson(run.stdout);
  return {
    ...run,
    parsed,
    sessionId: parsed?.session_id ?? request.resumeSessionId ?? null,
    resultText: parsed?.result ?? (run.stdout.trim() || run.stderr.trim()),
  };
}
