#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { getEmbeddedJsonSchema } from "./lib/assets.mjs";
import {
  detectClaudeBinary,
  detectNpmBinary,
  getClaudeAuthStatus,
  getSessionRuntimeDescriptor,
  loadPromptText,
  runClaudeTask,
} from "./lib/claude.mjs";
import {
  buildStatusSnapshot,
  createTrackedJob,
  logJobProgress,
  resolveCancelTarget,
  resolveLatestFinishedJob,
  resolveResumeCandidate,
  waitForJob,
} from "./lib/job-control.mjs";
import { spawnDetached, terminateProcessTree } from "./lib/process.mjs";
import {
  buildAdversarialReviewPrompt,
  buildReviewPrompt,
  loadPromptTemplate,
} from "./lib/prompts.mjs";
import { renderResult, renderSetup, renderStatus, renderStructuredReview } from "./lib/render.mjs";
import {
  collectReviewContext,
  parseStructuredReviewOutput,
  resolveReviewTarget,
  shapeAdversarialReviewContext,
} from "./lib/review.mjs";
import {
  readSessionState,
  updateSessionState,
  writeRuntimeState,
  readRuntimeState,
} from "./lib/state.mjs";
import { listJobs, loadJob, updateJob } from "./lib/tracked-jobs.mjs";

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printText(value) {
  process.stdout.write(`${value}\n`);
}

function getScriptPath() {
  return fileURLToPath(import.meta.url);
}

async function loadStructuredReviewSchema() {
  const schemaPath = path.resolve(
    path.dirname(getScriptPath()),
    "..",
    "schemas",
    "review-output.schema.json",
  );

  try {
    return await fs.readFile(schemaPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return getEmbeddedJsonSchema("review-output.schema.json");
    }

    throw error;
  }
}

async function executeTaskJob(jobId, cwd = process.cwd()) {
  const job = await loadJob(jobId, cwd);
  if (!job) {
    throw new Error("job not found");
  }

  await updateJob(
    job.id,
    {
      status: "running",
      startedAt: new Date().toISOString(),
    },
    cwd,
  );
  await logJobProgress(job, "Starting Claude task execution.");

  const taskRun = await runClaudeTask(
    {
      prompt: job.prompt,
      resumeSessionId: job.resumeSessionId ?? null,
      model: job.model ?? null,
      effort: job.effort ?? null,
      write: job.mode === "write",
    },
    {
      cwd,
      onStdout: async (text) => {
        await logJobProgress(job, `stdout: ${text.trim()}`);
      },
      onStderr: async (text) => {
        await logJobProgress(job, `stderr: ${text.trim()}`);
      },
    },
  );

  const success = taskRun.code === 0 && !taskRun.parsed?.is_error;
  const patch = {
    status: success ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    exitCode: taskRun.code,
    claudeSessionId: taskRun.sessionId,
    rawOutput: taskRun.resultText,
    renderedOutput: taskRun.resultText,
    rawClaudeResult: taskRun.parsed ?? null,
    processGroupId: null,
    workerPid: null,
  };

  await updateJob(job.id, patch, cwd);

  if (taskRun.sessionId && job.codexSessionId) {
    await updateSessionState(
      job.codexSessionId,
      {
        latestJobId: job.id,
        latestClaudeSessionId: taskRun.sessionId,
      },
      cwd,
    );
  }

  return {
    ...(await loadJob(job.id, cwd)),
    ok: success,
  };
}

async function handleSetup(options) {
  const [binary, npm, auth, sessionState, jobs] = await Promise.all([
    detectClaudeBinary(),
    detectNpmBinary(),
    getClaudeAuthStatus(),
    readSessionState(undefined, process.cwd()),
    listJobs(process.cwd()),
  ]);
  const runtime = await readRuntimeState();
  const sessionRuntime = getSessionRuntimeDescriptor();
  const reviewGateEnabled =
    options.reviewGateMode === "enable"
      ? true
      : options.reviewGateMode === "disable"
        ? false
        : Boolean(runtime.reviewGateEnabled);
  const latestSuccessfulJob =
    jobs.find((job) => job.status === "completed" && typeof job.claudeSessionId === "string") ??
    null;
  const authFallbackSessionId =
    sessionState?.latestClaudeSessionId ?? latestSuccessfulJob?.claudeSessionId ?? null;
  const authCheck =
    auth.code === 0
      ? {
          ok: true,
          source: "auth-status",
          output: auth.stdout.trim() || auth.stderr.trim(),
        }
      : authFallbackSessionId
        ? {
            ok: true,
            source: sessionState?.latestClaudeSessionId ? "session-state" : "job-history",
            output: `Auth probe failed, but a prior Claude session is recorded (${authFallbackSessionId}).`,
          }
        : {
            ok: false,
            source: "auth-status",
            output: auth.stdout.trim() || auth.stderr.trim(),
          };

  const result = {
    ok: binary.code === 0 && authCheck.ok,
    checks: {
      claudeBinary: { ok: binary.code === 0, output: binary.stdout.trim() || binary.stderr.trim() },
      npm: { ok: npm.code === 0, output: npm.stdout.trim() || npm.stderr.trim() },
      auth: authCheck,
    },
    actions: [],
    nextSteps: [],
    sessionRuntime,
    reviewGateEnabled,
  };

  if (options.reviewGateMode === "enable") {
    result.actions.push("enabled review gate");
  } else if (options.reviewGateMode === "disable") {
    result.actions.push("disabled review gate");
  }

  if (!result.checks.claudeBinary.ok) {
    result.nextSteps.push("Install Claude CLI and ensure `claude` is on PATH.");
  }

  if (!result.checks.npm.ok && !result.checks.claudeBinary.ok) {
    result.nextSteps.push(
      "Install npm if you want setup/install guidance from the command surface.",
    );
  }

  if (!result.checks.auth.ok) {
    result.nextSteps.push("Run `claude auth status` and complete authentication.");
  }

  await writeRuntimeState(
    {
      ...runtime,
      reviewGateEnabled,
      sessionRuntime,
    },
    process.cwd(),
  );

  if (options.json) {
    printJson(result);
    return;
  }

  printText(renderSetup(result));
}

async function handleTask(options) {
  const prompt = (await loadPromptText(options.task)).trim();
  if (!prompt) {
    throw new Error("task requires a prompt");
  }

  const resumeCandidate =
    options.resumeMode === "resume-last" ? await resolveResumeCandidate(process.cwd()) : null;

  if (options.resumeMode === "resume-last" && !resumeCandidate) {
    throw new Error("no resumable task found for the current session");
  }

  const job = await createTrackedJob(
    "task",
    {
      status: options.background ? "queued" : "running",
      prompt,
      mode: options.task.write ? "write" : "read-only",
      background: options.background,
      model: options.task.model,
      effort: options.task.effort,
      promptFile: options.task.promptFile,
      resumeMode: options.resumeMode,
      resumeSourceJobId: resumeCandidate?.id ?? null,
      resumeSessionId: resumeCandidate?.claudeSessionId ?? null,
    },
    process.cwd(),
  );

  await logJobProgress(job, `Task created (${prompt.length} chars).`);

  if (options.background) {
    const detached = spawnDetached(
      process.execPath,
      [getScriptPath(), "task-worker", "--job-id", job.id],
      { cwd: process.cwd() },
    );

    const queuedJob = await updateJob(
      job.id,
      {
        workerPid: detached.pid,
        processGroupId: detached.pid,
        status: "queued",
      },
      process.cwd(),
    );

    if (options.json) {
      printJson({ ok: true, job: queuedJob });
      return;
    }

    printText(`Queued background task ${job.id}.`);
    return;
  }

  const completedJob = await executeTaskJob(job.id, process.cwd());

  if (options.json) {
    printJson({ ok: completedJob.ok, job: completedJob, output: completedJob.rawOutput });
    return;
  }

  printText(completedJob.rawOutput);
}

async function handleTaskWorker(options) {
  if (!options.jobId) {
    throw new Error("task-worker requires a job id");
  }

  const job = await executeTaskJob(options.jobId, process.cwd());

  if (options.json) {
    printJson({ ok: job.ok, job });
    return;
  }
}

async function handleResumeCandidate(options) {
  const candidate = await resolveResumeCandidate(process.cwd());
  if (options.json) {
    printJson({ candidate });
    return;
  }

  printText(candidate ? candidate.id : "none");
}

async function handleStatus(options) {
  if (options.wait && !options.jobId) {
    throw new Error("--wait requires a job id");
  }

  let snapshot;
  let timedOut = false;

  if (options.wait && options.jobId) {
    const waited = await waitForJob(options.jobId, {
      cwd: process.cwd(),
      timeoutMs: options.waitTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    timedOut = waited.timedOut;
  }

  snapshot = await buildStatusSnapshot(process.cwd(), { jobId: options.jobId });

  if (options.json) {
    printJson({ ...snapshot, timedOut });
    return;
  }

  printText(renderStatus(snapshot));
}

async function handleResult(options) {
  const job = options.jobId
    ? await loadJob(options.jobId, process.cwd())
    : await resolveLatestFinishedJob(process.cwd());
  const output = renderResult(job);

  if (options.json) {
    printJson({ job, output });
    return;
  }

  printText(output);
}

async function handleCancel(options) {
  const target = await resolveCancelTarget(process.cwd(), options.jobId);
  const terminated = terminateProcessTree(target.processGroupId ?? target.workerPid ?? null);
  const updated = await updateJob(
    target.id,
    {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      renderedOutput: target.renderedOutput ?? "Job was cancelled.",
      rawOutput: target.rawOutput ?? "Job was cancelled.",
      cancelRequestedAt: new Date().toISOString(),
    },
    process.cwd(),
  );

  if (options.json) {
    printJson({ ok: terminated, job: updated });
    return;
  }

  printText(`Cancelled ${updated.id}.`);
}

async function handleReview(options, kind = "review") {
  if (kind === "review" && options.focusText) {
    throw new Error("review does not accept freeform focus text; use adversarial-review");
  }

  const target = await resolveReviewTarget(
    {
      scope: options.scope,
      baseRef: options.baseRef,
    },
    process.cwd(),
  );
  const context = await collectReviewContext(target, process.cwd());
  const adversarialShape =
    kind === "adversarial-review" ? shapeAdversarialReviewContext(context) : null;
  const prompt =
    kind === "review"
      ? buildReviewPrompt(target, context)
      : buildAdversarialReviewPrompt({
          template: await loadPromptTemplate("adversarial-review.md"),
          target,
          contextMode: adversarialShape.mode,
          contextBody: adversarialShape.body,
          focusText: options.focusText || null,
        });
  const jsonSchema = kind === "adversarial-review" ? await loadStructuredReviewSchema() : null;

  const job = await createTrackedJob(
    kind,
    {
      status: "running",
      scope: target.scope,
      baseRef: target.baseRef,
      focus: options.focusText || null,
      reviewTarget: target,
      reviewContext: context,
      reviewShape: adversarialShape,
    },
    process.cwd(),
  );
  await logJobProgress(job, `Starting ${kind} for ${target.title}.`);

  const reviewRun = await runClaudeTask(
    {
      prompt,
      write: false,
      jsonSchema,
    },
    {
      cwd: process.cwd(),
      onStdout: async (text) => {
        await logJobProgress(job, `stdout: ${text.trim()}`);
      },
      onStderr: async (text) => {
        await logJobProgress(job, `stderr: ${text.trim()}`);
      },
    },
  );

  const success = reviewRun.code === 0 && !reviewRun.parsed?.is_error;
  let renderedStructuredOutput = null;
  if (success && kind === "adversarial-review") {
    const structured = parseStructuredReviewOutput(reviewRun.resultText);
    renderedStructuredOutput = renderStructuredReview(structured);
  }
  const updatedJob = await updateJob(
    job.id,
    {
      status: success ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: reviewRun.code,
      claudeSessionId: reviewRun.sessionId,
      rawOutput: reviewRun.resultText,
      renderedOutput: reviewRun.resultText,
      renderedStructuredOutput,
      rawClaudeResult: reviewRun.parsed ?? null,
    },
    process.cwd(),
  );
  await logJobProgress(job, `rendered-output: ${reviewRun.resultText}`);

  if (options.json) {
    printJson({ ok: success, job: updatedJob, output: updatedJob.rawOutput });
    return;
  }

  printText(updatedJob.rawOutput);
}

const handlers = {
  setup: ({ options }) => handleSetup(options),
  task: ({ options }) => handleTask(options),
  "task-worker": ({ options }) => handleTaskWorker(options),
  "task-resume-candidate": ({ options }) => handleResumeCandidate(options),
  status: ({ options }) => handleStatus(options),
  result: ({ options }) => handleResult(options),
  cancel: ({ options }) => handleCancel(options),
  review: ({ options }) => handleReview(options, "review"),
  "adversarial-review": ({ options }) => handleReview(options, "adversarial-review"),
};

export async function runMain(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const handler = handlers[parsed.subcommand];

  if (!handler) {
    throw new Error(`unknown subcommand: ${parsed.subcommand}`);
  }

  await handler(parsed);
}

export async function main() {
  return runMain(process.argv.slice(2));
}

function isDirectInvocation() {
  const scriptArg = process.argv[1];
  if (!scriptArg) {
    return false;
  }

  return (
    path.basename(scriptArg) === "claude-companion.mjs" &&
    import.meta.url === pathToFileURL(scriptArg).href
  );
}

if (isDirectInvocation()) {
  main().catch((error) => {
    const payload = { ok: false, error: error.message };
    if (process.argv.includes("--json")) {
      printJson(payload);
      process.exitCode = 1;
      return;
    }

    printText(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
