# claude-sync

[繁體中文](./README.zh-TW.md)

Sync your Claude Code settings, plugins, and commands across machines using any git remote.

No extra dependencies. No server. Just one private git repo.

## Install

```bash
# 1. Add the marketplace
claude plugin marketplace add github:chenyii1120/claude-sync

# 2. Install the plugin
claude plugin install claude-sync

# Or install directly from source (for development)
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
| `settings.json` | Full sync (excludes machine-specific `statusLine`) |
| `installed_plugins.json` | Full sync with path transformation |
| `known_marketplaces.json` | Full sync with path transformation |
| `~/.claude/commands/` | Full directory sync |
| `~/.claude/rules/` | Full directory sync (requires confirmation on pull) |

## What Does NOT Get Synced

- `statusLine` in settings (contains machine-specific absolute paths)
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

## Disclaimer

- This is a **community plugin**, not an official Anthropic product. It is not affiliated with, endorsed by, or supported by Anthropic.
- This plugin reads and writes files under `~/.claude/`. While it includes backup mechanisms, **use at your own risk**. Always verify changes with `/sync-diff` before pulling.
- Your `settings.json` may contain sensitive data (e.g., environment variables with API keys or tokens). This plugin pushes them to a git remote. **Use a private repository** and review what gets synced.
- Conflict resolution uses a simple last-write-wins strategy. In rare cases, settings from one machine may overwrite changes made on another. Git history is preserved as a safety net.
- If Anthropic introduces native settings sync in the future, this plugin may become redundant.

## License

MIT
