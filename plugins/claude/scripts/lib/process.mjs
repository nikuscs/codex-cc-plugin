import fs from "node:fs/promises";
import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 0, signal, stdout, stderr, pid: child.pid ?? null });
    });

    child.on("error", (error) => {
      resolve({ code: 1, signal: null, stdout, stderr: String(error), pid: child.pid ?? null });
    });
  });
}

export function runCommandStreaming(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    options.onSpawn?.(child);
    let timedOut = false;
    let timeoutHandle = null;

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, options.timeoutMs);
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("close", (code, signal) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({ code: code ?? 0, signal, stdout, stderr, pid: child.pid ?? null, timedOut });
    });

    child.on("error", (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({
        code: 1,
        signal: null,
        stdout,
        stderr: String(error),
        pid: child.pid ?? null,
        timedOut,
      });
    });
  });
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  return { pid: child.pid ?? null };
}

export async function appendLog(file, text) {
  await fs.appendFile(file, text, "utf8");
}

export function isProcessRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!pid) {
    return false;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
