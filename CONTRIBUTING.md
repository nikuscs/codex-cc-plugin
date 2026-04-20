# Contributing

Thanks for contributing.

## Development

Requirements:

- Node.js 18.18+
- Bun
- Claude CLI installed for runtime smoke tests

Install dependencies:

```bash
bun install
```

Run the full check suite:

```bash
bun run check
```

That runs:

- `oxlint`
- `oxfmt --check`
- `node --test tests/runtime.test.mjs`

## Plugin development

The Codex plugin bundle lives in `plugins/claude`.

For local testing in Codex CLI:

```bash
codex marketplace add nikuscs/codex-cc-plugin
```

For direct runtime testing from this repo:

```bash
node plugins/claude/scripts/claude-companion.mjs setup
```

## Pull requests

- Keep changes focused.
- Update docs when install, behavior, or UX changes.
- Add or update tests when behavior changes.
- Do not commit secrets, auth tokens, or local machine state.

## Reporting issues

When filing a bug, include:

- Codex version
- Claude CLI version
- OS
- exact command or skill invoked
- actual output
- expected output
