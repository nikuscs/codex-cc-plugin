---
name: claude-rescue
description: Delegate a substantial task to Claude CLI, optionally in the background, and track the resulting Claude job.
---

# Claude Rescue

Delegate a substantial task to Claude CLI through the shared runtime.

Examples:

```bash
node plugins/claude/scripts/claude-companion.mjs task --write "Implement the requested change."
node plugins/claude/scripts/claude-companion.mjs task --background --write "Refactor this module."
```
