import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { parseArgs } from "../plugins/claude/scripts/lib/args.mjs";
import {
  collectReviewContext,
  detectDefaultBaseRef,
  parseStructuredReviewOutput,
  resolveReviewTarget,
  shapeAdversarialReviewContext,
  validateStructuredReviewOutput,
} from "../plugins/claude/scripts/lib/review.mjs";
import { getWorkspaceDescriptor } from "../plugins/claude/scripts/lib/workspace.mjs";

const execFileAsync = promisify(execFile);
const runtimeScript = path.resolve("plugins/claude/scripts/claude-companion.mjs");
const fakeClaudeScript = path.resolve("tests/fixtures/fake-claude.mjs");
const lifecycleHookScript = path.resolve("plugins/claude/scripts/session-lifecycle-hook.mjs");
const stopGateHookScript = path.resolve("plugins/claude/scripts/stop-review-gate-hook.mjs");

async function createHarness(sessionId = "thread-a") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-companion-"));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await fs.mkdir(workspace, { recursive: true });

  const env = {
    ...process.env,
    CODEX_THREAD_ID: sessionId,
    CODEX_CLAUDE_HANDOFF_ROOT: stateRoot,
    CODEX_CLAUDE_BIN: process.execPath,
    CODEX_CLAUDE_BIN_ARGS_JSON: JSON.stringify([fakeClaudeScript]),
  };

  return { root, workspace, stateRoot, env };
}

async function runProcess(command, args, options = {}) {
  return execFileAsync(command, args, options);
}

async function initGitRepo(workspace) {
  await runProcess("git", ["init", "-b", "main"], { cwd: workspace });
  await runProcess("git", ["config", "user.name", "Codex Test"], { cwd: workspace });
  await runProcess("git", ["config", "user.email", "codex@example.com"], { cwd: workspace });
}

async function commitFile(workspace, relativePath, content, message) {
  await fs.writeFile(path.join(workspace, relativePath), content, "utf8");
  await runProcess("git", ["add", relativePath], { cwd: workspace });
  await runProcess("git", ["commit", "-m", message], { cwd: workspace });
}

async function runCli(harness, args, extraEnv = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [runtimeScript, ...args], {
    cwd: harness.workspace,
    env: { ...harness.env, ...extraEnv },
  });

  return {
    stdout,
    stderr,
    json: args.includes("--json") ? JSON.parse(stdout) : null,
  };
}

async function runCliExpectFailure(harness, args, extraEnv = {}) {
  try {
    await runCli(harness, args, extraEnv);
  } catch (error) {
    return JSON.parse(error.stdout);
  }

  throw new Error("command unexpectedly succeeded");
}

async function runLifecycleHook(harness, phase, extraEnv = {}) {
  const { stdout } = await execFileAsync(process.execPath, [lifecycleHookScript, phase], {
    cwd: harness.workspace,
    env: { ...harness.env, ...extraEnv },
  });

  return JSON.parse(stdout);
}

async function runStopGateHook(harness, extraEnv = {}) {
  const stdin = extraEnv.__stdin ?? "";
  const env = { ...harness.env, ...extraEnv };
  delete env.__stdin;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stopGateHookScript], {
      cwd: harness.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(stderr || `stop hook exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(stdin);
  });
}

async function writeStopTranscript(workspace, { turnId: _turnId, entries }) {
  const transcriptPath = path.join(workspace, "stop-hook-transcript.jsonl");
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: "session-1" },
    }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  await fs.writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}

test("parseArgs extracts flags and positionals", () => {
  const parsed = parseArgs(["task", "--write", "--model", "sonnet", "fix", "bug"]);
  assert.equal(parsed.subcommand, "task");
  assert.equal(parsed.flags.write, true);
  assert.equal(parsed.flags.model, "sonnet");
  assert.deepEqual(parsed.positionals, ["fix", "bug"]);
});

test("parseArgs keeps positionals after boolean flags", () => {
  const parsed = parseArgs(["task", "--json", "--write", "Implement", "sample", "change"]);
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.write, true);
  assert.deepEqual(parsed.positionals, ["Implement", "sample", "change"]);
});

test("workspace descriptor is stable for a cwd", () => {
  const a = getWorkspaceDescriptor("/tmp/example-project");
  const b = getWorkspaceDescriptor("/tmp/example-project");
  assert.equal(a.slug, b.slug);
  assert.match(a.stateRoot, /claude-handoff/);
});

test("review target resolution uses working-tree for dirty auto and branch for clean auto", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");

  const cleanTarget = await resolveReviewTarget(
    { scope: "auto", baseRef: null },
    harness.workspace,
  );
  assert.equal(cleanTarget.targetKind, "branch");
  assert.equal(cleanTarget.baseRef, "main");

  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");
  const dirtyTarget = await resolveReviewTarget(
    { scope: "auto", baseRef: null },
    harness.workspace,
  );
  assert.equal(dirtyTarget.targetKind, "working-tree");
});

test("review target resolution detects explicit branch and base refs", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await runProcess("git", ["checkout", "-b", "feature"], { cwd: harness.workspace });
  await commitFile(harness.workspace, "app.txt", "two\n", "feature change");

  assert.equal(await detectDefaultBaseRef(harness.workspace), "main");

  const branchTarget = await resolveReviewTarget(
    { scope: "branch", baseRef: null },
    harness.workspace,
  );
  assert.equal(branchTarget.targetKind, "branch");
  assert.equal(branchTarget.baseRef, "main");

  const explicitBaseTarget = await resolveReviewTarget(
    { scope: "auto", baseRef: "HEAD~1" },
    harness.workspace,
  );
  assert.equal(explicitBaseTarget.baseRef, "HEAD~1");
});

test("review context collection returns working-tree and branch summaries", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");

  const workingTreeContext = await collectReviewContext(
    { targetKind: "working-tree", title: "working tree review" },
    harness.workspace,
  );
  assert.equal(workingTreeContext.mode, "working-tree");
  assert.match(workingTreeContext.unstagedDiff, /two/);

  await runProcess("git", ["checkout", "-b", "feature"], { cwd: harness.workspace });
  await commitFile(harness.workspace, "feature.txt", "branch\n", "feature change");

  const branchContext = await collectReviewContext(
    { targetKind: "branch", baseRef: "main", title: "branch review" },
    harness.workspace,
  );
  assert.equal(branchContext.mode, "branch");
  assert.match(branchContext.commitLog, /feature change/);
});

test("setup reports runtime status and session runtime details", async () => {
  const harness = await createHarness();
  const result = await runCli(harness, ["setup", "--json"]);

  assert.equal(result.json.ok, true);
  assert.equal(result.json.checks.claudeBinary.ok, true);
  assert.equal(result.json.checks.npm.ok, true);
  assert.equal(result.json.checks.auth.ok, true);
  assert.equal(result.json.checks.auth.source, "auth-status");
  assert.equal(result.json.sessionRuntime.mode, "direct-cli");
  assert.equal(result.json.sessionRuntime.codexSessionId, "thread-a");
});

test("setup stays ready when npm is unavailable but Claude is installed", async () => {
  const harness = await createHarness();
  const result = await runCli(harness, ["setup", "--json"], {
    CODEX_NPM_BIN: "/definitely-missing-npm",
  });

  assert.equal(result.json.ok, true);
  assert.equal(result.json.checks.claudeBinary.ok, true);
  assert.equal(result.json.checks.npm.ok, false);
  assert.equal(result.json.checks.auth.ok, true);
});

test("setup trusts stored Claude session evidence when auth status is stale", async () => {
  const harness = await createHarness();
  const task = await runCli(harness, ["task", "--json", "Warm", "up"]);

  assert.equal(task.json.ok, true);
  assert.match(task.json.job.claudeSessionId, /^[0-9a-f-]+$/);

  const setup = await runCli(harness, ["setup", "--json"], { FAKE_CLAUDE_AUTH: "0" });

  assert.equal(setup.json.ok, true);
  assert.equal(setup.json.checks.auth.ok, true);
  assert.equal(setup.json.checks.auth.source, "session-state");
  assert.match(setup.json.checks.auth.output, /prior Claude session is recorded/i);
});

test("task foreground stores session id and result output", async () => {
  const harness = await createHarness();
  const result = await runCli(harness, ["task", "--json", "--write", "Implement", "feature"]);

  assert.equal(result.json.ok, true);
  assert.equal(result.json.job.status, "completed");
  assert.match(result.json.job.rawOutput, /^FRESH:/);
  assert.match(result.json.job.claudeSessionId, /^[0-9a-f-]+$/);

  const stored = await runCli(harness, ["result", "--json"]);
  assert.match(stored.json.output, /^FRESH:/);
  assert.match(stored.json.output, /Resume hint: claude -r/);
});

test("review rejects extra focus text and stores completed output", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");

  const failure = await runCliExpectFailure(harness, ["review", "--json", "focus text"]);
  assert.match(failure.error, /adversarial-review/);

  const review = await runCli(harness, ["review", "--json"]);
  assert.equal(review.json.ok, true);
  assert.equal(review.json.job.kind, "review");
  assert.equal(review.json.job.status, "completed");
  assert.equal(review.json.job.scope, "working-tree");
  assert.match(review.json.output, /^FRESH:/);

  const result = await runCli(harness, ["result", review.json.job.id, "--json"]);
  assert.equal(result.json.job.id, review.json.job.id);
});

test("review background still completes synchronously with a tracked review job", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");

  const review = await runCli(harness, ["review", "--json", "--background"]);
  assert.equal(review.json.ok, true);
  assert.equal(review.json.job.kind, "review");
  assert.equal(review.json.job.status, "completed");
  assert.equal(review.json.job.background ?? false, false);
});

test("adversarial review context uses inline mode for small diffs and self-collect for larger diffs", async () => {
  const inlineContext = shapeAdversarialReviewContext({
    mode: "working-tree",
    status: "M app.txt",
    stagedStat: "",
    stagedDiff: "",
    unstagedStat: " app.txt | 1 +",
    unstagedDiff: "diff --git a/app.txt b/app.txt\n+small\n",
    changedFiles: ["app.txt"],
  });
  assert.equal(inlineContext.mode, "inline");

  const largeContext = shapeAdversarialReviewContext({
    mode: "working-tree",
    status: "M a\nM b\nM c",
    stagedStat: "",
    stagedDiff: "",
    unstagedStat: "",
    unstagedDiff: "x",
    changedFiles: ["a", "b", "c"],
  });
  assert.equal(largeContext.mode, "self-collect");
});

test("structured adversarial review output is validated", () => {
  const valid = validateStructuredReviewOutput({
    verdict: "concerns",
    summary: "Summary",
    findings: [{ title: "Issue", severity: "medium", body: "Body" }],
    nextSteps: ["Fix it"],
  });
  assert.equal(valid.verdict, "concerns");

  assert.throws(() =>
    validateStructuredReviewOutput({
      summary: "Missing verdict",
      findings: [],
      nextSteps: [],
    }),
  );

  const fenced = parseStructuredReviewOutput(`\`\`\`json
{"verdict":"pass","summary":"ok","findings":[],"nextSteps":["Ship it"]}
\`\`\``);
  assert.equal(fenced.verdict, "pass");

  const normalized = parseStructuredReviewOutput(`\`\`\`json
{
  "summary": "Summary",
  "findings": [
    {
      "id": "F1",
      "severity": "info",
      "location": "app.txt:1",
      "issue": "Issue body"
    }
  ],
  "blocking_questions": ["Question?"],
  "verdict": "request_changes"
}
\`\`\``);
  assert.equal(normalized.verdict, "block");
  assert.equal(normalized.findings[0].severity, "low");
  assert.equal(normalized.findings[0].file, "app.txt");

  const recommendationDriven = parseStructuredReviewOutput(`\`\`\`json
{
  "summary": "Summary",
  "findings": [],
  "recommendation": "request-changes",
  "required_before_merge": ["Add tests"]
}
\`\`\``);
  assert.equal(recommendationDriven.verdict, "block");
  assert.deepEqual(recommendationDriven.nextSteps, ["Add tests"]);
});

test("adversarial review accepts focus text and stores structured output", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");

  const review = await runCli(harness, [
    "adversarial-review",
    "--json",
    "Challenge",
    "the",
    "design",
  ]);

  assert.equal(review.json.ok, true);
  assert.equal(review.json.job.kind, "adversarial-review");
  assert.equal(review.json.job.reviewShape.mode, "inline");
  assert.match(review.json.job.rawOutput, /"verdict":"concerns"/);

  const result = await runCli(harness, ["result", review.json.job.id, "--json"]);
  assert.match(result.json.output, /verdict: concerns/);
  assert.match(result.json.output, /Schema-backed finding/);
});

test("adversarial review uses self-collect mode for large diffs", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "a.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "a.txt"), "two\n", "utf8");
  await fs.writeFile(path.join(harness.workspace, "b.txt"), "three\n", "utf8");
  await fs.writeFile(path.join(harness.workspace, "c.txt"), "four\n", "utf8");

  const review = await runCli(harness, ["adversarial-review", "--json", "Stress", "test"]);
  assert.equal(review.json.job.reviewShape.mode, "self-collect");
});

test("resume candidate and --resume reuse the stored Claude session", async () => {
  const harness = await createHarness();
  const first = await runCli(harness, ["task", "--json", "--write", "First", "prompt"]);
  const candidate = await runCli(harness, ["task-resume-candidate", "--json"]);

  assert.equal(candidate.json.candidate.id, first.json.job.id);

  const resumed = await runCli(harness, [
    "task",
    "--json",
    "--resume",
    "--write",
    "Second",
    "prompt",
  ]);
  assert.equal(resumed.json.job.resumeSourceJobId, first.json.job.id);
  assert.equal(resumed.json.job.claudeSessionId, first.json.job.claudeSessionId);
  assert.match(resumed.json.output, /^RESUMED:/);
});

test("--fresh stays routing-only and does not leak into prompt text", async () => {
  const harness = await createHarness();
  const first = await runCli(harness, ["task", "--json", "--write", "First", "prompt"]);
  const fresh = await runCli(harness, ["task", "--json", "--fresh", "--write", "Second", "prompt"]);

  assert.equal(fresh.json.ok, true);
  assert.match(fresh.json.output, /^FRESH:/);
  assert.doesNotMatch(fresh.json.output, /--fresh/);
  assert.notEqual(fresh.json.job.claudeSessionId, first.json.job.claudeSessionId);
  assert.equal(fresh.json.job.resumeSourceJobId, null);
});

test("task still runs when auth status is stale or failing", async () => {
  const harness = await createHarness();
  const result = await runCli(harness, ["task", "--json", "--write", "Run", "despite", "auth"], {
    FAKE_CLAUDE_AUTH: "0",
  });

  assert.equal(result.json.ok, true);
  assert.equal(result.json.job.status, "completed");
});

test("task forwards prompt-file, model, and effort options", async () => {
  const harness = await createHarness();
  const promptFile = path.join(harness.workspace, "prompt.txt");
  await fs.writeFile(promptFile, "Prompt from file", "utf8");

  const result = await runCli(harness, [
    "task",
    "--json",
    "--write",
    "--prompt-file",
    promptFile,
    "--model",
    "sonnet",
    "--effort",
    "high",
  ]);

  assert.equal(result.json.job.promptFile, promptFile);
  assert.equal(result.json.job.model, "sonnet");
  assert.equal(result.json.job.effort, "high");
  assert.ok(result.json.job.rawClaudeResult.modelUsage.sonnet);
  assert.match(result.json.output, /Prompt from file/);
});

test("status and result default to the current Codex session", async () => {
  const harnessA = await createHarness("thread-a");
  const harnessB = {
    ...(await createHarness("thread-b")),
    workspace: harnessA.workspace,
    stateRoot: harnessA.stateRoot,
  };
  harnessB.env = {
    ...harnessA.env,
    CODEX_THREAD_ID: "thread-b",
    CODEX_CLAUDE_HANDOFF_ROOT: harnessA.stateRoot,
  };

  const jobA = await runCli(harnessA, ["task", "--json", "--write", "Task", "A"]);
  const jobB = await runCli(harnessB, ["task", "--json", "--write", "Task", "B"]);
  const resultA = await runCli(harnessA, ["result", "--json"]);
  const resultB = await runCli(harnessB, ["result", "--json"]);
  const statusA = await runCli(harnessA, ["status", "--json"]);

  assert.equal(resultA.json.job.id, jobA.json.job.id);
  assert.equal(resultB.json.job.id, jobB.json.job.id);
  assert.equal(statusA.json.recentJobs.length, 1);
  assert.equal(statusA.json.recentJobs[0].id, jobA.json.job.id);
});

test("background task can be waited on and cancelled", async () => {
  const harness = await createHarness();
  const queued = await runCli(
    harness,
    ["task", "--json", "--background", "--write", "Long", "task"],
    { FAKE_CLAUDE_DELAY_MS: "8000" },
  );

  assert.equal(queued.json.job.status, "queued");

  const timedStatus = await runCli(harness, [
    "status",
    queued.json.job.id,
    "--wait",
    "--wait-timeout-ms",
    "100",
    "--json",
  ]);
  assert.equal(timedStatus.json.timedOut, true);
  assert.equal(timedStatus.json.job.id, queued.json.job.id);

  const cancelled = await runCli(harness, ["cancel", queued.json.job.id, "--json"]);
  assert.equal(cancelled.json.job.status, "cancelled");

  const finalStatus = await runCli(harness, ["status", "--json"]);
  assert.equal(finalStatus.json.activeJobs.length, 0);
});

test("explicit job ids can cancel jobs outside the current session", async () => {
  const harnessA = await createHarness("thread-a");
  const harnessB = {
    ...(await createHarness("thread-b")),
    workspace: harnessA.workspace,
    stateRoot: harnessA.stateRoot,
  };
  harnessB.env = {
    ...harnessA.env,
    CODEX_THREAD_ID: "thread-b",
    CODEX_CLAUDE_HANDOFF_ROOT: harnessA.stateRoot,
  };

  const queued = await runCli(
    harnessB,
    ["task", "--json", "--background", "--write", "Cross", "session", "task"],
    { FAKE_CLAUDE_DELAY_MS: "8000" },
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await runCli(harnessA, ["status", queued.json.job.id, "--json"]);
    if (status.json.job?.status === "queued" || status.json.job?.status === "running") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const cancelled = await runCli(harnessA, ["cancel", queued.json.job.id, "--json"]);
  assert.equal(cancelled.json.job.status, "cancelled");
});

test("cancel without a unique active current-session job fails", async () => {
  const harness = await createHarness();
  const failure = await runCliExpectFailure(harness, ["cancel", "--json"]);
  assert.match(failure.error, /no active current-session jobs/);
});

test("SessionStart records session metadata", async () => {
  const harness = await createHarness("thread-start");
  const payload = await runLifecycleHook(harness, "SessionStart");
  assert.deepEqual(payload, {});

  const status = await runCli(harness, ["setup", "--json"]);
  assert.equal(status.json.sessionRuntime.codexSessionId, "thread-start");
});

test("SessionEnd removes ending-session jobs and preserves other sessions", async () => {
  const harnessA = await createHarness("thread-a");
  const harnessB = {
    ...(await createHarness("thread-b")),
    workspace: harnessA.workspace,
    stateRoot: harnessA.stateRoot,
  };
  harnessB.env = {
    ...harnessA.env,
    CODEX_THREAD_ID: "thread-b",
    CODEX_CLAUDE_HANDOFF_ROOT: harnessA.stateRoot,
  };

  await runLifecycleHook(harnessA, "SessionStart");
  await runLifecycleHook(harnessB, "SessionStart");

  await runCli(
    harnessA,
    ["task", "--json", "--background", "--write", "Ending", "session", "job"],
    { FAKE_CLAUDE_DELAY_MS: "8000" },
  );
  const jobB = await runCli(harnessB, ["task", "--json", "--write", "Keep", "session"]);

  const ended = await runLifecycleHook(harnessA, "SessionEnd");
  assert.deepEqual(ended, {});

  const statusA = await runCli(harnessA, ["status", "--json"]);
  const statusB = await runCli(harnessB, ["status", "--json"]);
  assert.equal(statusA.json.recentJobs.length, 0);
  assert.equal(statusB.json.recentJobs.length, 1);
  assert.equal(statusB.json.recentJobs[0].id, jobB.json.job.id);
});

test("stop gate allows when disabled", async () => {
  const harness = await createHarness();
  const output = await runStopGateHook(harness);
  assert.deepEqual(JSON.parse(output), {});
});

test("stop gate allows clean repos immediately when enabled", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const output = await runStopGateHook(harness);
  assert.deepEqual(JSON.parse(output), {});
});

test("stop gate allows dirty repos when the current transcript turn did not edit files", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "workspace dirty\n", "utf8");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const turnId = "turn-no-edits";
  const transcriptPath = await writeStopTranscript(harness.workspace, {
    turnId,
    entries: [
      {
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId },
      },
      {
        timestamp: new Date().toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Summarized the status only." }],
        },
      },
    ],
  });

  const output = await runStopGateHook(harness, {
    __stdin: JSON.stringify({
      turn_id: turnId,
      transcript_path: transcriptPath,
      last_assistant_message: "Summarized the status only.",
    }),
  });
  assert.deepEqual(JSON.parse(output), {});
});

test("stop gate reviews transcript-backed apply_patch turns even when the repo is clean", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const turnId = "turn-with-edits";
  const callId = "call-apply-patch";
  const transcriptPath = await writeStopTranscript(harness.workspace, {
    turnId,
    entries: [
      {
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId },
      },
      {
        timestamp: new Date().toISOString(),
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: callId,
          name: "apply_patch",
          input: [
            "*** Begin Patch",
            `*** Update File: ${path.join(harness.workspace, "app.txt")}`,
            "@@",
            "-one",
            "+two",
            "*** End Patch",
          ].join("\n"),
        },
      },
      {
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: { turn_id: turnId, call_id: callId, status: "completed" },
      },
    ],
  });

  const output = await runStopGateHook(harness, {
    FAKE_CLAUDE_STOP_MODE: "block",
    __stdin: JSON.stringify({
      turn_id: turnId,
      transcript_path: transcriptPath,
      last_assistant_message: "Updated app.txt.",
    }),
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /stop gate found an issue/i);
});

test("stop gate blocks or allows based on Claude first line", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const allowOutput = await runStopGateHook(harness, { FAKE_CLAUDE_STOP_MODE: "allow" });
  assert.deepEqual(JSON.parse(allowOutput), {});

  const blockOutput = await runStopGateHook(harness, { FAKE_CLAUDE_STOP_MODE: "block" });
  const parsedBlock = JSON.parse(blockOutput);
  assert.equal(parsedBlock.decision, "block");
  assert.match(parsedBlock.reason, /stop gate found an issue/i);
});

test("stop gate blocks invalid output but allows unavailable Claude", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const invalidOutput = await runStopGateHook(harness, { FAKE_CLAUDE_STOP_MODE: "invalid" });
  const parsedInvalid = JSON.parse(invalidOutput);
  assert.equal(parsedInvalid.decision, "block");

  const unavailableOutput = await runStopGateHook(harness, { FAKE_CLAUDE_AUTH: "0" });
  assert.deepEqual(JSON.parse(unavailableOutput), {});
});

test("stop gate still attempts the real run when auth preflight is stale", async () => {
  const harness = await createHarness();
  await initGitRepo(harness.workspace);
  await commitFile(harness.workspace, "app.txt", "one\n", "initial");
  await fs.writeFile(path.join(harness.workspace, "app.txt"), "two\n", "utf8");
  await runCli(harness, ["setup", "--json", "--enable-review-gate"]);

  const output = await runStopGateHook(harness, {
    FAKE_CLAUDE_AUTH: "0",
    FAKE_CLAUDE_STOP_MODE: "block",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");
});
