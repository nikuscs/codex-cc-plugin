import path from "node:path";

import { getCurrentCodexSessionId, readRuntimeState, ensureWorkspaceState } from "./state.mjs";
import { appendLog, isProcessRunning, sleep, terminateProcessTree } from "./process.mjs";
import { createJobId, deleteJob, listJobs, loadJob, saveJob, updateJob } from "./tracked-jobs.mjs";

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

export async function createTrackedJob(kind, extra = {}, cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  const job = {
    id: createJobId(kind),
    kind,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    codexSessionId: getCurrentCodexSessionId(),
    logFile: path.join(workspace.logsDir, `${createJobId(kind)}.log`),
    ...extra,
  };

  job.logFile = path.join(workspace.logsDir, `${job.id}.log`);
  await saveJob(job, cwd);
  return job;
}

export async function logJobProgress(job, message) {
  if (!job?.logFile) {
    return;
  }

  const line = `[${new Date().toISOString()}] ${message}\n`;
  await appendLog(job.logFile, line);
}

export async function reconcileJobState(job, cwd = process.cwd()) {
  if (!job || !isActiveStatus(job.status)) {
    return job;
  }

  const processId = job.processGroupId ?? job.workerPid ?? null;
  if (processId && !isProcessRunning(processId)) {
    return updateJob(
      job.id,
      {
        status: job.status === "queued" ? "failed" : "failed",
        renderedOutput: job.renderedOutput ?? "Job terminated unexpectedly.",
        rawOutput: job.rawOutput ?? "Job terminated unexpectedly.",
      },
      cwd,
    );
  }

  return job;
}

export async function reconcileJobs(cwd = process.cwd()) {
  const jobs = await listJobs(cwd);
  await Promise.all(jobs.map((job) => reconcileJobState(job, cwd)));
}

export async function getVisibleJobs(cwd = process.cwd(), sessionId = getCurrentCodexSessionId()) {
  await reconcileJobs(cwd);
  if (!sessionId) {
    return listJobs(cwd);
  }

  return listJobs(cwd, { codexSessionId: sessionId });
}

export async function resolveResumeCandidate(
  cwd = process.cwd(),
  sessionId = getCurrentCodexSessionId(),
) {
  const jobs = await getVisibleJobs(cwd, sessionId);
  return (
    jobs.find(
      (job) =>
        job.kind === "task" &&
        !isActiveStatus(job.status) &&
        typeof job.claudeSessionId === "string" &&
        job.claudeSessionId.length > 0,
    ) ?? null
  );
}

export async function resolveLatestFinishedJob(
  cwd = process.cwd(),
  sessionId = getCurrentCodexSessionId(),
) {
  const jobs = await getVisibleJobs(cwd, sessionId);
  return jobs.find((job) => !isActiveStatus(job.status)) ?? null;
}

export async function resolveCancelTarget(
  cwd = process.cwd(),
  jobId = null,
  sessionId = getCurrentCodexSessionId(),
) {
  if (jobId) {
    const explicit = await loadJob(jobId, cwd);
    if (!explicit) {
      throw new Error("job not found");
    }

    if (!isActiveStatus(explicit.status)) {
      throw new Error("job is not active");
    }

    return explicit;
  }

  const jobs = await getVisibleJobs(cwd, sessionId);
  const activeJobs = jobs.filter((job) => isActiveStatus(job.status));

  if (activeJobs.length === 0) {
    throw new Error("no active current-session jobs");
  }

  if (activeJobs.length > 1) {
    throw new Error("multiple active current-session jobs");
  }

  return activeJobs[0];
}

export async function waitForJob(
  jobId,
  { cwd = process.cwd(), timeoutMs = 30_000, pollIntervalMs = 250 } = {},
) {
  const startedAt = Date.now();
  let job = await loadJob(jobId, cwd);

  while (job && isActiveStatus(job.status) && Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    job = await loadJob(jobId, cwd);
  }

  return {
    job,
    timedOut: Boolean(job && isActiveStatus(job.status)),
  };
}

export async function buildStatusSnapshot(
  cwd = process.cwd(),
  { jobId = null, sessionId = getCurrentCodexSessionId() } = {},
) {
  const visibleJobs = await getVisibleJobs(cwd, sessionId);
  const activeJobs = visibleJobs.filter((job) => isActiveStatus(job.status));
  const latestFinished = visibleJobs.find((job) => !isActiveStatus(job.status)) ?? null;
  const recentJobs = visibleJobs.slice(0, 10);
  const runtime = await readRuntimeState(cwd);
  const resumeCandidate = await resolveResumeCandidate(cwd, sessionId);
  const job = jobId ? await loadJob(jobId, cwd) : null;

  return {
    sessionRuntime: runtime.sessionRuntime ?? null,
    reviewGateEnabled: Boolean(runtime.reviewGateEnabled),
    activeJobs,
    latestFinished,
    recentJobs,
    resumeCandidate,
    job,
  };
}

export async function cleanupSessionJobs(
  sessionId = getCurrentCodexSessionId(),
  cwd = process.cwd(),
) {
  if (!sessionId) {
    return { cleanedJobIds: [], killedJobIds: [] };
  }

  const jobs = await listJobs(cwd, { codexSessionId: sessionId });
  const killedJobIds = [];

  for (const job of jobs) {
    if (isActiveStatus(job.status)) {
      const killed = terminateProcessTree(job.processGroupId ?? job.workerPid ?? null);
      if (killed) {
        killedJobIds.push(job.id);
      }
    }
  }

  for (const job of jobs) {
    await deleteJob(job.id, cwd);
  }

  return {
    cleanedJobIds: jobs.map((job) => job.id),
    killedJobIds,
  };
}
