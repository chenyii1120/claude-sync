# claude-sync Setup Guide (for Claude Code agents)

This document is intended for Claude Code agents helping users install and configure claude-sync. Follow these steps exactly.

## Prerequisites Check

Run these checks before proceeding:

```bash
# 1. git must be available
which git

# 2. gh CLI is optional but recommended (for auto repo creation)
which gh 2>/dev/null && gh auth status 2>&1 | head -3

# 3. Node.js must be available (Claude Code users always have this)
node --version
```

- `git` is **required**. If missing, instruct the user to install it.
- `gh` is **optional**. If available and authenticated, enables automatic private repo creation on GitHub. If not, the user must provide a remote URL manually.
- `node` is **required** (Claude Code guarantees this).

## Installation

### Option A: From marketplace (recommended for end users)

```bash
# Add the marketplace source
claude plugin marketplace add github:chenyii1120/claude-sync

# Install the plugin
claude plugin install claude-sync
```

### Option B: From local path (for development or testing)

```bash
claude plugin install /absolute/path/to/claude-sync
```

After installation, the plugin's slash commands (`/sync-init`, `/sync-push`, etc.) become available in all Claude Code sessions.

## First-Time Setup

### Step 1: Initialize

Run `/sync-init` in a Claude Code session. The command will guide the user through one of two paths:

**If `gh` CLI is available and authenticated:**

1. Ask the user if they want to create a new private GitHub repo or connect to an existing one.
2. For a new repo, run:
   ```bash
   gh repo create claude-config-sync --private --clone --description "Claude Code settings sync"
   ```
3. Move the clone to `~/.claude/sync/repo/` or use it as the remote URL for `init()`.

**If `gh` CLI is not available:**

1. Ask the user for a git remote URL (any provider: GitHub, GitLab, Bitbucket, self-hosted, etc.).
2. The repo must already exist on the remote. Instruct the user to create it first if needed.

Then call the sync engine:

```bash
node -e "
  const s = require('PLUGIN_ROOT/lib/sync-engine.js');
  const result = s.init('REMOTE_URL');
  console.log(JSON.stringify(result, null, 2));
"
```

Replace `PLUGIN_ROOT` with `${CLAUDE_PLUGIN_ROOT}` in COMMAND.md context, or the actual plugin install path.

Replace `REMOTE_URL` with the actual git remote URL.

**Interpreting the result:**

- `hasContent: false` — The repo was empty. Local settings have been exported and pushed. Tell the user: "Settings exported and pushed to your sync repo."
- `hasContent: true` — The repo already had sync data (e.g., from another machine). Tell the user: "Connected to existing sync repo. Run `/sync-pull` to import settings from remote."

### Step 2: Push settings (first machine only)

If `init()` returned `hasContent: false`, settings were already pushed during init. No further action needed.

If the user makes changes later, they can push with `/sync-push`.

### Step 3: Set up other machines

On each additional machine:

1. Install the plugin (same as above)
2. Run `/sync-init <remote-url>` with the same repo URL
3. Run `/sync-pull` to import settings

## Configuration Files

After initialization, the following files are created:

| File | Purpose |
|------|---------|
| `~/.claude/sync/config.json` | Stores the remote repo URL and sync preferences |
| `~/.claude/sync/last-sync.json` | Timestamp and type of last sync operation |
| `~/.claude/sync/repo/` | Local git clone of the sync repo |

Example `config.json`:

```json
{
  "repo": "git@github.com:username/claude-config-sync.git",
  "autoPull": false,
  "autoPush": false
}
```

## Checking Sync Status

```bash
node -e "
  const s = require('PLUGIN_ROOT/lib/sync-engine.js');
  console.log(JSON.stringify(s.getStatus(), null, 2));
"
```

Returns:

```json
{
  "initialized": true,
  "repoUrl": "git@github.com:username/claude-config-sync.git",
  "lastSync": "2026-03-01T12:00:00.000Z",
  "remoteUpdates": 0,
  "localChanges": false,
  "fetchFailed": false
}
```

## Checking for Differences

```bash
node -e "
  const s = require('PLUGIN_ROOT/lib/sync-engine.js');
  s.gitFetch(10000);
  const settings = s.diffSettings();
  const plugins = s.diffPluginConfigs();
  console.log(JSON.stringify({ settings, plugins }, null, 2));
"
```

Always show the diff to the user before pulling. Each diff entry contains:

```json
{
  "field": "language",
  "local": "en",
  "remote": "繁體中文"
}
```

## Important Notes for Agents

1. **Always show diffs before pulling.** Never auto-apply remote settings without the user seeing what will change.

2. **Rules require explicit confirmation.** If `/sync-pull` includes changes to `~/.claude/rules/`, show the full diff and ask the user to confirm before applying. This is a security measure against supply chain attacks.

3. **Check for missing plugins after pull.** If the pull result contains `missingPlugins`, inform the user which plugins need to be reinstalled:
   ```
   The following plugins are listed in your sync but not installed on this machine:
   - superpowers@claude-plugins-official
   - context7@claude-plugins-official
   Run `claude plugin update` to install them.
   ```

4. **Backup location.** Every pull creates a backup at `~/.claude/sync-backups/`. If something goes wrong, restore with `/sync-restore`.

5. **Chezmoi coexistence.** If `~/.claude/` is managed by chezmoi, warn the user about potential conflicts:
   ```bash
   chezmoi managed 2>/dev/null | grep -q .claude && echo "WARNING: ~/.claude is managed by chezmoi"
   ```

6. **Error handling.** If any sync operation fails, check:
   - Is git installed? (`which git`)
   - Is the network available? (`git ls-remote origin main` in the sync repo)
   - Is another sync in progress? (lockfile at `~/.claude/sync/.sync.lock` — if stale, remove it)

## Exported Functions Reference

All functions are available from `require('PLUGIN_ROOT/lib/sync-engine.js')`:

| Function | Description |
|----------|-------------|
| `isInitialized()` | Returns `true` if sync is set up |
| `init(remoteUrl)` | Clone repo, export if empty, save config |
| `push()` | Export local settings, commit, push (with retry) |
| `pull()` | Backup, fetch, merge, import settings |
| `getStatus()` | Full status report (initialized, updates, changes) |
| `diffSettings()` | JSON-level diff of settings fields |
| `diffPluginConfigs()` | File-level diff of plugin configs |
| `createBackup()` | Manual backup of current settings |
| `listBackups()` | List available backups (newest first) |
| `restoreBackup(name)` | Restore from a named backup |
| `uninstall()` | Remove all local sync data |
| `loadConfig()` | Read sync config |
| `gitFetch(timeoutMs)` | Fetch from remote with timeout |
| `detectMissingPlugins()` | List plugins in config but not installed locally |
