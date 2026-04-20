function normalizeFlagName(flag) {
  return flag.replace(/^--/, "");
}

const BOOLEAN_FLAGS = new Set([
  "background",
  "disable-review-gate",
  "enable-review-gate",
  "fresh",
  "json",
  "resume",
  "resume-last",
  "wait",
  "write",
]);

const JOB_ID_POSITIONAL_COMMANDS = new Set(["cancel", "result", "status", "task-worker"]);

export function splitRawArgumentString(raw) {
  const parts = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;

  for (const match of raw.matchAll(pattern)) {
    parts.push((match[1] ?? match[2] ?? match[0]).replace(/\\(["'])/g, "$1"));
  }

  return parts;
}

export function extractExecutionMode(flags) {
  return flags.background ? "background" : "foreground";
}

export function extractBaseRef(flags) {
  return flags.base ?? null;
}

export function extractResumeMode(flags) {
  if (flags.fresh && (flags.resume || flags["resume-last"])) {
    throw new Error("cannot combine --fresh with --resume or --resume-last");
  }

  if (flags.fresh) {
    return "fresh";
  }

  if (flags.resume || flags["resume-last"]) {
    return "resume-last";
  }

  return null;
}

export function extractTaskText(positionals) {
  return positionals.join(" ").trim();
}

export function extractTaskOptions(flags) {
  return {
    write: Boolean(flags.write),
    model: typeof flags.model === "string" ? flags.model : null,
    effort: typeof flags.effort === "string" ? flags.effort : null,
    promptFile: typeof flags["prompt-file"] === "string" ? flags["prompt-file"] : null,
  };
}

export function parseArgs(argv) {
  const normalizedArgv =
    argv.length === 1 && typeof argv[0] === "string" && argv[0].includes(" ")
      ? splitRawArgumentString(argv[0])
      : [...argv];

  const [subcommand = "status", ...rest] = normalizedArgv;
  const flags = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }

    const key = normalizeFlagName(item);
    const next = rest[index + 1];

    if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  const jobId =
    typeof flags["job-id"] === "string"
      ? flags["job-id"]
      : JOB_ID_POSITIONAL_COMMANDS.has(subcommand) && positionals.length
        ? positionals[0]
        : null;

  const remainingPositionals =
    jobId && JOB_ID_POSITIONAL_COMMANDS.has(subcommand) && positionals[0] === jobId
      ? positionals.slice(1)
      : positionals;

  const options = {
    json: Boolean(flags.json),
    jobId,
    wait: Boolean(flags.wait),
    waitTimeoutMs: Number(flags["wait-timeout-ms"] ?? flags["timeout-ms"] ?? 30_000),
    pollIntervalMs: Number(flags["poll-interval-ms"] ?? 250),
    executionMode: extractExecutionMode(flags),
    background: Boolean(flags.background),
    resumeMode: extractResumeMode(flags),
    scope: typeof flags.scope === "string" ? flags.scope : "auto",
    baseRef: extractBaseRef(flags),
    reviewGateMode: flags["enable-review-gate"]
      ? "enable"
      : flags["disable-review-gate"]
        ? "disable"
        : null,
    task: {
      ...extractTaskOptions(flags),
      text: extractTaskText(remainingPositionals),
    },
    focusText: extractTaskText(remainingPositionals),
    remainingPositionals,
  };

  return {
    subcommand,
    flags,
    positionals: remainingPositionals,
    options,
    rawArgs: normalizedArgv,
  };
}
