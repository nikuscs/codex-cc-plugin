# Claude Plugin

This plugin mirrors the core `codex-plugin-cc` workflow in the opposite direction:
Codex can call Claude CLI for setup checks, task delegation, review, status, result retrieval,
and cancellation.

## Install

You do not need the official Codex marketplace.

People are mainly distributing Codex plugins in two ways:

1. Codex CLI marketplace install: `codex marketplace add owner/repo`
2. Repo-local: clone the repo and let Codex read `.agents/plugins/marketplace.json`
3. Personal install: copy or clone the plugin under your home directory and add it to `~/.agents/plugins/marketplace.json`

### Option 1. Codex app install

```bash
codex marketplace add nikuscs/codex-cc-plugin
```

This is the simplest install path for Codex app.

### Option 2. Codex CLI command

Install the standalone CLI command:

```bash
curl -fsSL https://raw.githubusercontent.com/nikuscs/codex-cc-plugin/main/scripts/install.sh | bash
```

Then use it in Codex CLI as a shell command:

```text
!ccx setup
!ccx review
```

### Option 3. Repo-local install

```bash
git clone https://github.com/nikuscs/codex-cc-plugin.git
cd codex-cc-plugin
```

Then open the repo in Codex and install or enable the `claude` plugin from the local marketplace.

### Option 4. Personal install

```bash
mkdir -p ~/.codex/plugins ~/.agents/plugins
git clone https://github.com/nikuscs/codex-cc-plugin.git ~/.codex/plugins/codex-cc-plugin
```

Create or update `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal Plugins"
  },
  "plugins": [
    {
      "name": "claude",
      "source": {
        "source": "local",
        "path": "./plugins/codex-cc-plugin/plugins/claude"
      },
      "policy": {
        "installation": "INSTALLED_BY_DEFAULT",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
```

Then restart Codex.

### Verify

After install, Codex should expose the Claude command surfaces in the slash-command picker.

In the Codex app they may appear with the plugin name prefixed, for example:

- `/Claude:claude Setup`
- `/Claude:claude Review`
- `/Claude:claude Adversarial Review`
- `/Claude:claude Rescue`
- `/Claude:claude Status`
- `/Claude:claude Result`
- `/Claude:claude Cancel`

Look for:

- `claude-setup`
- `claude-review`
- `claude-adversarial-review`
- `claude-rescue`
- `claude-status`
- `claude-result`
- `claude-cancel`

Then run:

```text
Use the skill claude-setup
```

If Codex runs the command or skill instead of searching for `SKILL.md`, the plugin is installed correctly.

In Codex CLI, use the standalone binary instead:

```text
!ccx setup
```

## Current status

The runtime is implemented and locally installable. The main remaining rough edges are packaging polish and Codex hook UX.

## Credits

- Original inspiration: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- Adapted here as a Codex-to-Claude companion surface.

## Runtime

The shared runtime lives at `plugins/claude/scripts/claude-companion.mjs`.

Implemented subcommands:

1. `setup`
2. `task`
3. `task-worker`
4. `task-resume-candidate`
5. `status`
6. `result`
7. `cancel`
8. `review`
9. `adversarial-review`

## State

Runtime state is stored under:

`~/.codex/cache/claude-handoff/<workspace-slug>-<hash>/`

Each workspace gets:

1. `workspace.json`
2. `jobs/<job-id>.json`
3. `logs/<job-id>.log`
4. `sessions/<codex-session-id>.json`
5. `runtime.json`

## Hooks

Repo-local hook config is wired through:

1. `.codex/config.toml`
2. `.codex/hooks.json`

The plugin also ships reference hook config in `plugins/claude/hooks/hooks.json`.

## Legal

- License: [LICENSE](/Users/jon/projects/codex-cc-plugin/LICENSE)
- Privacy: [PRIVACY.md](/Users/jon/projects/codex-cc-plugin/PRIVACY.md)
- Terms: [TERMS.md](/Users/jon/projects/codex-cc-plugin/TERMS.md)
- Trademarks: [TRADEMARKS.md](/Users/jon/projects/codex-cc-plugin/TRADEMARKS.md)
