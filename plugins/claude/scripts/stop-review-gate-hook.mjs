#!/usr/bin/env node

import fs from "node:fs/promises";

import { getClaudeAuthStatus, detectClaudeBinary, runClaudeTask } from "./lib/claude.mjs";
import { loadPromptTemplate } from "./lib/prompts.mjs";
import { collectReviewContext, isRepoDirty, resolveReviewTarget } from "./lib/review.mjs";
import { readRuntimeState } from "./lib/state.mjs";

const SHELL_EDIT_PATTERNS = [
  /\bcat\b[^|\n]*[>]{1,2}/,
  /\btee\b/,
  /\bprintf\b[^|\n]*[>]{1,2}/,
  /\becho\b[^|\n]*[>]{1,2}/,
  /\bsed\b\s+-i\b/,
  /\bperl\b[^|\n]*-i/,
  /\bpython(?:3)?\b\s+- <<?/,
  /\bmv\b/,
  /\bcp\b/,
  /\btouch\b/,
  /\bmkdir\b/,
  /\brm\b/,
  /\bpatch\b/,
  /\bgit\s+apply\b/,
];

function allow(reason = null) {
  if (reason) {
    process.stderr.write(`${reason}\n`);
  }
  process.stdout.write("{}\n");
}

async function readHookInput() {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const timeout = setTimeout(finish, 25);

    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);

      const trimmed = text.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve(null);
      }
    }

    function onData(chunk) {
      text += String(chunk);
    }

    function onEnd() {
      finish();
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
    process.stdin.resume();
  });
}

function commandLooksMutating(command) {
  return SHELL_EDIT_PATTERNS.some((pattern) => pattern.test(command));
}

async function loadTranscriptTurnContext(transcriptPath, turnId) {
  if (!transcriptPath || !turnId) {
    return null;
  }

  let raw;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const callTurnIds = new Map();
  for (const entry of entries) {
    if (entry.type !== "event_msg") {
      continue;
    }

    const payload = entry.payload ?? {};
    if (payload.call_id && payload.turn_id) {
      callTurnIds.set(payload.call_id, payload.turn_id);
    }
  }

  const patches = [];
  const shellCommands = [];

  for (const entry of entries) {
    if (entry.type !== "response_item") {
      continue;
    }

    const payload = entry.payload ?? {};
    const eventTurnId = payload.call_id ? callTurnIds.get(payload.call_id) : null;
    if (eventTurnId !== turnId) {
      continue;
    }

    if (payload.type === "custom_tool_call" && payload.name === "apply_patch" && payload.input) {
      patches.push(payload.input.trim());
      continue;
    }

    if (payload.type === "function_call" && payload.name === "exec_command") {
      try {
        const args = JSON.parse(payload.arguments ?? "{}");
        if (typeof args.cmd === "string" && commandLooksMutating(args.cmd)) {
          shellCommands.push(args.cmd.trim());
        }
      } catch {
        // Ignore malformed tool payloads.
      }
    }
  }

  return {
    hasEdits: patches.length > 0 || shellCommands.length > 0,
    patches,
    shellCommands,
  };
}

async function buildStopReviewPrompt(hookInput) {
  const transcriptContext = await loadTranscriptTurnContext(
    hookInput?.transcript_path ?? null,
    hookInput?.turn_id ?? null,
  );

  if (transcriptContext) {
    if (!transcriptContext.hasEdits) {
      return { kind: "no-edits", prompt: null };
    }

    const sections = [
      (await loadPromptTemplate("stop-review-gate.md")).trim(),
      "",
      `Review target: Codex turn ${hookInput.turn_id}`,
      "",
      "Review only the current Codex turn identified by the supplied turn id and transcript.",
      "Ignore unrelated earlier workspace edits.",
    ];

    if (hookInput?.last_assistant_message) {
      sections.push("", "Latest assistant message:", hookInput.last_assistant_message.trim());
    }

    if (transcriptContext.patches.length) {
      sections.push("", "Patch content from this turn:");
      for (const patch of transcriptContext.patches) {
        sections.push(patch, "");
      }
    }

    if (transcriptContext.shellCommands.length) {
      sections.push("Mutating shell commands from this turn:");
      for (const command of transcriptContext.shellCommands) {
        sections.push(`- ${command}`);
      }
    }

    return {
      kind: "transcript-turn",
      prompt: sections.join("\n").trim(),
    };
  }

  if (!(await isRepoDirty(process.cwd()))) {
    return { kind: "no-edits", prompt: null };
  }

  const target = await resolveReviewTarget({ scope: "working-tree", baseRef: null }, process.cwd());
  const context = await collectReviewContext(target, process.cwd());
  return {
    kind: "working-tree",
    prompt: [
      (await loadPromptTemplate("stop-review-gate.md")).trim(),
      "",
      "Review target: working tree review",
      "",
      "Git status:",
      context.status || "(clean)",
      "",
      "Staged diff:",
      context.stagedDiff || "(none)",
      "",
      "Unstaged diff:",
      context.unstagedDiff || "(none)",
    ].join("\n"),
  };
}

async function main() {
  const runtime = await readRuntimeState();
  if (!runtime.reviewGateEnabled) {
    allow("ALLOW: review gate disabled");
    return;
  }

  const binary = await detectClaudeBinary();
  if (binary.code !== 0) {
    allow("ALLOW: review gate unavailable; run setup if you want gate enforcement");
    return;
  }

  // Intentionally do not gate on auth preflight. The real Claude invocation may still refresh stale auth.
  await getClaudeAuthStatus();

  const hookInput = await readHookInput();
  const stopReview = await buildStopReviewPrompt(hookInput);

  if (stopReview.kind === "no-edits") {
    allow("ALLOW: no edits");
    return;
  }

  const gateRun = await runClaudeTask(
    {
      prompt: stopReview.prompt,
      write: false,
    },
    {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    },
  );

  if (gateRun.timedOut) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          "Stop review gate timed out. Re-run review or disable the gate after investigation.",
      }) + "\n",
    );
    return;
  }

  if (gateRun.code !== 0 || gateRun.parsed?.is_error) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: "Stop review gate failed. Re-run review or disable the gate after investigation.",
      }) + "\n",
    );
    return;
  }

  const firstLine = gateRun.resultText.trim().split("\n")[0]?.trim() || "";
  if (firstLine.startsWith("ALLOW:")) {
    allow(firstLine);
    return;
  }

  if (firstLine.startsWith("BLOCK:")) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: firstLine.slice("BLOCK:".length).trim() || "Stop review gate blocked session stop.",
      }) + "\n",
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason:
        "Stop review gate returned invalid output. Re-run review or disable the gate after investigation.",
    }) + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
