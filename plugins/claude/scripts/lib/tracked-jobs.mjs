import fs from "node:fs/promises";
import path from "node:path";

import { ensureWorkspaceState, readJson, writeJson } from "./state.mjs";

const MAX_FINISHED_JOBS = 50;

export function createJobId(kind) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${kind}-${stamp}-${suffix}`;
}

async function pruneFinishedJobs(cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  const names = await fs.readdir(workspace.jobsDir);
  const jobs = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readJson(path.join(workspace.jobsDir, name), null)),
  );

  const finishedJobs = jobs
    .filter((job) => job && !["queued", "running"].includes(job.status))
    .sort((left, right) => {
      const a = left.updatedAt ?? left.createdAt ?? "";
      const b = right.updatedAt ?? right.createdAt ?? "";
      return a < b ? 1 : a > b ? -1 : 0;
    });

  for (const job of finishedJobs.slice(MAX_FINISHED_JOBS)) {
    try {
      await fs.rm(path.join(workspace.jobsDir, `${job.id}.json`), { force: true });
      if (job.logFile) {
        await fs.rm(job.logFile, { force: true });
      }
    } catch {
      // Best-effort pruning only.
    }
  }
}

export async function saveJob(job, cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  const file = path.join(workspace.jobsDir, `${job.id}.json`);
  await writeJson(file, job);
  await pruneFinishedJobs(cwd);
  return file;
}

export async function loadJob(jobId, cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  return readJson(path.join(workspace.jobsDir, `${jobId}.json`), null);
}

export async function listJobs(cwd = process.cwd(), filters = {}) {
  const workspace = await ensureWorkspaceState(cwd);
  const names = await fs.readdir(workspace.jobsDir);
  const jobs = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readJson(path.join(workspace.jobsDir, name), null)),
  );

  return jobs
    .filter(Boolean)
    .filter((job) => {
      if (filters.kind && job.kind !== filters.kind) {
        return false;
      }

      if (filters.codexSessionId && job.codexSessionId !== filters.codexSessionId) {
        return false;
      }

      if (filters.statuses && !filters.statuses.includes(job.status)) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      const a = left.updatedAt ?? left.createdAt ?? "";
      const b = right.updatedAt ?? right.createdAt ?? "";
      return a < b ? 1 : a > b ? -1 : 0;
    });
}

export async function updateJob(jobId, patch, cwd = process.cwd()) {
  const current = await loadJob(jobId, cwd);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await saveJob(next, cwd);
  return next;
}

export async function deleteJob(jobId, cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  const job = await loadJob(jobId, cwd);
  await fs.rm(path.join(workspace.jobsDir, `${jobId}.json`), { force: true });
  if (job?.logFile) {
    await fs.rm(job.logFile, { force: true });
  }
}
