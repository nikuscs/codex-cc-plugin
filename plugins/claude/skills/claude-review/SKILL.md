---
name: claude-review
description: Run a read-only Claude review for the current repository using auto, working-tree, branch, or explicit base-ref scope.
---

# Claude Review

Run a read-only repository review using Claude.

Allowed review scopes:

1. `auto`
2. `working-tree`
3. `branch`
4. `--base <ref>`

Do not pass extra freeform focus text to this flow. Use adversarial review for that.

```bash
node plugins/claude/scripts/claude-companion.mjs review --scope auto
```
