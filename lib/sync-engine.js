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
const LOCK_PATH = path.join(SYNC_DIR, '.sync.lock');
const SETTINGS_BLACKLIST = ['statusLine'];

// ---------------------------------------------------------------------------
// Task 2: Git Helpers + Config Management
// ---------------------------------------------------------------------------

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

function safeGitShow(ref, filePath) {
  try {
    return gitExec(`show ${ref}:${filePath}`);
  } catch {
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// Task 3: Export Functions (local -> repo)
// ---------------------------------------------------------------------------

function exportSettings() {
  const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  const full = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const filtered = {};
  for (const key of Object.keys(full)) {
    if (!SETTINGS_BLACKLIST.includes(key)) filtered[key] = full[key];
  }
  const outDir = path.join(REPO_DIR, 'global');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'settings.json'), JSON.stringify(filtered, null, 2));
}

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

function removeStalePaths(src, dest) {
  if (!fs.existsSync(dest)) return;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!fs.existsSync(srcPath)) {
      fs.rmSync(destPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeStalePaths(srcPath, destPath);
    }
  }
}

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
  for (const dir of ['commands', 'rules', 'agents']) {
    copyDirSync(path.join(CLAUDE_HOME, dir), path.join(configDir, dir));
  }
  const claudeMdSrc = path.join(CLAUDE_HOME, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(claudeMdSrc, path.join(configDir, 'CLAUDE.md'));
  }
}

function exportAll() {
  exportSettings();
  exportPluginConfigs();
  exportUserConfig();
}

// ---------------------------------------------------------------------------
// Task 4: Import Functions + Backup
// ---------------------------------------------------------------------------

function createBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `backup-${ts}`);
  fs.mkdirSync(backupPath);
  const settingsSrc = path.join(CLAUDE_HOME, 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    fs.copyFileSync(settingsSrc, path.join(backupPath, 'settings.json'));
  }
  const claudeMdSrc = path.join(CLAUDE_HOME, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(backupPath, 'CLAUDE.md'));
  }
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    const src = path.join(CLAUDE_HOME, 'plugins', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupPath, f));
  }
  for (const dir of ['commands', 'rules', 'agents']) {
    const src = path.join(CLAUDE_HOME, dir);
    if (fs.existsSync(src)) copyDirSync(src, path.join(backupPath, dir));
  }
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
  const claudeMdBackup = path.join(backupPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdBackup)) {
    fs.copyFileSync(claudeMdBackup, path.join(CLAUDE_HOME, 'CLAUDE.md'));
  }
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    const src = path.join(backupPath, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(CLAUDE_HOME, 'plugins', f));
  }
  for (const dir of ['commands', 'rules', 'agents']) {
    const src = path.join(backupPath, dir);
    if (fs.existsSync(src)) {
      const dest = path.join(CLAUDE_HOME, dir);
      fs.rmSync(dest, { recursive: true, force: true });
      copyDirSync(src, dest);
    }
  }
}

function importSettings() {
  const repoSettings = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(repoSettings)) return { changed: false };
  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const remote = JSON.parse(fs.readFileSync(repoSettings, 'utf8'));
  const changes = {};
  for (const key of Object.keys(remote)) {
    if (SETTINGS_BLACKLIST.includes(key)) continue;
    if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) {
      changes[key] = { from: local[key], to: remote[key] };
      local[key] = remote[key];
    }
  }
  if (Object.keys(changes).length > 0) {
    // Preserve blacklisted fields from local
    const localFull = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
    for (const key of SETTINGS_BLACKLIST) {
      if (key in localFull) local[key] = localFull[key];
    }
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
    return { changed: true, changes };
  }
  return { changed: false };
}

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

function importUserConfig() {
  const changes = [];
  for (const dir of ['commands', 'rules', 'agents']) {
    const src = path.join(REPO_DIR, 'user-config', dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(CLAUDE_HOME, dir);
    // Mirror sync: remove stale files in destination that don't exist in source
    if (fs.existsSync(dest)) {
      removeStalePaths(src, dest);
    }
    copyDirSync(src, dest);
    changes.push(dir);
  }
  const claudeMdSrc = path.join(REPO_DIR, 'user-config', 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(CLAUDE_HOME, 'CLAUDE.md'));
    changes.push('CLAUDE.md');
  }
  return changes;
}

function importAll() {
  const settingsResult = importSettings();
  const pluginChanges = importPluginConfigs();
  const configChanges = importUserConfig();
  return { settingsResult, pluginChanges, configChanges };
}

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

function detectMissingMarketplaces() {
  const mpPath = path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json');
  if (!fs.existsSync(mpPath)) return [];
  const data = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  const missing = [];
  for (const [name, info] of Object.entries(data)) {
    if (info.installLocation && !fs.existsSync(info.installLocation)) {
      missing.push({
        name,
        source: info.source?.source || 'github',
        repo: info.source?.repo || name,
      });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Smart Merge
// ---------------------------------------------------------------------------

const MERGE_JSON_FILES = [
  'global/settings.json',
  'global/installed_plugins.json',
  'global/known_marketplaces.json',
];

function safeMergeBase() {
  try {
    return gitExec('merge-base HEAD origin/main');
  } catch {
    throw new Error(
      '無法計算合併基準（本地與遠端沒有共同歷史）。\n' +
      '這通常表示遠端 repo 被重建過。\n' +
      '建議：執行 /sync-uninstall 後重新 /sync-init。'
    );
  }
}

function performSmartMerge(preference, fallbackStrategy) {
  const base = safeMergeBase();
  const allConflicts = [];
  const mergeWarnings = [];
  const mergedFiles = {};
  for (const file of MERGE_JSON_FILES) {
    const b = safeGitShow(base, file);
    const l = safeGitShow('HEAD', file);
    const r = safeGitShow('origin/main', file);
    if (b != null && l != null && r != null) {
      try {
        const m = mergeJsonFields(JSON.parse(b), JSON.parse(l), JSON.parse(r), preference);
        mergedFiles[file] = m.result;
        allConflicts.push(...m.conflicts);
      } catch (e) {
        mergeWarnings.push({ file, error: e.message });
      }
    }
  }

  // Git merge for non-JSON files
  try {
    gitExec('merge origin/main --no-edit');
  } catch {
    gitExec('merge --abort');
    gitExec(`merge origin/main --no-edit -X ${fallbackStrategy}`);
  }

  // Overwrite JSON files with field-level merge results
  let needsFixup = false;
  for (const [file, merged] of Object.entries(mergedFiles)) {
    const filePath = path.join(REPO_DIR, file);
    const content = JSON.stringify(merged, null, 2);
    if (fs.readFileSync(filePath, 'utf8') !== content) {
      fs.writeFileSync(filePath, content);
      needsFixup = true;
    }
  }
  if (needsFixup) {
    gitExec('add -A');
    gitExec('commit --amend --no-edit');
  }

  return { mergeConflicts: allConflicts, mergeWarnings };
}

function mergeJsonFields(base, local, remote, preference) {
  const result = {};
  const conflicts = [];
  const allKeys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(local || {}),
    ...Object.keys(remote || {}),
  ]);
  for (const key of allKeys) {
    const inBase = base != null && key in base;
    const inLocal = local != null && key in local;
    const inRemote = remote != null && key in remote;
    const baseVal = inBase ? JSON.stringify(base[key]) : undefined;
    const localVal = inLocal ? JSON.stringify(local[key]) : undefined;
    const remoteVal = inRemote ? JSON.stringify(remote[key]) : undefined;
    const localChanged = localVal !== baseVal;
    const remoteChanged = remoteVal !== baseVal;

    if (!localChanged && !remoteChanged) {
      if (inBase) result[key] = base[key];
    } else if (localChanged && !remoteChanged) {
      if (inLocal) result[key] = local[key];
    } else if (!localChanged && remoteChanged) {
      if (inRemote) result[key] = remote[key];
    } else {
      // Both changed
      if (localVal === remoteVal) {
        if (inLocal) result[key] = local[key];
      } else {
        conflicts.push({
          key,
          localValue: inLocal ? local[key] : undefined,
          remoteValue: inRemote ? remote[key] : undefined,
          localDeleted: !inLocal,
          remoteDeleted: !inRemote,
        });
        const winner = preference === 'local'
          ? (inLocal ? local[key] : undefined)
          : (inRemote ? remote[key] : undefined);
        const winnerExists = preference === 'local' ? inLocal : inRemote;
        if (winnerExists) result[key] = winner;
      }
    }
  }
  return { result, conflicts };
}

// ---------------------------------------------------------------------------
// Task 5: Diff + Status Helpers
// ---------------------------------------------------------------------------

function diffSettings() {
  const repoSettings = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(repoSettings)) return [];
  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const remote = JSON.parse(fs.readFileSync(repoSettings, 'utf8'));
  const diffs = [];
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of allKeys) {
    if (SETTINGS_BLACKLIST.includes(key)) continue;
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
  return {
    initialized: true,
    repoUrl: config?.repo || 'unknown',
    lastSync: lastSync.timestamp || 'never',
    remoteUpdates,
    localChanges,
    fetchFailed: !fetched,
  };
}

// ---------------------------------------------------------------------------
// Task 6: Init/Push/Pull/Uninstall Orchestrators
// ---------------------------------------------------------------------------

function ensureGitIdentity() {
  try {
    gitExec('config user.name');
  } catch {
    // No local identity — try to inherit from global, or use defaults
    let name = 'claude-sync';
    let email = 'claude-sync@localhost';
    try { name = execSync('git config --global user.name', { stdio: 'pipe' }).toString().trim(); } catch {}
    try { email = execSync('git config --global user.email', { stdio: 'pipe' }).toString().trim(); } catch {}
    gitExec(`config user.name "${name}"`);
    gitExec(`config user.email "${email}"`);
  }
}

function init(remoteUrl) {
  if (isInitialized()) throw new Error('Already initialized. Run /sync-uninstall first.');
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  execSync(`git clone "${remoteUrl}" "${REPO_DIR}"`, { timeout: 60000, stdio: 'pipe' });
  ensureGitIdentity();
  const hasContent = fs.existsSync(path.join(REPO_DIR, 'global'));
  if (!hasContent) {
    exportAll();
    gitExec('add -A');
    gitExec('commit -m "Initial sync from first machine"');
    gitExec('push origin main');
  }
  saveConfig({ repo: remoteUrl, autoPull: false, autoPush: false });
  saveLastSync({ action: 'init' });
  return { hasContent, repoUrl: remoteUrl };
}

function push() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');
  try {
    exportAll();
    if (!hasLocalChanges()) {
      return { pushed: false, reason: 'no-changes' };
    }
    gitExec('add -A');
    const hostname = require('os').hostname();
    gitExec(`commit -m "sync from ${hostname} at ${new Date().toISOString()}"`);
    let mergeResult = {};
    try {
      gitExec('push origin main');
    } catch {
      gitExec('fetch origin main');
      mergeResult = performSmartMerge('local', 'ours');
      gitExec('push origin main');
    }
    saveLastSync({ action: 'push' });
    return { pushed: true, ...mergeResult };
  } finally {
    releaseLock();
  }
}

function pull() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');
  try {
    const backupPath = createBackup();
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

function uninstall() {
  const config = loadConfig();
  fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  return { repoUrl: config?.repo || null };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  CLAUDE_HOME, SYNC_DIR, REPO_DIR, CONFIG_PATH, MAPPING_PATH, LAST_SYNC_PATH, BACKUP_DIR,
  // Git helpers
  gitExec, gitFetch, hasRemoteUpdates, getRemoteUpdateCount, hasLocalChanges,
  // Config
  loadConfig, saveConfig, loadLastSync, saveLastSync, isInitialized,
  // Lock
  acquireLock, releaseLock,
  // Export
  exportSettings, exportPluginConfigs, exportUserConfig, exportAll,
  transformPathsForExport, transformPathsForImport, copyDirSync, removeStalePaths,
  // Import + Backup
  createBackup, listBackups, restoreBackup,
  importSettings, importPluginConfigs, importUserConfig, importAll,
  detectMissingPlugins, detectMissingMarketplaces,
  // Smart Merge
  safeGitShow, mergeJsonFields,
  // Diff + Status
  diffSettings, diffPluginConfigs, getStatus,
  // Orchestrators
  init, push, pull, uninstall,
};
