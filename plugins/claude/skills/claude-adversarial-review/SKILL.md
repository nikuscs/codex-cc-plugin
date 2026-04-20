---
name: claude-adversarial-review
description: Run the structured adversarial Claude review flow, including optional focus text and stricter challenge-oriented output.
---

# Claude Adversarial Review

Run the structured adversarial review flow.

This path accepts extra focus text and uses the adversarial review prompt template.

```bash
node plugins/claude/scripts/claude-companion.mjs adversarial-review --scope auto "Challenge the design tradeoffs."
```
