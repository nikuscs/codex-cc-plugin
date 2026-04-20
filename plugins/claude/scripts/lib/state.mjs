import fs from "node:fs/promises";
import path from "node:path";

import { getWorkspaceDescriptor } from "./workspace.mjs";

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function getCurrentCodexSessionId() {
  return process.env.CODEX_THREAD_ID ?? null;
}

export async function ensureWorkspaceState(cwd = process.cwd()) {
  const workspace = getWorkspaceDescriptor(cwd);
  await ensureDir(workspace.stateRoot);
  await ensureDir(workspace.jobsDir);
  await ensureDir(workspace.logsDir);
  await ensureDir(workspace.sessionsDir);

  const summary = {
    root: workspace.root,
    slug: workspace.slug,
    initializedAt: new Date().toISOString(),
  };

  try {
    await fs.access(workspace.workspaceFile);
  } catch {
    await writeJson(workspace.workspaceFile, summary);
  }

  return workspace;
}

export async function readJson(file, fallback = null) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.name === "SyntaxError")) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readRuntimeState(cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  return (await readJson(workspace.runtimeFile, {})) ?? {};
}

export async function writeRuntimeState(value, cwd = process.cwd()) {
  const workspace = await ensureWorkspaceState(cwd);
  await writeJson(workspace.runtimeFile, value);
  return workspace.runtimeFile;
}

export async function readSessionState(
  sessionId = getCurrentCodexSessionId(),
  cwd = process.cwd(),
) {
  if (!sessionId) {
    return null;
  }

  const workspace = await ensureWorkspaceState(cwd);
  return readJson(path.join(workspace.sessionsDir, `${sessionId}.json`), null);
}

export async function writeSessionState(
  sessionId = getCurrentCodexSessionId(),
  value,
  cwd = process.cwd(),
) {
  if (!sessionId) {
    return null;
  }

  const workspace = await ensureWorkspaceState(cwd);
  const file = path.join(workspace.sessionsDir, `${sessionId}.json`);
  await writeJson(file, value);
  return file;
}

export async function updateSessionState(
  sessionId = getCurrentCodexSessionId(),
  patch,
  cwd = process.cwd(),
) {
  if (!sessionId) {
    return null;
  }

  const current = (await readSessionState(sessionId, cwd)) ?? {};
  const next = {
    ...current,
    ...patch,
    codexSessionId: sessionId,
    updatedAt: new Date().toISOString(),
  };

  await writeSessionState(sessionId, next, cwd);
  return next;
}

export async function deleteSessionState(
  sessionId = getCurrentCodexSessionId(),
  cwd = process.cwd(),
) {
  if (!sessionId) {
    return;
  }

  const workspace = await ensureWorkspaceState(cwd);
  await fs.rm(path.join(workspace.sessionsDir, `${sessionId}.json`), { force: true });
}
