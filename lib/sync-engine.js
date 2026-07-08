'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// CLAUDE_SYNC_HOME lets tests (and advanced users) point the engine at an
// isolated directory instead of the real ~/.claude. os.homedir() is used as
// the fallback (instead of reading the HOME env var directly) so this
// doesn't throw on Windows, where HOME is usually undefined (see
// USERPROFILE instead).
const CLAUDE_HOME = process.env.CLAUDE_SYNC_HOME ?? path.join(os.homedir(), '.claude');
const SYNC_DIR = path.join(CLAUDE_HOME, 'sync');
const REPO_DIR = path.join(SYNC_DIR, 'repo');
const CONFIG_PATH = path.join(SYNC_DIR, 'config.json');
const MAPPING_PATH = path.join(SYNC_DIR, 'mapping.json');
const LAST_SYNC_PATH = path.join(SYNC_DIR, 'last-sync.json');
const BACKUP_DIR = path.join(CLAUDE_HOME, 'sync-backups');
const LOCK_PATH = path.join(SYNC_DIR, '.sync.lock');
const SETTINGS_BLACKLIST = ['statusLine'];

// Built-in user-config dirs that have always been synced. They remain the
// default even if a config file lacks an explicit allow list, so existing
// installs keep their behaviour after upgrading.
const DEFAULT_USER_CONFIG_DIRS = ['commands', 'rules', 'agents', 'skills', 'hooks'];

// Top-level entries under ~/.claude that must NEVER be synced. Includes
// machine-local state, the sync infrastructure itself (would loop), and
// 'plugins' which has its own dedicated export/import path.
const SYSTEM_EXCLUDE_DIRS = new Set([
  'plugins',
  'sync', 'sync-backups', 'backups',
  'cache', 'downloads',
  'sessions', 'projects',
  'shell-snapshots', 'file-history', 'ide', 'session-env',
  'plans', 'tasks', 'todos', 'teams', 'debug',
]);

const PLUGIN_DATA_EXCLUDE = new Set([
  'cache', 'marketplaces',
  'installed_plugins.json', 'known_marketplaces.json',
  'install-counts-cache.json', '.DS_Store',
]);

// ---------------------------------------------------------------------------
// Task 2: Git Helpers + Config Management
// ---------------------------------------------------------------------------

// B-01: run git via execFileSync with an argv array (NO shell), so no
// argument can ever be interpreted by a shell. Every engine call site passes
// an explicit array of args (e.g. ['rev-parse', 'HEAD']); dynamic values
// (refs, paths, commit messages, identity) are individual array elements and
// are never string-interpolated into a command line. `-C REPO_DIR` scopes the
// command to the sync repo, matching the previous `cwd: REPO_DIR` default.
function gitExecFile(args, opts = {}) {
  const defaults = { timeout: 30000, stdio: 'pipe' };
  return execFileSync('git', ['-C', REPO_DIR, ...args], { ...defaults, ...opts })
    .toString().trim();
}

// Deprecated shell-free compatibility shim. Kept ONLY so external callers that
// still pass a FIXED command string keep working (currently just
// hooks/session-end-check.js -> gitExec('checkout -- .')). It splits on
// whitespace and forwards to gitExecFile, so it is safe for hard-coded
// strings but MUST NOT be used with untrusted/interpolated input — new code
// must call gitExecFile(args) with an explicit array instead.
function gitExec(cmdString, opts = {}) {
  return gitExecFile(String(cmdString).split(/\s+/).filter(Boolean), opts);
}

function gitFetch(timeoutMs = 5000) {
  try {
    gitExecFile(['fetch', 'origin', 'main'], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function hasRemoteUpdates() {
  const local = gitExecFile(['rev-parse', 'HEAD']);
  const remote = gitExecFile(['rev-parse', 'origin/main']);
  return local !== remote;
}

function getRemoteUpdateCount() {
  return parseInt(gitExecFile(['rev-list', 'HEAD..origin/main', '--count']), 10);
}

function hasLocalChanges() {
  const status = gitExecFile(['status', '--porcelain']);
  return status.length > 0;
}

// Read file contents from a git ref. Unlike gitExecFile, this does NOT trim
// the output — file content compare must preserve trailing newlines or the
// caller will see false-positive diffs against the working tree. `ref:path`
// is a single argv element, so no shell parses it (B-01).
function safeGitShow(ref, filePath) {
  try {
    return execFileSync('git', ['-C', REPO_DIR, 'show', `${ref}:${filePath}`], {
      timeout: 30000, stdio: 'pipe',
    }).toString();
  } catch {
    return null;
  }
}

// B-01: allow-list a remote URL before it is handed to `git clone`. Even with
// execFileSync (no shell), a hostile remote can still be treated as a git
// option when it starts with '-' (e.g. --upload-pack=<cmd>) or select a
// transport helper via `transport::address` (e.g. ext::sh -c '<cmd>'), which
// makes git itself run arbitrary commands. Accepted forms:
//   - https:// and ssh:// URLs (safe charset only)
//   - scp-like git@host:path
//   - a path to an EXISTING local directory (a real on-disk git remote — what
//     offline/local remotes and the integration tests use)
// Everything else (file://, git://, ext::, fd::, option-like strings, and
// anything carrying whitespace/shell junk) is rejected. Returns the URL on
// success; throws with a clear message otherwise.
const REMOTE_URL_TAIL = /^[A-Za-z0-9._~:@/-]+$/;
const REMOTE_URL_SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/;

function validateRemoteUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Remote URL is required.');
  }
  const reject = () => {
    throw new Error(
      `Unsupported or unsafe remote URL: "${url}". Use an https:// URL, an ` +
      'ssh:// URL, a git@host:path address, or a path to an existing local repository.'
    );
  };
  // Option injection: git would treat a leading '-' as a flag.
  if (url.startsWith('-')) reject();
  // Transport-helper syntax (ext::, fd::, ...) can run arbitrary commands.
  if (/^[A-Za-z0-9+.-]+::/.test(url)) reject();

  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if ((proto === 'https' || proto === 'ssh') && REMOTE_URL_TAIL.test(url.slice(scheme[0].length))) {
      return url;
    }
    reject();
  }

  // scp-like syntax: user@host:path
  if (REMOTE_URL_SCP.test(url)) return url;

  // Otherwise: accept only an existing local directory (a real local remote).
  try {
    if (fs.existsSync(url) && fs.statSync(url).isDirectory()) return url;
  } catch {}
  reject();
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

// Effective sync-dir set for export: default dirs + config.allowSyncDirs,
// minus config.skipSyncDirs and the system blacklist. Used by every code
// path that previously hard-coded USER_CONFIG_DIRS.
function getSyncDirsForExport() {
  const config = loadConfig() || {};
  const allow = new Set([...DEFAULT_USER_CONFIG_DIRS, ...(config.allowSyncDirs || [])]);
  const skip = new Set(config.skipSyncDirs || []);
  return [...allow].filter(d => !skip.has(d) && !SYSTEM_EXCLUDE_DIRS.has(d));
}

// Effective sync-dir set for import: every directory present in the repo's
// user-config/ tree that is not skipped or system-excluded. We iterate the
// repo (rather than the local config) so dirs added on another machine flow
// in automatically without requiring local config edits.
function getSyncDirsForImport() {
  const repoUserConfig = path.join(REPO_DIR, 'user-config');
  if (!fs.existsSync(repoUserConfig)) return [];
  const config = loadConfig() || {};
  const skip = new Set(config.skipSyncDirs || []);
  return fs.readdirSync(repoUserConfig, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(d => !skip.has(d) && !SYSTEM_EXCLUDE_DIRS.has(d));
}

// Local subdirs of ~/.claude that look like sync candidates (not system
// state, not yet decided). Used by /sync-init and /sync-push skills to
// prompt the user about new directories they may want to sync.
function detectUnknownDirs() {
  if (!fs.existsSync(CLAUDE_HOME)) return [];
  const config = loadConfig() || {};
  const known = new Set([
    ...DEFAULT_USER_CONFIG_DIRS,
    ...(config.allowSyncDirs || []),
    ...(config.skipSyncDirs || []),
  ]);
  return fs.readdirSync(CLAUDE_HOME, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(d => !known.has(d) && !SYSTEM_EXCLUDE_DIRS.has(d));
}

function addAllowSyncDir(dirName) {
  const config = loadConfig() || {};
  config.allowSyncDirs = [...new Set([...(config.allowSyncDirs || []), dirName])];
  config.skipSyncDirs = (config.skipSyncDirs || []).filter(d => d !== dirName);
  saveConfig(config);
  return config;
}

function addSkipSyncDir(dirName) {
  const config = loadConfig() || {};
  config.skipSyncDirs = [...new Set([...(config.skipSyncDirs || []), dirName])];
  config.allowSyncDirs = (config.allowSyncDirs || []).filter(d => d !== dirName);
  saveConfig(config);
  return config;
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
  const outPath = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    // A-06: local settings.json was deleted entirely -- remove the repo
    // copy too, otherwise it lingers forever and pull() copies it back.
    fs.rmSync(outPath, { force: true });
    return;
  }
  const full = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const filtered = {};
  for (const key of Object.keys(full)) {
    if (!SETTINGS_BLACKLIST.includes(key)) filtered[key] = full[key];
  }
  const outDir = path.join(REPO_DIR, 'global');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2));
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

// A-02: mirror `src` into `dest` like removeStalePaths()+copyDirSync()
// combined, but only touch entries that actually changed -- additions,
// content overwrites, and deletions of dest entries with no counterpart in
// src. Unchanged files are left on disk untouched (not just unreported).
// Returns the relative paths (forward-slash joined, relative to src/dest)
// that were actually added, overwritten, or deleted, so callers can build
// an accurate change list instead of unconditionally reporting every entry.
//
// Content comparison uses Buffer equality (not utf8 strings), per C-09, so
// binary files compare correctly. `exclude` mirrors removeStalePaths: a set
// of top-level entry names to leave alone entirely (never copied, deleted,
// or reported); like removeStalePaths, it is intentionally NOT propagated
// into recursive calls -- only the direct children of the top-level src/
// dest pair are eligible for exclusion.
function syncDirReportChanges(src, dest, exclude, prefix) {
  prefix = prefix || '';
  const changes = [];

  // Deletions: dest entries with no counterpart in src.
  if (fs.existsSync(dest)) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (exclude && exclude.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!fs.existsSync(srcPath)) {
        if (entry.isDirectory()) {
          for (const f of listFilesRecursive(destPath, rel)) changes.push(f);
        } else {
          changes.push(rel);
        }
        fs.rmSync(destPath, { recursive: true, force: true });
      }
    }
  }

  // Additions/overwrites: copy src entries whose content actually differs.
  if (!fs.existsSync(src)) return changes;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude && exclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const destIsDir = fs.existsSync(destPath) && fs.statSync(destPath).isDirectory();
    if (entry.isDirectory()) {
      if (fs.existsSync(destPath) && !destIsDir) fs.rmSync(destPath, { force: true });
      for (const f of syncDirReportChanges(srcPath, destPath, undefined, rel)) changes.push(f);
    } else {
      if (destIsDir) fs.rmSync(destPath, { recursive: true, force: true });
      const srcBuf = fs.readFileSync(srcPath);
      const unchanged = !destIsDir && fs.existsSync(destPath) && srcBuf.equals(fs.readFileSync(destPath));
      if (!unchanged) {
        fs.copyFileSync(srcPath, destPath);
        changes.push(rel);
      }
    }
  }
  return changes;
}

function exportUserConfig() {
  const configDir = path.join(REPO_DIR, 'user-config');
  const dirs = getSyncDirsForExport();
  // Sweep stale dirs: anything in the repo that is no longer in the active
  // sync set (e.g. user just moved a dir to skipSyncDirs) should be removed.
  if (fs.existsSync(configDir)) {
    const active = new Set(dirs);
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !active.has(entry.name)) {
        fs.rmSync(path.join(configDir, entry.name), { recursive: true, force: true });
      }
    }
  }
  for (const dir of dirs) {
    // A-01: mirror local deletions into the repo side before copying, or
    // files/subdirs removed locally never get removed from the repo and
    // "resurrect" on the next pull. A dir that is allow-listed but missing
    // locally entirely is treated as an empty directory, which clears out
    // any repo-side contents left over from before it was deleted.
    removeStalePaths(path.join(CLAUDE_HOME, dir), path.join(configDir, dir));
    copyDirSync(path.join(CLAUDE_HOME, dir), path.join(configDir, dir));
  }
  const claudeMdSrc = path.join(CLAUDE_HOME, 'CLAUDE.md');
  const claudeMdDest = path.join(configDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
  } else {
    // A-06: local CLAUDE.md was deleted -- remove the repo copy too.
    fs.rmSync(claudeMdDest, { force: true });
  }
}

function exportAll() {
  exportSettings();
  exportPluginConfigs();
  exportPluginData();
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
  // Back up every active sync dir, so a /sync-restore can put the user back
  // exactly where they were even if their allow/skip lists change later.
  for (const dir of getSyncDirsForExport()) {
    const src = path.join(CLAUDE_HOME, dir);
    if (fs.existsSync(src)) copyDirSync(src, path.join(backupPath, dir));
  }
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
  // Restore every dir actually present in this backup, not just the current
  // active set — a backup may predate an allow/skip-list edit, and the user
  // explicitly wants the backup state back.
  const backupDirs = fs.readdirSync(backupPath, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'plugin-data')
    .map(e => e.name);
  for (const dir of backupDirs) {
    const src = path.join(backupPath, dir);
    if (fs.existsSync(src)) {
      const dest = path.join(CLAUDE_HOME, dir);
      fs.rmSync(dest, { recursive: true, force: true });
      copyDirSync(src, dest);
    }
  }
  // Restore plugin data
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
}

// Read a JSON blob from a git ref (or current working tree). Returns null
// when the path doesn't exist at that ref. Used to fetch the "base" side
// of a 3-way merge.
function readJsonAtRef(ref, repoRelPath) {
  if (ref === null) return null;
  if (ref === 'WORKING') {
    const p = path.join(REPO_DIR, repoRelPath);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }
  const raw = safeGitShow(ref, repoRelPath);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Import settings.json with optional 3-way merge.
//   options.baseCommit  : commit hash to use as the merge base (last-sync
//                         point). Falsy → no base, behave like a plain
//                         "remote wins" overlay (preserves local-only keys).
//   options.forceRemote : skip merge entirely, take all remote keys, keep
//                         local-only keys. Used on first-pull-after-init
//                         when local ~/.claude is not yet a faithful copy
//                         of any base — "missing on local" should mean
//                         "haven't pulled yet", not "user removed it".
function importSettings(options = {}) {
  const { baseCommit = null, forceRemote = false } = options;
  const repoSettings = path.join(REPO_DIR, 'global', 'settings.json');
  if (!fs.existsSync(repoSettings)) return { changed: false, conflicts: [] };
  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  const localFull = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const local = { ...localFull };
  for (const key of SETTINGS_BLACKLIST) delete local[key];
  const remote = JSON.parse(fs.readFileSync(repoSettings, 'utf8'));

  let merged, conflicts = [];
  if (forceRemote || !baseCommit) {
    // Plain overlay: take all remote keys, keep any local-only keys.
    merged = { ...local, ...remote };
  } else {
    const base = readJsonAtRef(baseCommit, 'global/settings.json') || {};
    const m = mergeJsonFields(base, local, remote, 'remote');
    merged = m.result;
    conflicts = m.conflicts;
  }

  // Reattach blacklisted keys (statusLine etc.) so they remain machine-local.
  for (const key of SETTINGS_BLACKLIST) {
    if (key in localFull) merged[key] = localFull[key];
  }

  // Build changes summary against the previous local state.
  const changes = {};
  const allKeys = new Set([...Object.keys(localFull), ...Object.keys(merged)]);
  for (const key of allKeys) {
    if (SETTINGS_BLACKLIST.includes(key)) continue;
    if (JSON.stringify(localFull[key]) !== JSON.stringify(merged[key])) {
      changes[key] = { from: localFull[key], to: merged[key] };
    }
  }
  if (Object.keys(changes).length === 0) {
    return { changed: false, conflicts };
  }
  fs.writeFileSync(localPath, JSON.stringify(merged, null, 2));
  return { changed: true, changes, conflicts };
}

function importPluginConfigs(options = {}) {
  const { baseCommit = null, forceRemote = false } = options;
  const changes = [];
  const conflicts = [];
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const repoFile = path.join(REPO_DIR, 'global', file);
    if (!fs.existsSync(repoFile)) continue;
    const remoteRaw = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
    const remote = transformPathsForImport(remoteRaw);
    const destPath = path.join(CLAUDE_HOME, 'plugins', file);
    const localFull = fs.existsSync(destPath)
      ? JSON.parse(fs.readFileSync(destPath, 'utf8'))
      : {};

    let merged;
    if (forceRemote || !baseCommit) {
      merged = remote;
    } else {
      const baseRaw = readJsonAtRef(baseCommit, `global/${file}`);
      const base = baseRaw ? transformPathsForImport(baseRaw) : {};
      const m = mergeJsonFields(base, localFull, remote, 'remote');
      merged = m.result;
      for (const c of m.conflicts) conflicts.push({ file, ...c });
    }

    const newContent = JSON.stringify(merged, null, 2);
    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : '';
    if (existing !== newContent) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, newContent);
      changes.push(file);
    }
  }
  return { changes, conflicts };
}

function importPluginData() {
  const srcDir = path.join(REPO_DIR, 'global', 'plugin-data');
  if (!fs.existsSync(srcDir)) return [];
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  return syncDirReportChanges(srcDir, pluginsDir, PLUGIN_DATA_EXCLUDE);
}

function importUserConfig() {
  const changes = [];
  for (const dir of getSyncDirsForImport()) {
    const src = path.join(REPO_DIR, 'user-config', dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(CLAUDE_HOME, dir);
    // Mirror sync: remove stale files in destination that don't exist in
    // source, and only copy entries whose content actually differs (A-02).
    for (const rel of syncDirReportChanges(src, dest)) {
      changes.push(`${dir}/${rel}`);
    }
  }
  const claudeMdSrc = path.join(REPO_DIR, 'user-config', 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    const claudeMdDest = path.join(CLAUDE_HOME, 'CLAUDE.md');
    const srcBuf = fs.readFileSync(claudeMdSrc);
    const unchanged = fs.existsSync(claudeMdDest) && srcBuf.equals(fs.readFileSync(claudeMdDest));
    if (!unchanged) {
      fs.copyFileSync(claudeMdSrc, claudeMdDest);
      changes.push('CLAUDE.md');
    }
  }
  return changes;
}

function importAll(options = {}) {
  const settingsResult = importSettings(options);
  const pluginConfigsResult = importPluginConfigs(options);
  const pluginDataChanges = importPluginData();
  const configChanges = importUserConfig();
  // Preserve the legacy `pluginChanges` field (array of files), and surface
  // any conflicts collected during the JSON merges.
  const pluginChanges = pluginConfigsResult.changes;
  const mergeConflicts = [
    ...(settingsResult.conflicts || []),
    ...pluginConfigsResult.conflicts.map(c => ({ ...c, source: c.file })),
  ];
  return { settingsResult, pluginChanges, pluginDataChanges, configChanges, mergeConflicts };
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
  'global/plugin-data/blocklist.json',
];

function safeMergeBase() {
  try {
    return gitExecFile(['merge-base', 'HEAD', 'origin/main']);
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
    gitExecFile(['merge', 'origin/main', '--no-edit']);
  } catch {
    gitExecFile(['merge', '--abort']);
    gitExecFile(['merge', 'origin/main', '--no-edit', '-X', fallbackStrategy]);
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
    gitExecFile(['add', '-A']);
    gitExecFile(['commit', '--amend', '--no-edit']);
  }

  return { mergeConflicts: allConflicts, mergeWarnings };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
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
      } else if (isPlainObject(local[key]) && isPlainObject(remote[key])) {
        // Both sides changed an object value — recurse to merge sub-keys
        const sub = mergeJsonFields(
          inBase && isPlainObject(base[key]) ? base[key] : {},
          local[key],
          remote[key],
          preference,
        );
        result[key] = sub.result;
        for (const c of sub.conflicts) {
          conflicts.push({ ...c, key: `${key}.${c.key}` });
        }
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

function diffUserConfig() {
  const diffs = [];
  // Diff covers the union of dirs that exist on either side, so the user
  // sees newly-added remote dirs they may want to allow as well as local
  // dirs that haven't been pushed yet.
  const dirs = new Set([
    ...getSyncDirsForExport(),
    ...getSyncDirsForImport(),
  ]);
  for (const dir of dirs) {
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

function diffPluginData() {
  const repoDir = path.join(REPO_DIR, 'global', 'plugin-data');
  const localDir = path.join(CLAUDE_HOME, 'plugins');
  const repoPaths = listFilesRecursive(repoDir);
  const localPaths = new Set();
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
  try { gitExecFile(['checkout', '--', '.']); } catch {}
  try { gitExecFile(['clean', '-fd']); } catch {}
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
    gitExecFile(['config', 'user.name']);
  } catch {
    // No local identity — try to inherit from global, or use defaults
    let name = 'claude-sync';
    let email = 'claude-sync@localhost';
    try { name = execFileSync('git', ['config', '--global', 'user.name'], { stdio: 'pipe' }).toString().trim(); } catch {}
    try { email = execFileSync('git', ['config', '--global', 'user.email'], { stdio: 'pipe' }).toString().trim(); } catch {}
    gitExecFile(['config', 'user.name', name]);
    gitExecFile(['config', 'user.email', email]);
  }
}

function init(remoteUrl) {
  if (isInitialized()) throw new Error('Already initialized. Run /sync-uninstall first.');
  validateRemoteUrl(remoteUrl);
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  // '--' stops git from treating remoteUrl as an option; execFileSync means no
  // shell ever sees it (B-01).
  execFileSync('git', ['clone', '--', remoteUrl, REPO_DIR], { timeout: 60000, stdio: 'pipe' });
  ensureGitIdentity();
  const hasContent = fs.existsSync(path.join(REPO_DIR, 'global'));
  if (!hasContent) {
    // Empty repo — push our local state as the initial sync.
    exportAll();
    gitExecFile(['add', '-A']);
    gitExecFile(['commit', '-m', 'Initial sync from first machine']);
    gitExecFile(['push', 'origin', 'main']);
  }
  saveConfig({ repo: remoteUrl, autoPull: false, autoPush: false });
  // Track the commit we synced against so future pulls can do real 3-way
  // merges. firstPullPending=true tells pull() that ~/.claude is not yet
  // a faithful copy of base — the next pull should overlay remote rather
  // than try to merge.
  const commitHash = gitExecFile(['rev-parse', 'HEAD']);
  saveLastSync({ action: 'init', commitHash, firstPullPending: hasContent });
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
    gitExecFile(['add', '-A']);
    const hostname = require('os').hostname();
    gitExecFile(['commit', '-m', `sync from ${hostname} at ${new Date().toISOString()}`]);
    let mergeResult = {};
    try {
      gitExecFile(['push', 'origin', 'main']);
    } catch {
      gitExecFile(['fetch', 'origin', 'main']);
      mergeResult = performSmartMerge('local', 'ours');
      gitExecFile(['push', 'origin', 'main']);
    }
    // After a successful push, ~/.claude is the source of truth for the
    // new commit; clear firstPullPending if it was lingering from init.
    saveLastSync({ action: 'push', commitHash: gitExecFile(['rev-parse', 'HEAD']), firstPullPending: false });
    return { pushed: true, ...mergeResult };
  } finally {
    releaseLock();
  }
}

// Detect whether ~/.claude has diverged from the named base commit. Used
// by pull() to refuse silent overwrites of unpushed local edits. The check
// is deliberately scoped to settings.json + plugin configs + user-config
// dirs that the sync layer manages — large/binary plugin-data is excluded
// to avoid false positives from machine-local plugin caches.
function getLocalDelta(baseCommit) {
  const delta = {
    settingsKeys: [],   // settings.json keys whose local value differs from base
    pluginConfigs: [],  // installed_plugins.json / known_marketplaces.json files differing
    userConfigFiles: [],// user-config files (rules/, skills/, ...) differing
  };
  if (!baseCommit) return delta;

  // settings.json
  const baseSettings = readJsonAtRef(baseCommit, 'global/settings.json') || {};
  const localSettingsPath = path.join(CLAUDE_HOME, 'settings.json');
  const localSettings = fs.existsSync(localSettingsPath)
    ? JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'))
    : {};
  const allKeys = new Set([...Object.keys(baseSettings), ...Object.keys(localSettings)]);
  for (const key of allKeys) {
    if (SETTINGS_BLACKLIST.includes(key)) continue;
    if (JSON.stringify(baseSettings[key]) !== JSON.stringify(localSettings[key])) {
      delta.settingsKeys.push(key);
    }
  }

  // Plugin configs
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const baseRaw = readJsonAtRef(baseCommit, `global/${file}`);
    const base = baseRaw ? transformPathsForImport(baseRaw) : {};
    const localPath = path.join(CLAUDE_HOME, 'plugins', file);
    const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
    if (JSON.stringify(base) !== JSON.stringify(local)) {
      delta.pluginConfigs.push(file);
    }
  }

  // User-config files
  for (const dir of getSyncDirsForExport()) {
    const localDir = path.join(CLAUDE_HOME, dir);
    if (!fs.existsSync(localDir)) continue;
    for (const file of listFilesRecursive(localDir)) {
      const repoRel = `user-config/${dir}/${file}`;
      const baseContent = safeGitShow(baseCommit, repoRel);
      const localContent = fs.readFileSync(path.join(localDir, file), 'utf8');
      if (baseContent !== localContent) {
        delta.userConfigFiles.push({ dir, file });
      }
    }
  }

  return delta;
}

function isLocalDeltaEmpty(delta) {
  return delta.settingsKeys.length === 0
    && delta.pluginConfigs.length === 0
    && delta.userConfigFiles.length === 0;
}

// Show what a /sync-pull would do without actually performing it. Skill
// uses this to give the user a clear summary and ask for confirmation
// when local has unpushed changes that risk being clobbered.
function previewPull() {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!gitFetch(10000)) {
    return { ok: false, reason: 'fetch-failed' };
  }
  const lastSync = loadLastSync();
  const remoteHead = gitExecFile(['rev-parse', 'origin/main']);
  const base = lastSync.commitHash || null;
  const firstPull = lastSync.firstPullPending === true;
  const remoteHasUpdates = base ? base !== remoteHead : true;
  const localDelta = firstPull ? null : getLocalDelta(base);
  const localDirty = localDelta ? !isLocalDeltaEmpty(localDelta) : false;

  let recommendation;
  if (firstPull) {
    recommendation = 'first-pull';
  } else if (!remoteHasUpdates && !localDirty) {
    recommendation = 'up-to-date';
  } else if (!localDirty) {
    recommendation = 'safe-pull';
  } else if (!remoteHasUpdates) {
    recommendation = 'push-first';
  } else {
    recommendation = 'merge-with-conflicts';
  }

  return {
    ok: true,
    recommendation,
    base,
    remoteHead,
    remoteHasUpdates,
    firstPull,
    localDelta,
  };
}

// Perform a pull. By default (`mode: 'safe'`), refuses to proceed if local
// has diverged from the last-synced base — the user must explicitly pass
// `mode: 'merge'` (3-way merge with remote winning conflicts) or push first.
// On a fresh machine where firstPullPending=true the safe mode is "first
// pull" — overlay remote without trying to interpret missing local fields
// as deletions.
function pull(options = {}) {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw new Error('Another sync operation is in progress.');
  const mode = options.mode || 'safe';
  try {
    const backupPath = createBackup();
    if (!gitFetch(30000)) throw new Error('Failed to fetch from remote. Check your network.');

    // Always start from a clean view of origin/main. This wipes any working
    // tree pollution left over by older versions of pull().
    try { gitExecFile(['reset', '--hard', 'origin/main']); } catch {}

    const lastSync = loadLastSync();
    const remoteHead = gitExecFile(['rev-parse', 'origin/main']);
    const base = lastSync.commitHash || null;
    const firstPull = lastSync.firstPullPending === true;

    let importOptions;
    let modeUsed;
    if (firstPull) {
      // Brand-new machine: ~/.claude isn't yet a faithful copy of base, so
      // "fields missing locally" must NOT be interpreted as deletions.
      importOptions = { baseCommit: null, forceRemote: true };
      modeUsed = 'first-pull';
    } else {
      const localDelta = getLocalDelta(base);
      const localDirty = !isLocalDeltaEmpty(localDelta);
      if (localDirty && mode === 'safe') {
        // Refuse to clobber unpushed work; caller (skill) should re-invoke
        // with mode='merge' after surfacing the diff to the user.
        return {
          pulled: false,
          reason: 'local-changes-pending',
          backupPath,
          localDelta,
          base,
          remoteHead,
          hint: 'Run /sync-push first, or call pull({ mode: "merge" }) to merge with remote winning on conflicts.',
        };
      }
      importOptions = { baseCommit: base, forceRemote: false };
      modeUsed = localDirty ? 'merge' : 'fast-forward';
    }

    const result = importAll(importOptions);
    const missingPlugins = detectMissingPlugins();
    saveLastSync({ action: 'pull', commitHash: remoteHead, firstPullPending: false });

    const nothingChanged = !result.settingsResult?.changed
      && (result.pluginChanges || []).length === 0
      && (result.pluginDataChanges || []).length === 0
      && (result.configChanges || []).length === 0;
    if (nothingChanged) {
      return { pulled: false, reason: 'up-to-date', backupPath, ...result, missingPlugins, mode: modeUsed };
    }
    return { pulled: true, backupPath, ...result, missingPlugins, mode: modeUsed };
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
  gitExec, gitExecFile, validateRemoteUrl,
  gitFetch, hasRemoteUpdates, getRemoteUpdateCount, hasLocalChanges,
  // Config
  loadConfig, saveConfig, loadLastSync, saveLastSync, isInitialized,
  // Sync-dir resolution
  getSyncDirsForExport, getSyncDirsForImport, detectUnknownDirs,
  addAllowSyncDir, addSkipSyncDir,
  // Lock
  acquireLock, releaseLock,
  // Export
  exportSettings, exportPluginConfigs, exportPluginData, exportUserConfig, exportAll,
  transformPathsForExport, transformPathsForImport, copyDirSync, removeStalePaths,
  syncDirReportChanges,
  // Import + Backup
  createBackup, listBackups, restoreBackup,
  importSettings, importPluginConfigs, importPluginData, importUserConfig, importAll,
  detectMissingPlugins, detectMissingMarketplaces,
  // Smart Merge
  safeGitShow, mergeJsonFields, readJsonAtRef,
  // Diff + Status
  diffSettings, diffPluginConfigs, diffUserConfig, diffPluginData, listFilesRecursive, getStatus,
  getLocalDelta, isLocalDeltaEmpty, previewPull,
  // Orchestrators
  init, push, pull, uninstall,
};
