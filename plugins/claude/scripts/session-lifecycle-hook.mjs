#!/usr/bin/env node

import { cleanupSessionJobs } from "./lib/job-control.mjs";
import {
  deleteSessionState,
  getCurrentCodexSessionId,
  readRuntimeState,
  updateSessionState,
  writeRuntimeState,
} from "./lib/state.mjs";

async function main() {
  const phase = process.argv[2] ?? "SessionStart";
  const sessionId = getCurrentCodexSessionId();
  const runtime = await readRuntimeState();
  const timestamp = new Date().toISOString();

  if (phase === "SessionStart" || phase === "start") {
    await updateSessionState(sessionId, {
      startedAt: timestamp,
      lastLifecyclePhase: "SessionStart",
    });

    await writeRuntimeState({
      ...runtime,
      sessionRuntime: {
        ...(runtime.sessionRuntime ?? {}),
        mode: runtime.sessionRuntime?.mode ?? "direct-cli",
        endpoint: runtime.sessionRuntime?.endpoint ?? "local-cli",
        codexSessionId: sessionId,
      },
      lastLifecyclePhase: "SessionStart",
      lastLifecycleAt: timestamp,
    });
  } else if (phase === "SessionEnd" || phase === "end") {
    await cleanupSessionJobs(sessionId);
    await deleteSessionState(sessionId);
    await writeRuntimeState({
      ...runtime,
      lastLifecyclePhase: "SessionEnd",
      lastLifecycleAt: timestamp,
    });
  } else {
    throw new Error(`unknown lifecycle phase: ${phase}`);
  }

  process.stdout.write("{}\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
