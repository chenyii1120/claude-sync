# claude-sync

[繁體中文](./README.zh-TW.md)

Sync your Claude Code settings, plugins, and commands across machines using any git remote.

No extra dependencies. No server. Just one private git repo.

## Install

```bash
# From marketplace
claude plugin install claude-sync

# From source (for development)
claude plugin install /path/to/claude-sync
```

## Quick Start

**First machine:**
```
/sync-init          # Create or connect a git repo
/sync-push          # Push your settings
```

**Other machines:**
```
/sync-init <url>    # Connect to the same repo
/sync-pull          # Pull settings from remote
```

## Commands

| Command | Description |
|---------|-------------|
| `/sync-init` | Set up sync — create a new repo or connect to existing |
| `/sync-push` | Push local settings to your sync repo |
| `/sync-pull` | Pull remote settings (shows diff, asks confirmation) |
| `/sync-status` | Show sync status and pending updates |
| `/sync-diff` | Preview differences between local and remote |
| `/sync-restore` | Restore settings from a backup |
| `/sync-uninstall` | Remove sync data and clean up |

## What Gets Synced

| Item | Strategy |
|------|----------|
| `settings.json` | Whitelist merge (`language`, `enabledPlugins`) |
| `installed_plugins.json` | Full sync with path transformation |
| `known_marketplaces.json` | Full sync with path transformation |
| `~/.claude/commands/` | Full directory sync |
| `~/.claude/rules/` | Full directory sync (requires confirmation on pull) |

## What Does NOT Get Synced

- Machine-specific settings (`statusLine`, `permissions`)
- Plugin source code (`plugins/cache/`) — reinstall via marketplace
- Session transcripts, debug logs, conversation history

## Security

- **Backup before every pull** — auto-backup with max 5 retained
- **Rules require confirmation** — pull shows diff and asks before applying rules
- **Private repo recommended** — your settings stay private
- **Path transformation** — absolute paths replaced with `${CLAUDE_HOME}` placeholder

## How It Works

- **Zero npm dependencies** — uses only Node.js built-ins (`fs`, `path`, `child_process`)
- **Any git remote** — GitHub, GitLab, Bitbucket, self-hosted, anything with git
- **SessionStart hook** — passively checks for remote updates on session start
- **Last-write-wins** — simple conflict strategy with git history as safety net

## License

MIT
