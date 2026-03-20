# Expand Sync Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand claude-sync to sync `skills/`, `hooks/`, and plugin data; fix `pull()` to export before merge so smart merge sees both sides; add diff visibility and security confirmation for new sync items.

**Architecture:** Fix the core `pull()` flow to export+commit local state before merging (existing bug). Add `skills` and `hooks` to user-config sync. Create `exportPluginData()`/`importPluginData()` for selective plugin data sync. Add `blocklist.json` to smart merge. Add directory-level diff functions. Update commands and docs.

**Tech Stack:** Node.js (fs, path), Git

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `lib/sync-engine.js` | Core sync logic | Modify (all tasks) |
| `commands/sync-pull.md` | Pull command instructions | Modify (security + report) |
| `commands/sync-diff.md` | Diff command instructions | Modify (new diff functions) |
| `commands/sync-restore.md` | Restore command instructions | Modify (report text) |
| `README.md` | English documentation | Modify (sync scope tables) |
| `README.zh-TW.md` | Chinese documentation | Modify (sync scope tables) |

---

### Task 1: Fix `pull()` to export+commit before merge (bug fix)

**Problem:** `pull()` runs `performSmartMerge()` without first exporting the current local `~/.claude/` state to the repo. Smart merge only sees the repo's last committed state (from the last push), not the actual current local state. This means local changes since the last push are invisible to the merge and get silently overwritten by `importAll()`.

**Fix:** Export and commit local state before fetching and merging. This makes smart merge a true three-way merge between current-local, last-common-ancestor, and remote.

**Files:**
- Modify: `lib/sync-engine.js:560-603` (`pull()`)

- [ ] **Step 1: Update `pull()` to export+commit before merge**

Replace the current `pull()` function:

```js
function pull() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');
  try {
    const backupPath = createBackup();

    // Export current local state and commit so smart merge sees both sides
    exportAll();
    if (hasLocalChanges()) {
      gitExec('add -A');
      const hostname = require('os').hostname();
      gitExec(`commit -m "pre-pull export from ${hostname} at ${new Date().toISOString()}"`);
    }

    if (!gitFetch(30000)) throw new Error('Failed to fetch from remote. Check your network.');
    if (!hasRemoteUpdates()) {
      return { pulled: false, reason: 'up-to-date', backupPath };
    }
    const mergeResult = performSmartMerge('remote', 'theirs');
    const result = importAll();
    const missingPlugins = detectMissingPlugins();
    saveLastSync({ action: 'pull' });
    return { pulled: true, backupPath, ...result, missingPlugins, ...mergeResult };
  } finally {
    releaseLock();
  }
}
```

- [ ] **Step 2: Verify pull still works**

```bash
cd /Users/joe/temp_proj/cc-sync/claude-sync
node -e "
  const s = require('./lib/sync-engine.js');
  // Dry-run: just verify the function loads without syntax errors
  console.log('pull function exists:', typeof s.pull === 'function');
"
```

- [ ] **Step 3: Commit**

```bash
git add lib/sync-engine.js
git commit -m "fix: export local state before merge in pull() for correct 3-way merge"
```

---

### Task 2: Add `skills/` and `hooks/` to user-config sync

**Files:**
- Modify: `lib/sync-engine.js` — 4 functions with directory lists

The constant `USER_CONFIG_DIRS` should be extracted to avoid repetition.

- [ ] **Step 1: Add `USER_CONFIG_DIRS` constant and update all 4 functions**

Add near the top of the file (after line 15):

```js
const USER_CONFIG_DIRS = ['commands', 'rules', 'agents', 'skills', 'hooks'];
```

Then update these 4 functions to use it:

`exportUserConfig()` line 163:
```js
for (const dir of USER_CONFIG_DIRS) {
```

`createBackup()` line 200:
```js
for (const dir of USER_CONFIG_DIRS) {
```

`restoreBackup()` line 232:
```js
for (const dir of USER_CONFIG_DIRS) {
```

`importUserConfig()` line 287:
```js
for (const dir of USER_CONFIG_DIRS) {
```

- [ ] **Step 2: Verify export works**

```bash
node -e "
  const s = require('./lib/sync-engine.js');
  s.exportUserConfig();
  const fs = require('fs');
  const path = require('path');
  const repo = s.REPO_DIR;
  console.log('skills:', fs.existsSync(path.join(repo, 'user-config/skills')));
  console.log('hooks:', fs.existsSync(path.join(repo, 'user-config/hooks')));
"
```

Expected: both `true`

- [ ] **Step 3: Commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: add skills/ and hooks/ to sync scope"
```

---

### Task 3: Add plugin data sync (CLAUDE.md, blocklist.json, data/)

**Files:**
- Modify: `lib/sync-engine.js` — add constants, `exportPluginData()`, `importPluginData()`, update `exportAll()`, `importAll()`, `createBackup()`, `restoreBackup()`, `removeStalePaths()`, module.exports

**Design:** Sync files/dirs from `~/.claude/plugins/` to `repo/global/plugin-data/`, excluding rebuildable content.

- [ ] **Step 1: Add `PLUGIN_DATA_EXCLUDE` constant**

Add near `USER_CONFIG_DIRS`:

```js
const PLUGIN_DATA_EXCLUDE = new Set([
  'cache', 'marketplaces',
  'installed_plugins.json', 'known_marketplaces.json',
  'install-counts-cache.json', '.DS_Store',
]);
```

- [ ] **Step 2: Update `removeStalePaths()` to support exclude set**

```js
function removeStalePaths(src, dest, exclude) {
  if (!fs.existsSync(dest)) return;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (exclude && exclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!fs.existsSync(srcPath)) {
      fs.rmSync(destPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeStalePaths(srcPath, destPath);
    }
  }
}
```

Existing callers pass no third arg — default `undefined` preserves behavior.

- [ ] **Step 3: Add `exportPluginData()`**

Insert after `exportPluginConfigs()`:

```js
function exportPluginData() {
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;
  const outDir = path.join(REPO_DIR, 'global', 'plugin-data');
  fs.mkdirSync(outDir, { recursive: true });
  removeStalePaths(pluginsDir, outDir, PLUGIN_DATA_EXCLUDE);
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (PLUGIN_DATA_EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(pluginsDir, entry.name);
    const destPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
```

- [ ] **Step 4: Add `importPluginData()`**

Insert after `importPluginConfigs()`:

```js
function importPluginData() {
  const srcDir = path.join(REPO_DIR, 'global', 'plugin-data');
  if (!fs.existsSync(srcDir)) return [];
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const changes = [];
  removeStalePaths(srcDir, pluginsDir, PLUGIN_DATA_EXCLUDE);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(pluginsDir, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
    changes.push(entry.name);
  }
  return changes;
}
```

- [ ] **Step 5: Update `exportAll()`**

```js
function exportAll() {
  exportSettings();
  exportPluginConfigs();
  exportPluginData();
  exportUserConfig();
}
```

- [ ] **Step 6: Update `importAll()`**

```js
function importAll() {
  const settingsResult = importSettings();
  const pluginChanges = importPluginConfigs();
  const pluginDataChanges = importPluginData();
  const configChanges = importUserConfig();
  return { settingsResult, pluginChanges, pluginDataChanges, configChanges };
}
```

- [ ] **Step 7: Update `createBackup()` to backup plugin data**

After the existing plugin file backup loop, add:

```js
// Backup plugin data (CLAUDE.md, blocklist.json, data/, etc.)
const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
if (fs.existsSync(pluginsDir)) {
  const pluginDataBackup = path.join(backupPath, 'plugin-data');
  fs.mkdirSync(pluginDataBackup, { recursive: true });
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (PLUGIN_DATA_EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(pluginsDir, entry.name);
    const destPath = path.join(pluginDataBackup, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
```

- [ ] **Step 8: Update `restoreBackup()` to restore plugin data**

After the existing plugin file restore loop, add:

```js
const pluginDataBackup = path.join(backupPath, 'plugin-data');
if (fs.existsSync(pluginDataBackup)) {
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  for (const entry of fs.readdirSync(pluginDataBackup, { withFileTypes: true })) {
    const srcPath = path.join(pluginDataBackup, entry.name);
    const destPath = path.join(pluginsDir, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
```

- [ ] **Step 9: Update module.exports**

Add to exports:

```js
exportPluginData, importPluginData,
```

- [ ] **Step 10: Verify export works**

```bash
node -e "
  const s = require('./lib/sync-engine.js');
  s.exportAll();
  const fs = require('fs');
  const path = require('path');
  const pd = path.join(s.REPO_DIR, 'global/plugin-data');
  console.log('plugin-data exists:', fs.existsSync(pd));
  if (fs.existsSync(pd)) console.log('contents:', fs.readdirSync(pd));
"
```

Expected: directory exists with `CLAUDE.md`, `blocklist.json`, `data/`, `cc-caffeine/`, `claude-hud/`

- [ ] **Step 11: Commit**

```bash
git add lib/sync-engine.js
git commit -m "feat: add plugin data sync (CLAUDE.md, blocklist, data dirs)"
```

---

### Task 4: Add `blocklist.json` to Smart Merge + fix `getStatus()`

**Files:**
- Modify: `lib/sync-engine.js` — `MERGE_JSON_FILES`, `getStatus()`

- [ ] **Step 1: Add `blocklist.json` to `MERGE_JSON_FILES`**

```js
const MERGE_JSON_FILES = [
  'global/settings.json',
  'global/installed_plugins.json',
  'global/known_marketplaces.json',
  'global/plugin-data/blocklist.json',
];
```

- [ ] **Step 2: Fix `getStatus()` to clean untracked files**

The current `getStatus()` calls `exportAll()` to check for local changes, then `git checkout -- .` to revert. But `checkout` only reverts tracked files — untracked files from export remain. Add `git clean -fd`:

```js
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
  } catch {}
  try { gitExec('checkout -- .'); } catch {}
  try { gitExec('clean -fd'); } catch {}
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

- [ ] **Step 3: Commit**

```bash
git add lib/sync-engine.js
git commit -m "fix: add blocklist.json to smart merge, clean untracked files in getStatus()"
```

---

### Task 5: Add diff functions for new sync scope

**Problem:** `/sync-diff` only shows `diffSettings()` and `diffPluginConfigs()`. New sync items (skills, hooks, plugin data) have no diff visibility.

**Files:**
- Modify: `lib/sync-engine.js` — add `diffUserConfig()`, `diffPluginData()`
- Modify: `commands/sync-diff.md` — call new diff functions

- [ ] **Step 1: Add `diffUserConfig()`**

Insert after `diffPluginConfigs()`:

```js
function diffUserConfig() {
  const diffs = [];
  for (const dir of USER_CONFIG_DIRS) {
    const repoDir = path.join(REPO_DIR, 'user-config', dir);
    const localDir = path.join(CLAUDE_HOME, dir);
    const repoFiles = listFilesRecursive(repoDir);
    const localFiles = listFilesRecursive(localDir);
    const allFiles = new Set([...repoFiles, ...localFiles]);
    for (const file of allFiles) {
      const inRepo = repoFiles.has(file);
      const inLocal = localFiles.has(file);
      if (inRepo && inLocal) {
        const repoContent = fs.readFileSync(path.join(repoDir, file), 'utf8');
        const localContent = fs.readFileSync(path.join(localDir, file), 'utf8');
        if (repoContent !== localContent) {
          diffs.push({ dir, file, status: 'modified' });
        }
      } else if (inLocal && !inRepo) {
        diffs.push({ dir, file, status: 'local-only' });
      } else {
        diffs.push({ dir, file, status: 'remote-only' });
      }
    }
  }
  return diffs;
}

function listFilesRecursive(dir, prefix) {
  const files = new Set();
  if (!fs.existsSync(dir)) return files;
  prefix = prefix || '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const f of listFilesRecursive(path.join(dir, entry.name), rel)) {
        files.add(f);
      }
    } else {
      files.add(rel);
    }
  }
  return files;
}
```

- [ ] **Step 2: Add `diffPluginData()`**

```js
function diffPluginData() {
  const repoDir = path.join(REPO_DIR, 'global', 'plugin-data');
  const localDir = path.join(CLAUDE_HOME, 'plugins');
  const repoPaths = listFilesRecursive(repoDir);
  const localPaths = new Set();
  // Only list non-excluded entries from local plugins dir
  if (fs.existsSync(localDir)) {
    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (PLUGIN_DATA_EXCLUDE.has(entry.name)) continue;
      if (entry.isDirectory()) {
        for (const f of listFilesRecursive(path.join(localDir, entry.name), entry.name)) {
          localPaths.add(f);
        }
      } else if (entry.name !== '.DS_Store') {
        localPaths.add(entry.name);
      }
    }
  }
  const diffs = [];
  const allFiles = new Set([...repoPaths, ...localPaths]);
  for (const file of allFiles) {
    const inRepo = repoPaths.has(file);
    const inLocal = localPaths.has(file);
    if (inRepo && inLocal) {
      const repoContent = fs.readFileSync(path.join(repoDir, file), 'utf8');
      const localContent = fs.readFileSync(path.join(localDir, file), 'utf8');
      if (repoContent !== localContent) {
        diffs.push({ file, status: 'modified' });
      }
    } else if (inLocal && !inRepo) {
      diffs.push({ file, status: 'local-only' });
    } else {
      diffs.push({ file, status: 'remote-only' });
    }
  }
  return diffs;
}
```

- [ ] **Step 3: Update module.exports**

Add:

```js
diffUserConfig, diffPluginData, listFilesRecursive,
```

- [ ] **Step 4: Update `commands/sync-diff.md`**

Update the diff command to call all 4 diff functions:

```bash
node -e "
  const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
  s.gitFetch(10000);
  const settings = s.diffSettings();
  const plugins = s.diffPluginConfigs();
  const userConfig = s.diffUserConfig();
  const pluginData = s.diffPluginData();
  console.log(JSON.stringify({ settings, plugins, userConfig, pluginData }, null, 2));
"
```

Update the display instructions to show:
- Settings diffs: field-level (existing)
- Plugin config diffs: file-level (existing)
- User config diffs: file-level with status (new/modified/deleted) grouped by directory (skills, hooks, commands, rules, agents)
- Plugin data diffs: file-level with status

- [ ] **Step 5: Commit**

```bash
git add lib/sync-engine.js commands/sync-diff.md
git commit -m "feat: add diff functions for user-config and plugin-data"
```

---

### Task 6: Update commands — security confirmation + report text

**Files:**
- Modify: `commands/sync-pull.md`
- Modify: `commands/sync-restore.md`

- [ ] **Step 1: Update `sync-pull.md` security confirmation**

Current step 6 requires confirmation for `rules/` changes only. Expand to also require confirmation for `skills/` (may contain JS) and `hooks/` (contains shell scripts):

Change step 6 from:
> For rules/ changes: Show full diff and ask user to explicitly confirm before applying.

To:
> For `rules/`, `skills/`, and `hooks/` changes: Show full diff and ask user to explicitly confirm before applying. These directories may contain executable code (JS, shell scripts) — applying untrusted changes is a security risk.

- [ ] **Step 2: Update `sync-pull.md` report text**

Update step 5 from:
> Show what changed (settings fields, plugin configs, commands, rules)

To:
> Show what changed (settings fields, plugin configs, plugin data, commands, rules, agents, skills, hooks)

- [ ] **Step 3: Update `sync-restore.md` report text**

Update step 5 from:
> Confirm what was restored (settings, plugin configs, commands, rules, agents).

To:
> Confirm what was restored (settings, plugin configs, plugin data, commands, rules, agents, skills, hooks).

- [ ] **Step 4: Commit**

```bash
git add commands/sync-pull.md commands/sync-restore.md
git commit -m "feat: expand security confirmation to skills/hooks, update report text"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-TW.md`

- [ ] **Step 1: Update README.md**

Add to "What Gets Synced" table:
- `~/.claude/skills/` → `user-config/skills/` (custom skills)
- `~/.claude/hooks/` → `user-config/hooks/` (hook scripts)
- `~/.claude/plugins/` (selective) → `global/plugin-data/` (CLAUDE.md, blocklist.json, data/, plugin-specific dirs; excludes cache/ and marketplaces/)

Update "What Does NOT Get Synced" to clarify `plugins/cache/` and `plugins/marketplaces/` are excluded (auto-rebuilt on pull).

Add note about `pull()` now exporting local state before merge for correct 3-way merge.

- [ ] **Step 2: Update README.zh-TW.md**

Same changes in Traditional Chinese.

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-TW.md
git commit -m "docs: update sync scope documentation for expanded sync"
```
