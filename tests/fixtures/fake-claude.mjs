#!/usr/bin/env node

import crypto from "node:crypto";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getArgValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    if (names.includes(args[index])) {
      return args[index + 1] ?? null;
    }
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write("fake-claude 1.0.0\n");
    return;
  }

  if (args[0] === "auth" && args[1] === "status") {
    if (process.env.FAKE_CLAUDE_AUTH === "0") {
      process.stderr.write("Not logged in.\n");
      process.exitCode = 1;
      return;
    }

    process.stdout.write("Login method: Fake account\nEmail: fake@example.com\n");
    return;
  }

  const prompt = getArgValue(args, ["-p", "--print"]) ?? "";
  const outputFormat = getArgValue(args, ["--output-format"]) ?? "text";
  const resumeSessionId = getArgValue(args, ["-r", "--resume"]);
  const model = getArgValue(args, ["--model"]) ?? "fake-model";
  const jsonSchema = getArgValue(args, ["--json-schema"]);
  const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
  const shouldFail = process.env.FAKE_CLAUDE_FAIL === "1" || prompt.includes("FAIL");

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const sessionId = resumeSessionId || crypto.randomUUID();

  if (shouldFail) {
    const errorPayload = {
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: sessionId,
      result: "Simulated failure",
    };

    if (outputFormat === "json") {
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
    } else {
      process.stderr.write("Simulated failure\n");
    }
    process.exitCode = 1;
    return;
  }

  const resultText = jsonSchema
    ? JSON.stringify({
        verdict: "concerns",
        summary: prompt.includes("Inline review context")
          ? "Inline adversarial review completed."
          : "Large adversarial review requires self-collection.",
        findings: [
          {
            title: "Schema-backed finding",
            severity: "medium",
            body: prompt.includes("Inline review context")
              ? "Inline context surfaced a medium-risk concern."
              : "Large diff summary surfaced a medium-risk concern.",
          },
        ],
        nextSteps: ["Investigate the highlighted concern."],
      })
    : prompt.includes("Review only the immediately previous edit-producing Codex turn.")
      ? process.env.FAKE_CLAUDE_STOP_MODE === "block"
        ? "BLOCK: stop gate found an issue\nFix the issue."
        : process.env.FAKE_CLAUDE_STOP_MODE === "invalid"
          ? "This is invalid stop output"
          : "ALLOW: gate passed"
      : resumeSessionId
        ? `RESUMED:${sessionId}:${prompt}`
        : `FRESH:${sessionId}:${prompt}`;

  if (outputFormat === "stream-json") {
    process.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`,
    );
  }

  const payload = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: delayMs,
    num_turns: 1,
    result: resultText,
    stop_reason: "end_turn",
    session_id: sessionId,
    modelUsage: {
      [model]: {
        inputTokens: prompt.length,
        outputTokens: resultText.length,
      },
    },
  };

  if (outputFormat === "json" || outputFormat === "stream-json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${resultText}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
