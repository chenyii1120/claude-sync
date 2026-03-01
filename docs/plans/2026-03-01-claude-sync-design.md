# claude-sync Plugin Design Document

> Claude Code 設定同步插件 — 零額外依賴，一個 git repo 搞定。

## 1. Problem Statement

Claude Code 使用者在多台機器之間（如家裡 Mac + 公司 Mac）需要重複設定 plugins、偏好、自訂指令等。目前沒有內建的跨機器同步機制，使用者只能手動複製設定檔。

## 2. Product Positioning

> 給 Claude Code 使用者的一鍵設定同步。不需要學 chezmoi，不需要架 server，只需要一個 git repo。

**差異化**：
- 相比 chezmoi：零學習曲線，專注 Claude Code 設定
- 相比 CCMS：不需要 SSH server
- 相比 claude-code-sync (Rust)：同步 settings/plugins（非 transcripts），原生 Claude Code plugin 體驗
- 核心優勢：作為 Claude Code plugin，直接從 marketplace 安裝，`/sync push` 比任何外部工具更自然

**目標使用者**：在 2+ 台機器上使用 Claude Code 的開發者。

**成功指標**：
- 安裝到可用 < 2 分鐘
- 零資料遺失事故
- Marketplace 上架可被搜到

## 3. Competitive Landscape

| 工具 | 同步內容 | 方式 | 限制 |
|------|---------|------|------|
| CCMS (28 stars) | 整個 ~/.claude | rsync over SSH | 需要 SSH server |
| claude-code-sync Rust (21 stars) | Conversation history | Git + smart merge | 不同步 settings |
| claude-session-sync | Sessions | iCloud Drive | 僅 Apple 生態 |
| chezmoi + age | Any dotfiles | Git + templates | 學習曲線高 |
| **claude-sync (ours)** | **Settings + plugins** | **Git repo** | **需要 git** |

**生存威脅**：Anthropic 可能推出原生同步功能（GitHub issue #22648）。需要快速上線 MVP。

## 4. Architecture

### 4.1 Tech Stack

- **語言**：Node.js（零外部依賴，只用內建 fs/path/child_process）
- **後端**：任意 Git remote（GitHub 為便利預設，非強制）
- **衝突策略**：last-write-wins + git history 作為備份
- **自動化**：SessionStart async hook（被動通知，不自動寫入）

**為什麼 Node.js 而非 Shell Script**：
- Claude Code 使用者 100% 有 Node.js → 零額外依賴
- 原生 JSON 處理 → 不需要 jq
- `child_process.execSync` 原生支援 timeout → 跨平台一致
- 不需要處理 macOS BSD vs Linux GNU 差異

### 4.2 Plugin Structure

```
claude-sync/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata
├── hooks/
│   ├── hooks.json               # SessionStart hook definition
│   └── session-start-check.js   # Lightweight update check (~30 lines)
├── commands/
│   ├── sync-init/COMMAND.md     # /sync-init
│   ├── sync-push/COMMAND.md     # /sync-push
│   ├── sync-pull/COMMAND.md     # /sync-pull
│   ├── sync-status/COMMAND.md   # /sync-status
│   ├── sync-diff/COMMAND.md     # /sync-diff
│   ├── sync-restore/COMMAND.md  # /sync-restore
│   └── sync-uninstall/COMMAND.md # /sync-uninstall
└── lib/
    └── sync-engine.js           # Core logic (~250 lines)
```

### 4.3 Sync Repo Structure

```
(user's private git repo, e.g., claude-config-sync)
├── global/
│   ├── settings.json            # Filtered (whitelist fields only)
│   ├── installed_plugins.json   # Path-transformed
│   └── known_marketplaces.json  # Path-transformed
├── user-config/
│   ├── commands/                # Global custom commands
│   └── rules/                   # Global rules
├── projects/
│   └── {normalized-remote-url}/
│       └── memory/
│           ├── MEMORY.md
│           └── *.md
└── meta/
    ├── aliases.json             # Path → remote URL upgrades
    └── machine-id.json          # Last push machine identifier
```

### 4.4 Local State (not synced)

```
~/.claude/sync/
├── config.json                  # Sync repo URL, settings
├── mapping.json                 # git remote URL → local path mapping
├── last-sync.json               # Last sync timestamp, status
└── repo/                        # Local clone of sync repo

~/.claude/sync-backups/          # Auto backups before pull (max 5)
```

## 5. Sync Scope

### 5.1 What Gets Synced

| File | Strategy | Security |
|------|----------|----------|
| `settings.json` | Whitelist merge: only `language`, `enabledPlugins` | Excludes `env`, `statusLine` |
| `plugins/installed_plugins.json` | Path transform: `installPath` → `${CLAUDE_HOME}/...` | No secrets |
| `plugins/known_marketplaces.json` | Path transform: `installLocation` → `${CLAUDE_HOME}/...` | No secrets |
| `~/.claude/commands/` | Full sync | Show changes on pull |
| `~/.claude/rules/` | Full sync | Require confirmation on pull |
| `~/.claude/projects/*/memory/` | Lazy discovery via git remote URL | Low risk |

### 5.2 What Does NOT Get Synced

| File/Dir | Reason |
|----------|--------|
| `settings.json → env` | May contain API keys/secrets |
| `settings.json → statusLine` | Contains machine-specific absolute paths |
| `plugins/cache/` | Plugin source code, rebuildable |
| `plugins/marketplaces/` | Git clones, rebuildable |
| `plugins/blocklist.json` | Machine-specific |
| `plugins/install-counts-cache.json` | Cache, rebuildable |
| `projects/*/*.jsonl` | Session transcripts, large + sensitive |
| `debug/`, `cache/`, `history.jsonl` | Machine-specific temp data |
| `session-env/`, `tasks/`, `teams/`, `todos/` | Session-specific temp state |
| Project-level CLAUDE.md | Already in user's git repo |

### 5.3 settings.json Field Classification

**Synced (whitelist)**:
- `enabledPlugins` — User wants same plugins everywhere
- `language` — Personal preference

**Not synced**:
- `env` — May contain secrets
- `statusLine` — Contains absolute paths (`/opt/homebrew/bin/node`)
- `permissions` — May differ per machine
- `skipDangerousModePermissionPrompt` — Security, per-machine decision

## 6. Commands

### 6.1 `/sync-init [remote-url]`

First-time setup. Two paths:

**Path A: Create new repo (GitHub)**
```
1. Preflight check: git, gh (optional), network
2. gh repo create claude-config-sync --private
3. Clone to ~/.claude/sync/repo/
4. Export current local settings to repo
5. Commit + push
6. Create ~/.claude/sync/config.json
```

**Path B: Connect to existing repo**
```
1. Preflight check: git, network
2. User provides remote URL (any git remote)
3. Clone to ~/.claude/sync/repo/
4. Smart merge: remote settings + local settings
5. Commit + push merged result
6. Create ~/.claude/sync/config.json
```

**Second machine detection**: If remote repo already has data, automatically use Path B and show what will be synced.

**Chezmoi coexistence**: Check if `~/.claude/` is managed by chezmoi. If detected, warn user about potential conflicts.

### 6.2 `/sync-push`

```
1. Run sync-engine.js export (local → repo)
   - settings.json: extract whitelist fields
   - installed_plugins.json: transform paths to ${CLAUDE_HOME}
   - known_marketplaces.json: transform paths
   - commands/, rules/: copy
   - project memory: detect git remote, map, copy
2. First-time push: show preview of what will be pushed
3. git add + commit + push
   - Push rejected? → fetch + merge → retry push
   - Merge conflict? → last-write-wins + notify user
4. Update last-sync.json
```

### 6.3 `/sync-pull`

```
1. Auto-backup current settings to ~/.claude/sync-backups/
2. git fetch + merge
3. Show diff summary (JSON-level, not text-level)
4. Tiered trust model:
   - settings.json, plugins: auto-apply + show summary
   - commands/: auto-apply + show new/modified list
   - rules/: show diff, require user confirmation
5. Apply changes via sync-engine.js import (repo → local)
   - settings.json: whitelist merge (preserve local env, statusLine)
   - installed_plugins.json: transform ${CLAUDE_HOME} → local path
   - Detect missing plugins: prompt "3 plugins synced but not installed"
6. Update last-sync.json
```

### 6.4 `/sync-status`

```
1. Show last sync time
2. git fetch (with 5s timeout)
3. Compare local vs remote HEAD
4. Show: "2 remote updates available" or "Up to date"
5. Show sync scope summary
```

### 6.5 `/sync-diff`

```
1. git fetch
2. JSON-level diff (not git text diff):
   language:
     local:  "zh-TW"
     remote: "en"
   enabledPlugins:
     + context7@claude-plugins-official (remote only)
     - old-plugin@marketplace (local only)
3. Show file-level changes for commands/, rules/
```

### 6.6 `/sync-restore`

```
1. List available backups (max 5, sorted newest first)
2. User selects which backup to restore
3. Copy backup over current settings
4. Show what was restored
```

### 6.7 `/sync-uninstall`

```
1. Remove ~/.claude/sync/ (local clone + config)
2. Remove ~/.claude/sync-backups/
3. Prompt: "Remote repo still exists at [URL]. Delete it too?"
   - Yes (GitHub): gh repo delete
   - Yes (other): show manual deletion instructions
   - No: keep remote for other machines
4. Plugin hooks auto-deactivate when plugin is disabled
```

## 7. Automation: SessionStart Hook

**Purpose**: Passive notification only. Never auto-writes.

```javascript
// session-start-check.js (~30 lines)
const { execSync } = require('child_process');
const SYNC_DIR = `${process.env.HOME}/.claude/sync/repo`;

try {
  if (!require('fs').existsSync(SYNC_DIR)) process.exit(0);

  execSync('git fetch origin main', {
    cwd: SYNC_DIR,
    timeout: 5000,
    stdio: 'pipe'
  });

  const local = execSync('git rev-parse HEAD', { cwd: SYNC_DIR }).toString().trim();
  const remote = execSync('git rev-parse origin/main', { cwd: SYNC_DIR }).toString().trim();

  if (local !== remote) {
    const count = execSync('git rev-list HEAD..origin/main --count', { cwd: SYNC_DIR }).toString().trim();
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[claude-sync] 遠端有 ${count} 個更新。執行 /sync-pull 來同步。`
      }
    }));
  }
} catch (e) {
  process.exit(0); // Silent failure, never block session
}
```

**hooks.json**:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start-check.js\""
          }
        ]
      }
    ]
  }
}
```

## 8. Security Model

### 8.1 Principles

1. **Never auto-write without user consent** — All pull operations show diff first
2. **Always show what changed** — diff is core functionality, not optional
3. **Rules changes require confirmation** — Tiered trust model
4. **Secrets never leave the machine by default** — env field excluded, opt-in available
5. **Backup before every destructive operation** — Auto-backup on pull

### 8.2 Supply Chain Attack Protection

**Threat**: If sync repo is compromised, attacker could inject malicious content into rules/ or commands/.

**Mitigations**:
- rules/ changes require explicit user confirmation on pull
- commands/ changes are displayed before applying
- Plugin installation is never triggered automatically
- `/sync-diff` lets users inspect before pulling

### 8.3 Secrets Handling

- `env` field excluded from sync by default
- Opt-in: users can enable env sync in `~/.claude/sync/config.json`
- On new machine setup, `/sync-pull` prompts: "API keys need to be configured on this machine"
- Private repo is the baseline security measure

## 9. Path Transformation

### 9.1 Plugin Paths

**Push** (local → repo):
```
/Users/joebot/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
→ ${CLAUDE_HOME}/plugins/cache/claude-plugins-official/superpowers/4.3.1
```

**Pull** (repo → local):
```
${CLAUDE_HOME}/plugins/cache/claude-plugins-official/superpowers/4.3.1
→ /Users/alice/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
```

### 9.2 Git Remote URL Normalization

```javascript
function normalizeRemoteUrl(url) {
  return url
    .replace(/^(ssh:\/\/|https?:\/\/|git@)/, '')
    .replace(/^([^:]+):/, '$1/')
    .replace(/\.git$/, '');
  // Result: github.com/user/repo
}
```

### 9.3 Project Memory Mapping

- **Primary key**: Normalized git remote URL
- **Fallback**: Directory name (for non-git projects)
- **Lazy discovery**: Mapping builds as user works in different projects
- **Upgrade**: When non-git project gets a remote, memory migrates via aliases.json

## 10. Error Handling

| Scenario | Behavior |
|----------|----------|
| No network (hook) | Silent exit 0, never block session |
| No network (command) | Clear error: "無法連線，請檢查網路" |
| gh not installed | Skip auto repo creation, ask for manual URL |
| git not installed | Block init with clear install instructions |
| Push rejected | Auto fetch + merge + retry |
| Merge conflict | last-write-wins + log warning |
| Concurrent sessions | Lockfile prevents simultaneous sync |
| Missing plugins after pull | Prompt: "3 plugins not installed, run claude plugin update" |
| Sync repo deleted | Guide user to re-init |

## 11. Phase 2 Roadmap

- SessionEnd hook: "本地有變更未推送" reminder
- SessionStart auto-pull (opt-in)
- SessionEnd auto-push (opt-in)
- MCP config sync (with field-level filtering)
- Commit signing for supply chain protection
- `.syncignore` for fine-grained exclusion
- `/sync-log` for sync history
- `/sync-pull --dry-run` dry run mode

## 12. Technical Estimates

| Component | Lines of Code | Complexity |
|-----------|--------------|------------|
| lib/sync-engine.js | ~250 | Core |
| hooks/session-start-check.js | ~30 | Simple |
| 7 COMMAND.md files | ~20 each | Simple |
| plugin.json + hooks.json | Config | Trivial |
| **Total** | **~420** | **Small** |

Zero external dependencies. Only Node.js built-ins (fs, path, child_process) + system git.
