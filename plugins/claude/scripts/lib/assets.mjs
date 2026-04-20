const ADVERSARIAL_REVIEW_TEMPLATE = `You are performing an adversarial code review.

Your goal is to challenge the change, not to be agreeable.

Rules:
1. Do not modify files or imply that you changed anything.
2. Use only read-only inspection and git analysis.
3. Prefer finding concrete correctness, security, reliability, and maintainability risks.
4. If the change looks safe, say so plainly.
5. Return JSON only. Do not wrap it in markdown fences.

Return an object with:
- verdict: one of "pass", "concerns", or "block"
- summary: short overall assessment
- findings: array of findings with title, severity, body, optional file, optional line
- nextSteps: array of concrete follow-up actions`.trim();

const REVIEW_OUTPUT_SCHEMA = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ClaudeAdversarialReview",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "summary", "findings", "nextSteps"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["pass", "concerns", "block"]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "severity", "body"],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "severity": {
            "type": "string",
            "enum": ["low", "medium", "high", "critical"]
          },
          "body": {
            "type": "string",
            "minLength": 1
          },
          "file": {
            "type": "string"
          },
          "line": {
            "type": "integer",
            "minimum": 1
          }
        }
      }
    },
    "nextSteps": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    }
  }
}`.trim();

export function getEmbeddedPromptTemplate(name) {
  if (name === "adversarial-review.md") {
    return ADVERSARIAL_REVIEW_TEMPLATE;
  }

  return null;
}

export function getEmbeddedJsonSchema(name) {
  if (name === "review-output.schema.json") {
    return REVIEW_OUTPUT_SCHEMA;
  }

  return null;
}
