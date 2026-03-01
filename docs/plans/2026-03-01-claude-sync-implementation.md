# claude-sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that syncs settings, plugin lists, commands, and rules across machines via any git remote.

**Architecture:** Node.js sync engine (~250 lines, zero npm deps) + 7 slash commands (COMMAND.md) + SessionStart hook for passive update notification. All git operations via child_process.execSync. JSON whitelist merge for settings, path transformation for plugin configs.

**Tech Stack:** Node.js built-ins (fs, path, child_process), system git, Claude Code plugin system (.claude-plugin/plugin.json + hooks/hooks.json + commands/*.md)

---

## Task 1: Plugin Scaffold + plugin.json + hooks.json

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `hooks/session-start-check.js` (stub)
- Create: `lib/sync-engine.js` (stub)

**Step 1: Create plugin.json**

```json
{
  "name": "claude-sync",
  "description": "Sync your Claude Code settings, plugins, and commands across machines using any git remote",
  "version": "0.1.0",
  "author": {
    "name": "chenyii1120",
    "email": "chenyii1120@gmail.com"
  },
  "repository": "https://github.com/chenyii1120/claude-sync",
  "license": "MIT",
  "keywords": ["sync", "settings", "plugins", "multi-machine", "dotfiles"]
}
```

**Step 2: Create hooks.json**

```json
{
  "description": "claude-sync SessionStart hook for remote update notification",
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

**Step 3: Create sync-engine.js stub**

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_HOME = path.join(process.env.HOME, '.claude');
const SYNC_DIR = path.join(CLAUDE_HOME, 'sync');
const REPO_DIR = path.join(SYNC_DIR, 'repo');
const CONFIG_PATH = path.join(SYNC_DIR, 'config.json');
const MAPPING_PATH = path.join(SYNC_DIR, 'mapping.json');
const LAST_SYNC_PATH = path.join(SYNC_DIR, 'last-sync.json');
const BACKUP_DIR = path.join(CLAUDE_HOME, 'sync-backups');

// Placeholder — functions will be added in subsequent tasks
module.exports = { CLAUDE_HOME, SYNC_DIR, REPO_DIR, CONFIG_PATH, MAPPING_PATH, LAST_SYNC_PATH, BACKUP_DIR };
```

**Step 4: Create session-start-check.js stub**

```javascript
'use strict';
// Stub — implemented in Task 7
process.exit(0);
```

**Step 5: Verify plugin structure**

Run: `find . -not -path './.git/*' -not -path './.git' | sort`

Expected:
```
.
./.claude-plugin
./.claude-plugin/plugin.json
./docs
./docs/plans
./docs/plans/2026-03-01-claude-sync-design.md
./docs/plans/2026-03-01-claude-sync-implementation.md
./hooks
./hooks/hooks.json
./hooks/session-start-check.js
./lib
./lib/sync-engine.js
```

**Step 6: Commit**

```bash
git add .claude-plugin/ hooks/ lib/sync-engine.js
git commit -m "scaffold: plugin structure with plugin.json, hooks.json, and stubs"
```

---

## Task 2: sync-engine.js — Git Helpers + Config Management

**Files:**
- Modify: `lib/sync-engine.js`

**Step 1: Implement git helper functions**

Add to `lib/sync-engine.js`:

```javascript
function gitExec(args, opts = {}) {
  const defaults = { cwd: REPO_DIR, timeout: 30000, stdio: 'pipe' };
  return execSync(`git ${args}`, { ...defaults, ...opts }).toString().trim();
}

function gitFetch(timeoutMs = 5000) {
  try {
    execSync('git fetch origin main', { cwd: REPO_DIR, timeout: timeoutMs, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasRemoteUpdates() {
  const local = gitExec('rev-parse HEAD');
  const remote = gitExec('rev-parse origin/main');
  return local !== remote;
}

function getRemoteUpdateCount() {
  return parseInt(gitExec('rev-list HEAD..origin/main --count'), 10);
}

function hasLocalChanges() {
  const status = gitExec('status --porcelain');
  return status.length > 0;
}
```

**Step 2: Implement config management**

```javascript
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadLastSync() {
  if (!fs.existsSync(LAST_SYNC_PATH)) return {};
  return JSON.parse(fs.readFileSync(LAST_SYNC_PATH, 'utf8'));
}

function saveLastSync(data) {
  fs.writeFileSync(LAST_SYNC_PATH, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
}

function isInitialized() {
  return fs.existsSync(CONFIG_PATH) && fs.existsSync(REPO_DIR);
}
```

**Step 3: Implement lockfile (prevent concurrent sync)**

```javascript
const LOCK_PATH = path.join(SYNC_DIR, '.sync.lock');

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_PATH, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_PATH); } catch {}
}
```

**Step 4: Export all functions**

```javascript
module.exports = {
  CLAUDE_HOME, SYNC_DIR, REPO_DIR, CONFIG_PATH, MAPPING_PATH, LAST_SYNC_PATH, BACKUP_DIR,
  gitExec, gitFetch, hasRemoteUpdates, getRemoteUpdateCount, hasLocalChanges,
  loadConfig, saveConfig, loadLastSync, saveLastSync, isInitialized,
  acquireLock, releaseLock,
};
```

**Step 5: Quick smoke test**

Run: `node -e "const s = require('./lib/sync-engine.js'); console.log('CLAUDE_HOME:', s.CLAUDE_HOME); console.log('isInitialized:', s.isInitialized());"`

Expected: No errors, prints CLAUDE_HOME path and `isInitialized: false`.

**Step 6: Commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: sync-engine git helpers, config management, and lockfile"
```

---

## Task 3: sync-engine.js — Export (local → repo)

**Files:**
- Modify: `lib/sync-engine.js`

**Step 1: Implement settings.json whitelist export**

```javascript
const SETTINGS_WHITELIST = ['language', 'enabledPlugins'];

function exportSettings() {
  const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  const full = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const filtered = {};
  for (const key of SETTINGS_WHITELIST) {
    if (key in full) filtered[key] = full[key];
  }
  const outDir = path.join(REPO_DIR, 'global');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'settings.json'), JSON.stringify(filtered, null, 2));
}
```

**Step 2: Implement plugin config path transformation**

```javascript
function transformPathsForExport(obj) {
  const json = JSON.stringify(obj);
  const escaped = CLAUDE_HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return JSON.parse(json.replace(new RegExp(escaped, 'g'), '${CLAUDE_HOME}'));
}

function transformPathsForImport(obj) {
  const json = JSON.stringify(obj);
  return JSON.parse(json.replace(/\$\{CLAUDE_HOME\}/g, CLAUDE_HOME));
}

function exportPluginConfigs() {
  const outDir = path.join(REPO_DIR, 'global');
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const src = path.join(CLAUDE_HOME, 'plugins', file);
    if (!fs.existsSync(src)) continue;
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    const transformed = transformPathsForExport(data);
    fs.writeFileSync(path.join(outDir, file), JSON.stringify(transformed, null, 2));
  }
}
```

**Step 3: Implement commands/ and rules/ export**

```javascript
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function exportUserConfig() {
  const configDir = path.join(REPO_DIR, 'user-config');
  copyDirSync(path.join(CLAUDE_HOME, 'commands'), path.join(configDir, 'commands'));
  copyDirSync(path.join(CLAUDE_HOME, 'rules'), path.join(configDir, 'rules'));
}
```

**Step 4: Implement full export orchestrator**

```javascript
function exportAll() {
  exportSettings();
  exportPluginConfigs();
  exportUserConfig();
}
```

**Step 5: Smoke test export**

Run: `node -e "const s = require('./lib/sync-engine.js'); console.log('exportSettings:', typeof s.exportSettings); console.log('exportAll:', typeof s.exportAll);"`

Expected: Both functions are `function`.

**Step 6: Commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: sync-engine export functions (settings whitelist, path transform, dir copy)"
```

---

## Task 4: sync-engine.js — Import (repo → local) + Backup

**Files:**
- Modify: `lib/sync-engine.js`

**Step 1: Implement backup**

```javascript
function createBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `backup-${ts}`);
  fs.mkdirSync(backupPath);

  // Backup settings.json
  const settingsSrc = path.join(CLAUDE_HOME, 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    fs.copyFileSync(settingsSrc, path.join(backupPath, 'settings.json'));
  }

  // Backup plugin configs
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    const src = path.join(CLAUDE_HOME, 'plugins', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupPath, f));
  }

  // Prune old backups (keep 5)
  const backups = fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup-')).sort().reverse();
  for (const old of backups.slice(5)) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  }

  return backupPath;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup-')).sort().reverse();
}

function restoreBackup(backupName) {
  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) throw new Error(`Backup not found: ${backupName}`);

  const settingsBackup = path.join(backupPath, 'settings.json');
  if (fs.existsSync(settingsBackup)) {
    fs.copyFileSync(settingsBackup, path.join(CLAUDE_HOME, 'settings.json'));
  }
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    const src = path.join(backupPath, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(CLAUDE_HOME, 'plugins', f));
  }
}
```

**Step 2: Implement settings import (whitelist merge)**

```javascript
function importSettings() {
  const repoSettings = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(repoSettings)) return { changed: false };

  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const remote = JSON.parse(fs.readFileSync(repoSettings, 'utf8'));

  const changes = {};
  for (const key of SETTINGS_WHITELIST) {
    if (key in remote && JSON.stringify(local[key]) !== JSON.stringify(remote[key])) {
      changes[key] = { from: local[key], to: remote[key] };
      local[key] = remote[key];
    }
  }

  if (Object.keys(changes).length > 0) {
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
    return { changed: true, changes };
  }
  return { changed: false };
}
```

**Step 3: Implement plugin config import (path transform)**

```javascript
function importPluginConfigs() {
  const changes = [];
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const repoFile = path.join(REPO_DIR, 'global', file);
    if (!fs.existsSync(repoFile)) continue;

    const remote = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
    const local = transformPathsForImport(remote);
    const destPath = path.join(CLAUDE_HOME, 'plugins', file);

    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : '';
    const newContent = JSON.stringify(local, null, 2);
    if (existing !== newContent) {
      fs.writeFileSync(destPath, newContent);
      changes.push(file);
    }
  }
  return changes;
}
```

**Step 4: Implement commands/rules import**

```javascript
function importUserConfig() {
  const changes = [];
  for (const dir of ['commands', 'rules']) {
    const src = path.join(REPO_DIR, 'user-config', dir);
    if (!fs.existsSync(src)) continue;
    copyDirSync(src, path.join(CLAUDE_HOME, dir));
    changes.push(dir);
  }
  return changes;
}
```

**Step 5: Implement full import orchestrator**

```javascript
function importAll() {
  const settingsResult = importSettings();
  const pluginChanges = importPluginConfigs();
  const configChanges = importUserConfig();
  return { settingsResult, pluginChanges, configChanges };
}
```

**Step 6: Implement missing plugins detection**

```javascript
function detectMissingPlugins() {
  const installedPath = path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return [];

  const data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  const missing = [];
  if (data.plugins) {
    for (const [name, versions] of Object.entries(data.plugins)) {
      for (const v of versions) {
        if (v.installPath && !fs.existsSync(v.installPath)) {
          missing.push(name);
        }
      }
    }
  }
  return [...new Set(missing)];
}
```

**Step 7: Export new functions and commit**

Update `module.exports` to include all new functions.

```bash
git add lib/sync-engine.js
git commit -m "feat: sync-engine import functions (whitelist merge, path transform, backup/restore)"
```

---

## Task 5: sync-engine.js — Diff + Status Helpers

**Files:**
- Modify: `lib/sync-engine.js`

**Step 1: Implement JSON-level diff**

```javascript
function diffSettings() {
  const repoSettings = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(repoSettings)) return [];

  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const remote = JSON.parse(fs.readFileSync(repoSettings, 'utf8'));

  const diffs = [];
  for (const key of SETTINGS_WHITELIST) {
    const l = JSON.stringify(local[key], null, 2);
    const r = JSON.stringify(remote[key], null, 2);
    if (l !== r) diffs.push({ field: key, local: local[key], remote: remote[key] });
  }
  return diffs;
}

function diffPluginConfigs() {
  const diffs = [];
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const repoFile = path.join(REPO_DIR, 'global', file);
    if (!fs.existsSync(repoFile)) continue;

    const remote = transformPathsForImport(JSON.parse(fs.readFileSync(repoFile, 'utf8')));
    const localPath = path.join(CLAUDE_HOME, 'plugins', file);
    const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};

    if (JSON.stringify(local) !== JSON.stringify(remote)) {
      diffs.push({ file, local, remote });
    }
  }
  return diffs;
}
```

**Step 2: Implement status helper**

```javascript
function getStatus() {
  if (!isInitialized()) return { initialized: false };

  const config = loadConfig();
  const lastSync = loadLastSync();
  const fetched = gitFetch(5000);
  let remoteUpdates = 0;
  let localChanges = false;

  if (fetched) {
    try {
      remoteUpdates = hasRemoteUpdates() ? getRemoteUpdateCount() : 0;
    } catch { remoteUpdates = -1; }
  }

  try {
    exportAll();
    localChanges = hasLocalChanges();
    if (localChanges) gitExec('checkout -- .'); // Undo export for status check
  } catch {}

  return {
    initialized: true,
    repoUrl: config?.repo || 'unknown',
    lastSync: lastSync.timestamp || 'never',
    remoteUpdates,
    localChanges,
    fetchFailed: !fetched,
  };
}
```

**Step 3: Export and commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: sync-engine diff and status helpers"
```

---

## Task 6: sync-engine.js — Init + Push + Pull Orchestrators

**Files:**
- Modify: `lib/sync-engine.js`

**Step 1: Implement init**

```javascript
function init(remoteUrl) {
  if (isInitialized()) throw new Error('Already initialized. Run /sync-uninstall first.');

  fs.mkdirSync(SYNC_DIR, { recursive: true });

  // Clone repo
  execSync(`git clone "${remoteUrl}" "${REPO_DIR}"`, { timeout: 60000, stdio: 'pipe' });

  // Check if repo has content
  const hasContent = fs.existsSync(path.join(REPO_DIR, 'global'));

  if (!hasContent) {
    // Fresh repo — export local settings
    exportAll();
    gitExec('add -A');
    gitExec('commit -m "Initial sync from first machine"');
    gitExec('push origin main');
  }

  saveConfig({ repo: remoteUrl, autoPull: false, autoPush: false });
  saveLastSync({ action: 'init' });

  return { hasContent, repoUrl: remoteUrl };
}
```

**Step 2: Implement push**

```javascript
function push() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');

  try {
    exportAll();

    if (!hasLocalChanges()) {
      releaseLock();
      return { pushed: false, reason: 'no-changes' };
    }

    gitExec('add -A');
    const hostname = require('os').hostname();
    gitExec(`commit -m "sync from ${hostname} at ${new Date().toISOString()}"`);

    try {
      gitExec('push origin main');
    } catch {
      // Push rejected — fetch and merge, then retry
      gitExec('fetch origin main');
      gitExec('merge origin/main --no-edit -X theirs'); // last-write-wins
      gitExec('push origin main');
    }

    saveLastSync({ action: 'push' });
    return { pushed: true };
  } finally {
    releaseLock();
  }
}
```

**Step 3: Implement pull**

```javascript
function pull() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');

  try {
    // Backup before pull
    const backupPath = createBackup();

    // Fetch and check for updates
    if (!gitFetch(30000)) throw new Error('Failed to fetch from remote. Check your network.');

    if (!hasRemoteUpdates()) {
      releaseLock();
      return { pulled: false, reason: 'up-to-date', backupPath };
    }

    // Merge
    try {
      gitExec('merge origin/main --no-edit');
    } catch {
      // Conflict — last-write-wins (accept theirs)
      gitExec('merge --abort');
      gitExec('reset --hard origin/main');
    }

    // Import to local
    const result = importAll();
    const missingPlugins = detectMissingPlugins();

    saveLastSync({ action: 'pull' });
    return { pulled: true, backupPath, ...result, missingPlugins };
  } finally {
    releaseLock();
  }
}
```

**Step 4: Implement uninstall**

```javascript
function uninstall() {
  const config = loadConfig();
  fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  return { repoUrl: config?.repo || null };
}
```

**Step 5: Export and commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: sync-engine init, push, pull, and uninstall orchestrators"
```

---

## Task 7: SessionStart Hook

**Files:**
- Modify: `hooks/session-start-check.js`

**Step 1: Implement the full hook**

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SYNC_REPO = path.join(process.env.HOME, '.claude', 'sync', 'repo');
const CONFIG_PATH = path.join(process.env.HOME, '.claude', 'sync', 'config.json');

try {
  // Exit silently if not initialized
  if (!fs.existsSync(SYNC_REPO) || !fs.existsSync(CONFIG_PATH)) process.exit(0);

  // Fetch with 5s timeout
  execSync('git fetch origin main', {
    cwd: SYNC_REPO,
    timeout: 5000,
    stdio: 'pipe',
  });

  // Compare local vs remote
  const local = execSync('git rev-parse HEAD', { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();
  const remote = execSync('git rev-parse origin/main', { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();

  if (local !== remote) {
    const count = execSync('git rev-list HEAD..origin/main --count', { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();
    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `[claude-sync] 遠端有 ${count} 個更新。執行 /sync-pull 來同步。`,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
} catch {
  // Silent failure — never block Claude Code startup
  process.exit(0);
}
```

**Step 2: Test the hook manually**

Run: `node hooks/session-start-check.js`

Expected: Exits silently with code 0 (since sync is not initialized).

**Step 3: Commit**

```bash
git add hooks/session-start-check.js
git commit -m "feat: SessionStart hook for passive remote update notification"
```

---

## Task 8: Command — /sync-init

**Files:**
- Create: `commands/sync-init.md`

**Step 1: Write the command**

```markdown
---
description: Initialize claude-sync — set up cloud sync for your Claude Code settings
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`
- git available: !`which git && echo "yes" || echo "no"`
- gh available: !`which gh 2>/dev/null && echo "yes" || echo "no"`
- gh auth status: !`gh auth status 2>&1 | head -3 || echo "not authenticated"`

## Your Task

Help the user initialize claude-sync. Follow these steps:

1. **Check if already initialized.** If yes, tell the user and suggest `/sync-uninstall` first.

2. **Check prerequisites.** `git` is required. `gh` is optional (for auto-creating GitHub repo).

3. **Ask the user**: Do they want to:
   - **(A) Create a new private GitHub repo** (requires `gh` CLI authenticated) — run:
     ```
     gh repo create claude-config-sync --private --clone --description "Claude Code settings sync"
     ```
     Then move the clone to `~/.claude/sync/repo/`.
   - **(B) Connect to an existing git repo** — ask for the remote URL.

4. **Run init.** Use the sync-engine:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const result = s.init('REMOTE_URL_HERE');
     console.log(JSON.stringify(result, null, 2));
   "
   ```

5. **Report results.** Tell the user:
   - If the repo was empty: "Settings exported and pushed."
   - If the repo had data: "Connected to existing sync repo. Run `/sync-pull` to import settings."
   - Remind: "Run `/sync-push` after changing settings. Run `/sync-pull` on other machines."

6. **Chezmoi check.** If `chezmoi managed 2>/dev/null | grep -q .claude`, warn about potential conflicts.

IMPORTANT: Replace `REMOTE_URL_HERE` with the actual URL before running.
```

**Step 2: Commit**

```bash
git add commands/sync-init.md
git commit -m "feat: /sync-init command for first-time setup"
```

---

## Task 9: Command — /sync-push

**Files:**
- Create: `commands/sync-push.md`

**Step 1: Write the command**

```markdown
---
description: Push local Claude Code settings to your sync repo
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Push the user's local Claude Code settings to their sync repo.

1. **Check initialized.** If not, tell user to run `/sync-init` first.

2. **Run push:**
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     try {
       const result = s.push();
       console.log(JSON.stringify(result, null, 2));
     } catch (e) {
       console.error('ERROR:', e.message);
     }
   "
   ```

3. **Report results:**
   - If `pushed: true`: "Settings pushed successfully."
   - If `pushed: false, reason: 'no-changes'`: "No changes to push. Already up to date."
   - If error: Show the error message and suggest troubleshooting.
```

**Step 2: Commit**

```bash
git add commands/sync-push.md
git commit -m "feat: /sync-push command"
```

---

## Task 10: Command — /sync-pull

**Files:**
- Create: `commands/sync-pull.md`

**Step 1: Write the command**

```markdown
---
description: Pull settings from your sync repo to this machine
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Pull settings from the user's sync repo and apply them locally.

1. **Check initialized.** If not, tell user to run `/sync-init` first.

2. **Show diff first** by running:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.gitFetch(10000);
     const diffs = s.diffSettings();
     const pluginDiffs = s.diffPluginConfigs();
     console.log(JSON.stringify({ settings: diffs, plugins: pluginDiffs }, null, 2));
   "
   ```

3. **Show the diff to the user** in a readable format. For each changed field, show local vs remote value.

4. **Ask for confirmation** before applying. If user confirms, run pull:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     try {
       const result = s.pull();
       console.log(JSON.stringify(result, null, 2));
     } catch (e) {
       console.error('ERROR:', e.message);
     }
   "
   ```

5. **Report results:**
   - Show what changed (settings fields, plugin configs, commands, rules)
   - Show backup location: "Backup saved to [path]"
   - If `missingPlugins` is non-empty: "The following plugins are in your sync list but not installed on this machine: [list]. Run `claude plugin update` to install them."
   - If `pulled: false`: "Already up to date."

6. **For rules/ changes**: Show full diff and ask user to explicitly confirm before applying. This is a security measure.
```

**Step 2: Commit**

```bash
git add commands/sync-pull.md
git commit -m "feat: /sync-pull command with diff preview and confirmation"
```

---

## Task 11: Commands — /sync-status, /sync-diff, /sync-restore, /sync-uninstall

**Files:**
- Create: `commands/sync-status.md`
- Create: `commands/sync-diff.md`
- Create: `commands/sync-restore.md`
- Create: `commands/sync-uninstall.md`

**Step 1: Write /sync-status**

```markdown
---
description: Show claude-sync status
---

## Context

- Sync status: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.getStatus(), null, 2))"`

## Your Task

Display the sync status to the user in a clear format:

- **Initialized**: yes/no
- **Repo URL**: the git remote
- **Last sync**: timestamp or "never"
- **Remote updates**: number available, or "fetch failed (offline?)"
- **Local changes**: yes/no (settings differ from last push)

If not initialized, suggest running `/sync-init`.
```

**Step 2: Write /sync-diff**

```markdown
---
description: Preview differences between local and remote settings
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Show JSON-level diff between local and remote settings.

1. Check initialized. If not, suggest `/sync-init`.

2. Fetch and diff:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.gitFetch(10000);
     const settings = s.diffSettings();
     const plugins = s.diffPluginConfigs();
     console.log(JSON.stringify({ settings, plugins }, null, 2));
   "
   ```

3. Display diffs in readable format. For each changed field show:
   - Field name
   - Local value
   - Remote value

4. If no differences: "Local and remote are in sync."
```

**Step 3: Write /sync-restore**

```markdown
---
description: Restore settings from a backup
---

## Context

- Available backups: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.listBackups()))"`

## Your Task

Help the user restore settings from a backup.

1. List available backups with timestamps.
2. If no backups: "No backups available."
3. Ask user which backup to restore.
4. Run restore:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.restoreBackup('BACKUP_NAME_HERE');
     console.log('Restored successfully');
   "
   ```
5. Confirm what was restored.
```

**Step 4: Write /sync-uninstall**

```markdown
---
description: Remove claude-sync and clean up all local data
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`
- Config: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); const c = s.loadConfig(); console.log(JSON.stringify(c))"`

## Your Task

Help the user cleanly remove claude-sync.

1. Warn the user: "This will remove all local sync data (config, repo clone, backups)."
2. Ask for confirmation.
3. Run uninstall:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const result = s.uninstall();
     console.log(JSON.stringify(result));
   "
   ```
4. If repoUrl was returned, tell user: "Your remote repo at [URL] still exists. If you no longer need it, delete it manually on GitHub (or run `gh repo delete [repo] --yes`)."
5. Tell user: "Local sync data removed. Your current settings are unchanged. To fully remove the plugin, disable it in Claude Code plugin settings."
```

**Step 5: Commit**

```bash
git add commands/
git commit -m "feat: /sync-status, /sync-diff, /sync-restore, /sync-uninstall commands"
```

---

## Task 12: Integration Test + Final Polish

**Files:**
- Modify: `lib/sync-engine.js` (if needed)
- Create: `README.md`

**Step 1: End-to-end manual test**

Run the following sequence to verify everything works:

```bash
# 1. Verify plugin structure
find . -not -path './.git/*' -not -path './.git' -type f | sort

# 2. Verify sync-engine loads without errors
node -e "const s = require('./lib/sync-engine.js'); console.log(Object.keys(s).join(', '))"

# 3. Verify hook runs without errors
node hooks/session-start-check.js; echo "exit code: $?"

# 4. Verify all exports exist
node -e "
const s = require('./lib/sync-engine.js');
const required = ['init','push','pull','exportAll','importAll','createBackup',
  'restoreBackup','listBackups','getStatus','diffSettings','diffPluginConfigs',
  'detectMissingPlugins','uninstall','isInitialized'];
const missing = required.filter(f => typeof s[f] !== 'function');
if (missing.length) { console.error('MISSING:', missing); process.exit(1); }
console.log('All', required.length, 'functions exported correctly');
"
```

Expected: All checks pass.

**Step 2: Write README.md**

Create a concise README covering:
- What it does (1 paragraph)
- Install: `claude plugin install claude-sync` (or local install for dev)
- Quick start: `/sync-init` → `/sync-push` → (other machine) `/sync-init` → `/sync-pull`
- Commands list (7 commands, one line each)
- What gets synced / what doesn't
- Security notes
- License

**Step 3: Commit**

```bash
git add README.md lib/sync-engine.js
git commit -m "docs: add README and polish sync-engine"
```

---

## Summary

| Task | Description | Est. Lines |
|------|------------|------------|
| 1 | Plugin scaffold | Config files |
| 2 | Git helpers + config management | ~60 |
| 3 | Export (local → repo) | ~60 |
| 4 | Import (repo → local) + backup | ~80 |
| 5 | Diff + status helpers | ~50 |
| 6 | Init/push/pull/uninstall orchestrators | ~80 |
| 7 | SessionStart hook | ~30 |
| 8 | /sync-init command | ~30 (MD) |
| 9 | /sync-push command | ~20 (MD) |
| 10 | /sync-pull command | ~30 (MD) |
| 11 | 4 remaining commands | ~60 (MD) |
| 12 | Integration test + README | ~50 (MD) |
| **Total** | | **~550** |
