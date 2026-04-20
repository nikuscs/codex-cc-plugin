import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEmbeddedPromptTemplate } from "./assets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(here, "..", "..", "prompts");

export async function loadPromptTemplate(name) {
  try {
    return await fs.readFile(path.join(promptsDir, name), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      const embedded = getEmbeddedPromptTemplate(name);
      if (embedded) {
        return embedded;
      }
    }

    throw error;
  }
}

export function buildReviewPrompt(target, context) {
  const sections = [
    "You are performing a read-only code review.",
    "",
    "Rules:",
    "1. Do not modify files or suggest that you changed anything.",
    "2. Use only read-only inspection and git analysis.",
    "3. Focus on correctness, regressions, and maintainability risks.",
    "4. Return the review findings directly without extra framing.",
    "",
    `Review target: ${target.title}`,
  ];

  if (context.mode === "working-tree") {
    sections.push(
      "",
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
    );
  } else {
    sections.push(
      "",
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
    );
  }

  return sections.join("\n");
}

export function buildAdversarialReviewPrompt({
  template,
  target,
  contextMode,
  contextBody,
  focusText,
}) {
  const sections = [template.trim(), "", `Review target: ${target.title}`];

  if (focusText) {
    sections.push("", "Extra focus:", focusText);
  }

  if (contextMode === "inline") {
    sections.push("", "Inline review context:", contextBody);
  } else {
    sections.push(
      "",
      "Repository summary:",
      contextBody,
      "",
      "The review context exceeds the inline threshold.",
      "Inspect the target diff yourself with read-only git commands only.",
    );
  }

  return sections.join("\n");
}
