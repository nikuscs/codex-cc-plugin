import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./process.mjs";

const VALID_SCOPES = new Set(["auto", "working-tree", "branch"]);
export const MAX_INLINE_FILES = 2;
export const MAX_INLINE_DIFF_BYTES = 256 * 1024;

async function runGit(args, cwd = process.cwd()) {
  return runCommand("git", args, { cwd });
}

function trimOutput(result) {
  return result.stdout.trim() || result.stderr.trim();
}

function extractUntrackedFiles(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function collectSafeUntrackedContents(files, cwd = process.cwd()) {
  const entries = [];

  for (const file of files) {
    try {
      const fullPath = path.join(cwd, file);
      const content = await fs.readFile(fullPath, "utf8");
      if (Buffer.byteLength(content, "utf8") <= 16 * 1024) {
        entries.push({ file, content });
      }
    } catch {
      // Skip unreadable or non-text files.
    }
  }

  return entries;
}

async function refExists(ref, cwd = process.cwd()) {
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], cwd);
  return result.code === 0;
}

export async function detectDefaultBaseRef(cwd = process.cwd()) {
  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  const originHeadRef = trimOutput(originHead);
  if (originHead.code === 0 && originHeadRef) {
    return originHeadRef;
  }

  for (const ref of ["main", "master", "trunk"]) {
    if (await refExists(ref, cwd)) {
      return ref;
    }
  }

  for (const ref of ["origin/main", "origin/master", "origin/trunk"]) {
    if (await refExists(ref, cwd)) {
      return ref;
    }
  }

  throw new Error("could not detect default branch");
}

export async function isRepoDirty(cwd = process.cwd()) {
  const result = await runGit(["status", "--porcelain"], cwd);
  return trimOutput(result).length > 0;
}

export async function resolveReviewTarget({ scope = "auto", baseRef = null }, cwd = process.cwd()) {
  if (baseRef) {
    return {
      scope: "base",
      targetKind: "branch",
      baseRef,
      title: `branch review against ${baseRef}`,
    };
  }

  if (!VALID_SCOPES.has(scope)) {
    throw new Error(
      "invalid review scope: use one of `auto`, `working-tree`, `branch`, or pass `--base <ref>`",
    );
  }

  if (scope === "working-tree") {
    return {
      scope,
      targetKind: "working-tree",
      baseRef: null,
      title: "working tree review",
    };
  }

  if (scope === "branch") {
    const detectedBaseRef = await detectDefaultBaseRef(cwd);
    return {
      scope,
      targetKind: "branch",
      baseRef: detectedBaseRef,
      title: `branch review against ${detectedBaseRef}`,
    };
  }

  if (await isRepoDirty(cwd)) {
    return {
      scope: "working-tree",
      targetKind: "working-tree",
      baseRef: null,
      title: "working tree review",
    };
  }

  const detectedBaseRef = await detectDefaultBaseRef(cwd);
  return {
    scope: "branch",
    targetKind: "branch",
    baseRef: detectedBaseRef,
    title: `branch review against ${detectedBaseRef}`,
  };
}

export async function collectReviewContext(target, cwd = process.cwd()) {
  if (target.targetKind === "working-tree") {
    const [status, stagedStat, stagedDiff, unstagedStat, unstagedDiff, stagedFiles, unstagedFiles] =
      await Promise.all([
        runGit(["status", "--short"], cwd),
        runGit(["diff", "--cached", "--stat"], cwd),
        runGit(["diff", "--cached"], cwd),
        runGit(["diff", "--stat"], cwd),
        runGit(["diff"], cwd),
        runGit(["diff", "--cached", "--name-only"], cwd),
        runGit(["diff", "--name-only"], cwd),
      ]);
    const statusText = trimOutput(status);
    const untrackedFiles = extractUntrackedFiles(statusText);
    const untrackedFileContents = await collectSafeUntrackedContents(untrackedFiles, cwd);

    return {
      mode: "working-tree",
      status: statusText,
      stagedStat: trimOutput(stagedStat),
      stagedDiff: trimOutput(stagedDiff),
      unstagedStat: trimOutput(unstagedStat),
      unstagedDiff: trimOutput(unstagedDiff),
      changedFiles: Array.from(
        new Set(
          `${trimOutput(stagedFiles)}\n${trimOutput(unstagedFiles)}\n${untrackedFiles.join("\n")}`
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ),
      untrackedFiles,
      untrackedFileContents,
    };
  }

  const baseRef = target.baseRef;
  const [log, diffStat, diff, changedFiles] = await Promise.all([
    runGit(["log", "--oneline", `${baseRef}..HEAD`], cwd),
    runGit(["diff", "--stat", `${baseRef}...HEAD`], cwd),
    runGit(["diff", `${baseRef}...HEAD`], cwd),
    runGit(["diff", "--name-only", `${baseRef}...HEAD`], cwd),
  ]);

  return {
    mode: "branch",
    baseRef,
    commitLog: trimOutput(log),
    diffStat: trimOutput(diffStat),
    diff: trimOutput(diff),
    changedFiles: trimOutput(changedFiles)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function diffByteLength(context) {
  return Buffer.byteLength(
    context.mode === "working-tree"
      ? `${context.stagedDiff}\n${context.unstagedDiff}`
      : context.diff,
    "utf8",
  );
}

export function shapeAdversarialReviewContext(context) {
  const fileCount = context.changedFiles.length;
  const diffBytes = diffByteLength(context);
  const shouldInline = fileCount <= MAX_INLINE_FILES && diffBytes <= MAX_INLINE_DIFF_BYTES;

  if (shouldInline) {
    return {
      mode: "inline",
      fileCount,
      diffBytes,
      body:
        context.mode === "working-tree"
          ? [
              "Git status:",
              context.status || "(clean)",
              "",
              "Staged diff stat:",
              context.stagedStat || "(none)",
              "",
              "Staged diff:",
              context.stagedDiff || "(none)",
              "",
              "Unstaged diff stat:",
              context.unstagedStat || "(none)",
              "",
              "Unstaged diff:",
              context.unstagedDiff || "(none)",
              "",
              "Untracked file contents:",
              context.untrackedFileContents?.length
                ? context.untrackedFileContents
                    .map((entry) => `--- ${entry.file}\n${entry.content}`)
                    .join("\n\n")
                : "(none)",
            ].join("\n")
          : [
              `Base ref: ${context.baseRef}`,
              "",
              "Commit log:",
              context.commitLog || "(none)",
              "",
              "Diff stat:",
              context.diffStat || "(none)",
              "",
              "Branch diff:",
              context.diff || "(none)",
            ].join("\n"),
    };
  }

  return {
    mode: "self-collect",
    fileCount,
    diffBytes,
    body:
      context.mode === "working-tree"
        ? [
            "Git status:",
            context.status || "(clean)",
            "",
            "Changed files:",
            context.changedFiles.join("\n") || "(none)",
            "",
            "Untracked files:",
            context.untrackedFiles?.join("\n") || "(none)",
            "",
            "Staged diff stat:",
            context.stagedStat || "(none)",
            "",
            "Unstaged diff stat:",
            context.unstagedStat || "(none)",
          ].join("\n")
        : [
            `Base ref: ${context.baseRef}`,
            "",
            "Changed files:",
            context.changedFiles.join("\n") || "(none)",
            "",
            "Commit log:",
            context.commitLog || "(none)",
            "",
            "Diff stat:",
            context.diffStat || "(none)",
          ].join("\n"),
  };
}

export function validateStructuredReviewOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("structured review output must be an object");
  }
  if (!["pass", "concerns", "block"].includes(output.verdict)) {
    throw new Error("structured review output missing valid verdict");
  }
  if (typeof output.summary !== "string" || output.summary.trim() === "") {
    throw new Error("structured review output missing summary");
  }
  if (!Array.isArray(output.findings)) {
    throw new Error("structured review output missing findings");
  }
  for (const finding of output.findings) {
    if (!finding || typeof finding !== "object") {
      throw new Error("structured review finding must be an object");
    }
    if (typeof finding.title !== "string" || finding.title.trim() === "") {
      throw new Error("structured review finding missing title");
    }
    if (!["low", "medium", "high", "critical"].includes(finding.severity)) {
      throw new Error("structured review finding missing severity");
    }
    if (typeof finding.body !== "string" || finding.body.trim() === "") {
      throw new Error("structured review finding missing body");
    }
  }
  if (!Array.isArray(output.nextSteps)) {
    throw new Error("structured review output missing nextSteps");
  }
  for (const step of output.nextSteps) {
    if (typeof step !== "string" || step.trim() === "") {
      throw new Error("structured review output contains invalid nextSteps");
    }
  }
  return output;
}

function normalizeVerdict(verdict) {
  if (verdict === "request-changes") {
    return "block";
  }
  if (verdict === "request_changes") {
    return "block";
  }
  if (verdict === "approve") {
    return "pass";
  }
  if (verdict === "warn") {
    return "concerns";
  }
  return verdict;
}

function normalizeSeverity(severity) {
  if (severity === "info") {
    return "low";
  }
  return severity;
}

function parseLocation(location) {
  if (typeof location !== "string" || location.trim() === "") {
    return {};
  }

  const match = location.match(/^(.+?):(\d+)$/);
  if (!match) {
    return { file: location };
  }

  return {
    file: match[1],
    line: Number(match[2]),
  };
}

function normalizeStructuredReviewShape(output) {
  const rawVerdict =
    output.verdict ??
    output.recommendation ??
    (output.blocking === true
      ? "block"
      : output.blocking === false
        ? "concerns"
        : Array.isArray(output.findings) && output.findings.length > 0
          ? "concerns"
          : "pass");
  const normalized = {
    verdict: normalizeVerdict(rawVerdict),
    summary: output.summary,
    findings: Array.isArray(output.findings)
      ? output.findings.map((finding) => ({
          title: finding.title ?? finding.id ?? finding.issue ?? "Finding",
          severity: normalizeSeverity(finding.severity),
          body:
            finding.body ??
            finding.issue ??
            finding.challenge ??
            finding.recommendation ??
            "No body provided.",
          ...parseLocation(finding.location ?? finding.file),
          ...(typeof finding.line === "number" ? { line: finding.line } : {}),
        }))
      : [],
    nextSteps: Array.isArray(output.nextSteps)
      ? output.nextSteps
      : Array.isArray(output.recommended_actions)
        ? output.recommended_actions
        : Array.isArray(output.required_before_merge)
          ? output.required_before_merge
          : Array.isArray(output.blocking_questions)
            ? output.blocking_questions
            : Array.isArray(output.blockers) && output.blockers.length
              ? output.blockers
              : output.recommendation
                ? [output.recommendation]
                : [],
  };

  return normalized;
}

export function parseStructuredReviewOutput(text) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1].trim() : trimmed;
  return validateStructuredReviewOutput(normalizeStructuredReviewShape(JSON.parse(jsonText)));
}
