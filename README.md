# claude-sync

[繁體中文](./README.zh-TW.md)

Sync your Claude Code settings, plugins, and commands across machines using any git remote.

No extra dependencies. No server. Just one private git repo.

---

## 📦 Install

```bash
# 1. Add the marketplace
claude plugin marketplace add github:chenyii1120/claude-sync

# 2. Install the plugin
claude plugin install claude-sync

# Or install directly from source (for development)
claude plugin install /path/to/claude-sync
```

## 🚀 Quick Start

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

---

## 🔧 Commands

### `/sync-init` — First-time setup

Two paths depending on your environment:

#### Path A — Create a new GitHub repo

> Default if `gh` CLI is available and authenticated.

1. Checks prerequisites: `git` (required), `gh` (optional)
2. Runs `gh repo create claude-config-sync --private` to create a private repo
3. Clones to `~/.claude/sync/repo/`
4. Exports your current local settings into the repo
5. Commits and pushes
6. Saves sync config to `~/.claude/sync/config.json`

#### Path B — Connect to an existing repo

> Works with any git remote: GitHub, GitLab, Bitbucket, self-hosted, etc.

1. You provide a remote URL
2. Clones to `~/.claude/sync/repo/`
3. If the repo already has sync data (i.e., a `global/` directory exists), it skips the initial export — your remote settings are preserved, and you can pull them with `/sync-pull`
4. If the repo is empty, exports your local settings and pushes

> 💡 **Second machine detection:** When you run `/sync-init` on a new machine pointing to a repo that already has data, it automatically recognizes this and offers to pull immediately — no extra steps.

---

### `/sync-push` — Export & push

Exports your local settings to the sync repo and pushes to remote.

1. 📝 Reads `~/.claude/settings.json`, filters out blacklisted fields (`statusLine`), writes to `repo/global/settings.json`

2. 🔌 Reads `~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json`, transforms absolute paths → `${CLAUDE_HOME}` placeholders, writes to `repo/global/`

3. 📂 Copies `~/.claude/commands/`, `~/.claude/rules/`, and `~/.claude/agents/` to `repo/user-config/`

4. 📤 Runs `git add -A && git commit && git push`

5. 🔄 If push is rejected (remote has newer commits), automatically fetches, merges with local-wins strategy (`-X ours`), and retries

---

### `/sync-pull` — Fetch & apply

Pulls remote settings and applies them locally.

1. 💾 **Auto-backup** — Snapshots your current settings, plugin configs, commands, rules, and agents to `~/.claude/sync-backups/` (max 5 retained, oldest auto-pruned)

2. 🔄 **Fetch + merge** — If merge conflicts occur, falls back to `reset --hard origin/main` (remote wins)

3. ⚙️ **Import settings** — Merges remote settings into local `settings.json`. Blacklisted fields (e.g., `statusLine`) are preserved from local and never overwritten

4. 🔌 **Import plugin configs** — Transforms `${CLAUDE_HOME}` placeholders back to local absolute paths and writes to `~/.claude/plugins/`

5. 📂 **Import commands / rules / agents** — Mirror syncs from repo to local directories. Files deleted on the source machine are also removed locally. Rules changes are shown to the user with a confirmation prompt before applying (security measure)

6. 🔧 **Auto plugin reinstallation** — Detects missing marketplace clones and plugin installations. Automatically runs:
   - `claude plugin marketplace add` for each missing marketplace source
   - `claude plugin update` to reinstall all missing plugins

   > This ensures a pull results in a **fully working setup**, not just config files without actual plugin code.

---

### `/sync-status` — Check sync state

- ✅ Whether sync is initialized
- 🔗 The remote repo URL
- 🕐 Last sync timestamp
- 📥 Number of remote updates available (runs `git fetch` with 5s timeout)
- 📝 Whether local settings have changed since last push

---

### `/sync-diff` — Preview changes

Previews JSON-level differences between local and remote settings **without applying anything**.

For each changed field, shows the local value vs. remote value. Also shows file-level diffs for plugin configs.

---

### `/sync-restore` — Restore from backup

Lists available backups (up to 5, sorted newest first) and lets you pick one to restore.

Restores settings, plugin configs, commands, rules, and agents. After restore, automatically reinstalls any missing plugins — same as `/sync-pull`.

---

### `/sync-uninstall` — Remove sync

Removes all local sync data:

1. 🗑️ Deletes `~/.claude/sync/` (config, repo clone, lockfile)
2. 🗑️ Deletes `~/.claude/sync-backups/`
3. 🔗 Tells you the remote repo URL so you can delete it manually if desired (e.g., `gh repo delete <repo> --yes`)
4. ✅ Your current settings remain untouched — only sync metadata is removed

---

## 🏗️ Architecture

### How It Works

The plugin consists of three layers:

```
┌─────────────────────────────────────────────────┐
│  Slash Commands (commands/*.md)                  │
│  Claude reads these as instructions when you     │
│  type /sync-init, /sync-push, etc.               │
├─────────────────────────────────────────────────┤
│  Sync Engine (lib/sync-engine.js, ~500 lines)    │
│  Pure Node.js, zero npm deps. All logic here:    │
│  export, import, diff, backup, git operations    │
├─────────────────────────────────────────────────┤
│  Git (system)                                    │
│  All remote operations go through system git     │
│  via child_process.execSync                      │
└─────────────────────────────────────────────────┘
```

### Plugin File Structure

```
claude-sync/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata (name, version, author)
├── hooks/
│   ├── hooks.json               # Hook registration (SessionStart)
│   └── session-start-check.js   # Lightweight update checker (~38 lines)
├── commands/
│   ├── sync-init.md             # /sync-init
│   ├── sync-push.md             # /sync-push
│   ├── sync-pull.md             # /sync-pull
│   ├── sync-status.md           # /sync-status
│   ├── sync-diff.md             # /sync-diff
│   ├── sync-restore.md          # /sync-restore
│   └── sync-uninstall.md        # /sync-uninstall
└── lib/
    └── sync-engine.js           # Core sync logic (~500 lines)
```

### Sync Repo Structure

When you push, your private sync repo looks like this:

```
(your private git repo)
├── global/
│   ├── settings.json            # Your settings (minus statusLine)
│   ├── installed_plugins.json   # Plugin list with ${CLAUDE_HOME} paths
│   └── known_marketplaces.json  # Marketplace list with ${CLAUDE_HOME} paths
└── user-config/
    ├── commands/                # Your global custom slash commands
    ├── rules/                   # Your global rules
    └── agents/                  # Your custom agent definitions
```

### Local State (not pushed to remote)

```
~/.claude/sync/
├── config.json                  # Sync repo URL, settings
├── last-sync.json               # Last sync timestamp and action
├── .sync.lock                   # Lockfile (directory-based, prevents concurrent sync)
└── repo/                        # Local git clone of your sync repo

~/.claude/sync-backups/          # Auto-backups before each pull (max 5)
└── backup-2026-03-01T12-00-00-000Z/
    ├── settings.json
    ├── installed_plugins.json
    ├── known_marketplaces.json
    ├── commands/
    ├── rules/
    └── agents/
```

---

## 🔔 Hooks

This plugin registers a single **SessionStart** hook.

### What is SessionStart?

Claude Code fires `SessionStart` at the beginning of every conversation session — when you start a new session, resume an existing one, or after `/clear` or context compaction. It runs **before** your first prompt is processed.

### What the hook does

`hooks/session-start-check.js` runs automatically on every session start:

1. 🔍 Checks if sync is initialized (`~/.claude/sync/repo/` and `config.json` exist). If not, exits silently.

2. 🌐 Runs `git fetch origin main` with a **5-second timeout**. If the network is unavailable or slow, exits silently — never blocks your session.

3. 🔀 Compares `git rev-parse HEAD` (local) vs `git rev-parse origin/main` (remote).

4. 📢 If remote is ahead, outputs a notification:
   ```
   [claude-sync] Remote has N updates. Run /sync-pull to sync.
   ```

5. 🛡️ On **any** error (network failure, git error, etc.), exits silently with code 0.

> **Key principle:** The hook is **read-only and passive**. It never modifies your local settings. It only notifies. You decide when to pull.

### Session lifecycle

```
Session start (new / resume / clear / compact)
  │
  ├─ 🔔 SessionStart hooks fire
  │     └─ claude-sync checks for remote updates
  │
  ├─ 💬 User's first prompt
  │
  ├─ ... conversation ...
  │
  ├─ 🔄 User types /sync-push or /sync-pull (manual, on-demand)
  │
  └─ Session end
```

---

## 📋 Sync Scope

### ✅ What Gets Synced

| Source | Destination in repo | Strategy |
|--------|-------------------|----------|
| `~/.claude/settings.json` | `global/settings.json` | Blacklist filter: all fields synced **except** `statusLine` |
| `~/.claude/plugins/installed_plugins.json` | `global/installed_plugins.json` | Absolute paths → `${CLAUDE_HOME}` placeholder |
| `~/.claude/plugins/known_marketplaces.json` | `global/known_marketplaces.json` | Same path transformation |
| `~/.claude/commands/` | `user-config/commands/` | Mirror sync (adds, updates, and deletes) |
| `~/.claude/rules/` | `user-config/rules/` | Mirror sync |
| `~/.claude/agents/` | `user-config/agents/` | Mirror sync |

### ❌ What Does NOT Get Synced

| Item | Reason |
|------|--------|
| `statusLine` field in settings | Contains machine-specific absolute paths (e.g., `/opt/homebrew/bin/node`) that would break on another machine |
| `plugins/cache/` | Plugin source code; **auto-rebuilt** on pull via `claude plugin update` |
| `plugins/marketplaces/` | Marketplace git clones; **auto-rebuilt** on pull via `claude plugin marketplace add` |
| `plugins/blocklist.json` | Machine-specific preference |
| `projects/*/*.jsonl` | Session transcripts; large and sensitive |
| `debug/`, `cache/`, `history.jsonl` | Machine-specific temporary data |
| `session-env/`, `tasks/`, `teams/`, `todos/` | Session-specific runtime state |
| Project-level `CLAUDE.md` | Already lives in your project's git repo |

### 🔄 Path Transformation

Plugin config files contain absolute paths that differ between machines. The sync engine handles this automatically:

**Push** (local → repo):

```
/Users/alice/.claude/plugins/cache/superpowers/4.3.1
→ ${CLAUDE_HOME}/plugins/cache/superpowers/4.3.1
```

**Pull** (repo → local):

```
${CLAUDE_HOME}/plugins/cache/superpowers/4.3.1
→ /Users/bob/.claude/plugins/cache/superpowers/4.3.1
```

---

## ⚡ Conflict Resolution

Uses a **last-write-wins** strategy:

- 📤 **Push conflict** (remote has newer commits)

  Fetches remote, merges with `-X ours` (your local changes win), then pushes the merged result.

- 📥 **Pull conflict** (merge fails)

  Aborts merge, resets to remote HEAD (`reset --hard origin/main`). Your local settings are overwritten with remote, but a backup was already created before the pull.

- 🔒 **Concurrent sync prevention**

  A filesystem-based lockfile (`~/.claude/sync/.sync.lock`) prevents two sync operations from running simultaneously. Uses atomic `mkdir` — if the directory already exists, the lock acquisition fails.

> All git history is preserved. If something goes wrong, you can always recover from git history or from the auto-backups in `~/.claude/sync-backups/`.

---

## 🛡️ Error Handling

| Scenario | Behavior |
|----------|----------|
| 🌐 No network (hook) | Silent exit, never blocks session startup |
| 🌐 No network (command) | Clear error: "Failed to fetch from remote. Check your network." |
| 🔧 `gh` CLI not installed | Skips auto repo creation, asks for manual URL |
| 🔧 `git` not installed | Blocks init with clear error |
| 📤 Push rejected | Auto fetch + merge + retry |
| ⚡ Merge conflict | Last-write-wins + backup safety net |
| 🔒 Concurrent sync | Lockfile prevents simultaneous operations |
| 🔌 Missing plugins after pull | Auto-reinstalls: marketplace add + plugin update |
| 👤 No global git identity | Auto-configures in sync repo (inherits from global config or uses defaults) |

---

## 🛠️ Tech Stack

- **Runtime:** Node.js built-ins only (`fs`, `path`, `child_process`, `os`) — zero npm dependencies
- **VCS:** System `git` via `child_process.execSync` with configurable timeouts
- **Plugin system:** Claude Code native plugin format (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/*.md`)
- **Backend:** Any git remote (GitHub, GitLab, Bitbucket, Gitea, self-hosted, bare repo, etc.)

---

## 🤖 For Claude Code Agents

See [SETUP_GUIDE.md](./SETUP_GUIDE.md) — a reference document for Claude Code agents that need to install and configure claude-sync on behalf of users. It includes prerequisite checks, step-by-step setup instructions, the sync engine's exported function reference, and important behavioral notes (e.g., always show diffs before pulling, rules require confirmation).

---

## ⚠️ Disclaimer

- This is a **community plugin**, not an official Anthropic product. It is not affiliated with, endorsed by, or supported by Anthropic.

- This plugin reads and writes files under `~/.claude/`. While it includes backup mechanisms, **use at your own risk**. Always verify changes with `/sync-diff` before pulling.

- Your `settings.json` may contain sensitive data (e.g., environment variables with API keys or tokens). This plugin pushes them to a git remote. **Use a private repository** and review what gets synced.

- Conflict resolution uses a simple last-write-wins strategy. In rare cases, settings from one machine may overwrite changes made on another. Git history is preserved as a safety net.

- If Anthropic introduces native settings sync in the future, this plugin may become redundant.

## 📄 License

MIT
