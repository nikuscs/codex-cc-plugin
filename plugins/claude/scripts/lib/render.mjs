function formatJobLine(job) {
  return `- ${job.id} ${job.kind} ${job.status}`;
}

export function renderSetup(result) {
  const lines = [];
  lines.push("status:");
  lines.push(`  overall: ${result.ok ? "ready" : "needs-attention"}`);
  lines.push("checks:");
  lines.push(`  claude binary: ${result.checks.claudeBinary.ok ? "ok" : "missing"}`);
  lines.push(`  npm: ${result.checks.npm.ok ? "ok" : "missing"}`);
  lines.push(
    `  claude auth: ${result.checks.auth.ok ? "ok" : "missing"} (${result.checks.auth.source})`,
  );
  lines.push(
    `  session runtime: ${result.sessionRuntime.mode} (${result.sessionRuntime.endpoint})`,
  );
  lines.push(`  review gate: ${result.reviewGateEnabled ? "enabled" : "disabled"}`);
  lines.push("actions taken:");
  if (result.actions.length) {
    for (const action of result.actions) {
      lines.push(`  - ${action}`);
    }
  } else {
    lines.push("  - none");
  }
  lines.push("next steps:");
  if (result.nextSteps.length) {
    for (const step of result.nextSteps) {
      lines.push(`  - ${step}`);
    }
  } else {
    lines.push("  - none");
  }
  return lines.join("\n");
}

export function renderStatus(snapshot) {
  const lines = [];
  lines.push("session runtime:");
  lines.push(
    `  ${snapshot.sessionRuntime?.mode ?? "unknown"} (${snapshot.sessionRuntime?.endpoint ?? "unknown"})`,
  );
  lines.push("review gate:");
  lines.push(`  ${snapshot.reviewGateEnabled ? "enabled" : "disabled"}`);
  lines.push("active jobs:");
  if (snapshot.activeJobs.length) {
    for (const job of snapshot.activeJobs) {
      lines.push(formatJobLine(job));
    }
  } else {
    lines.push("- none");
  }
  if (snapshot.job) {
    lines.push("live details:");
    lines.push(`- ${snapshot.job.id} ${snapshot.job.kind} ${snapshot.job.status}`);
  }
  lines.push("latest finished:");
  lines.push(snapshot.latestFinished ? formatJobLine(snapshot.latestFinished) : "- none");
  lines.push("recent jobs:");
  if (snapshot.recentJobs.length) {
    for (const job of snapshot.recentJobs) {
      lines.push(formatJobLine(job));
    }
  } else {
    lines.push("- none");
  }
  if (snapshot.resumeCandidate) {
    lines.push("resume hint:");
    lines.push(`- resume available from ${snapshot.resumeCandidate.id}`);
  }
  if (snapshot.reviewGateEnabled) {
    lines.push("stop gate reminder:");
    lines.push("- stop-time Claude review gate is enabled");
  }
  return lines.join("\n");
}

function selectStoredOutput(job) {
  if (!job) {
    return "No finished Claude job found.";
  }

  if (job.renderedStructuredOutput) {
    return job.renderedStructuredOutput;
  }

  if (job.rawOutput) {
    return job.rawOutput;
  }

  if (job.renderedOutput) {
    return job.renderedOutput;
  }

  return JSON.stringify(
    {
      id: job.id,
      kind: job.kind,
      status: job.status,
    },
    null,
    2,
  );
}

export function renderStructuredReview(output) {
  const lines = [`verdict: ${output.verdict}`, "", output.summary];

  if (output.findings.length) {
    lines.push("", "findings:");
    for (const finding of output.findings) {
      const location =
        finding.file && finding.line
          ? ` (${finding.file}:${finding.line})`
          : finding.file
            ? ` (${finding.file})`
            : "";
      lines.push(`- [${finding.severity}] ${finding.title}${location}`);
      lines.push(`  ${finding.body}`);
    }
  }

  if (output.nextSteps.length) {
    lines.push("", "next steps:");
    for (const step of output.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function renderResult(job) {
  const body = selectStoredOutput(job);
  if (!job?.claudeSessionId) {
    return body;
  }

  return `${body}\n\nResume hint: claude -r ${job.claudeSessionId} -p "<prompt>"`;
}
