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
const LAST_SYNC_PATH = path.join(SYNC_DIR, 'last-sync.json');
// B-02: records a pull() that deferred one or more CONFIRM_REQUIRED_DIRS. Holds
// the last-sync payload to commit once the user confirms, so a crashed or
// abandoned session can be recovered (applied or discarded) later instead of
// silently advancing the sync base.
const PENDING_APPLY_PATH = path.join(SYNC_DIR, 'pending-apply.json');
const BACKUP_DIR = path.join(CLAUDE_HOME, 'sync-backups');
// D-02: how many timestamped backups createBackup() keeps. Raised from 5 to 10
// so a run of no-op/refused pulls is less likely to rotate a useful
// pre-disaster backup out of the window.
const BACKUP_RETENTION = 10;
const LOCK_PATH = path.join(SYNC_DIR, '.sync.lock');
const SETTINGS_BLACKLIST = ['statusLine'];

// Built-in user-config dirs that have always been synced. They remain the
// default even if a config file lacks an explicit allow list, so existing
// installs keep their behaviour after upgrading.
const DEFAULT_USER_CONFIG_DIRS = ['commands', 'rules', 'agents', 'skills', 'hooks'];

// B-02: user-config dirs that can carry executable code (JS hooks, shell
// scripts, skill/rule instructions the agent will follow). pull() NEVER
// writes these to ~/.claude directly — a change here is deferred and returned
// under `pendingConfirmation`, then applied only by an explicit
// applyPendingDirs() call after the user confirms the diff. A compromised
// remote must not be able to drop a hook that auto-runs on the next session.
const CONFIRM_REQUIRED_DIRS = ['hooks', 'skills', 'rules'];

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

// Fix 1 (B-02/B-03 security review): every reserved dir name, case-folded.
// macOS/Windows filesystems are case-insensitive, so 'Hooks' ALIASES
// ~/.claude/hooks on disk while comparing unequal to the reserved name
// 'hooks' — before this fix a spoofed repo dir could ride the normal
// (unconfirmed) import path straight into an executable dir. All reserved
// entries above are lowercase, so a folded comparison is simply
// SET.has(name.toLowerCase()); this constant unions them for the
// spoof-detection helper below.
const RESERVED_DIR_NAMES_LOWER = new Set(
  [...CONFIRM_REQUIRED_DIRS, ...DEFAULT_USER_CONFIG_DIRS, ...SYSTEM_EXCLUDE_DIRS]
    .map(n => n.toLowerCase()),
);

// F#2 (Codex, RCE): a dir name is only ever safe to allow-list, export, or
// hand to a downstream `node -e ... '<dir>'` argv slot if it matches this
// charset. Anything else (quotes, semicolons, `//`, spaces, slashes, shell
// metacharacters, ...) must never reach that far — see isSuspiciousDirName
// below (which folds this into "suspicious" so such names are surfaced, not
// silently offered) and the addAllowSyncDir/addSkipSyncDir backstop.
function hasUnsafeDirNameChars(name) {
  return !/^[A-Za-z0-9._-]+$/.test(name);
}

// A dir name that case-fold-collides with a reserved name WITHOUT being an
// exact reserved name (e.g. 'Hooks', 'Plugins', 'SKILLS'). Such a name can
// only exist to spoof a reserved dir on a case-insensitive filesystem — it is
// never importable, never allow-listable, and pull() surfaces repo dirs like
// this under `suspiciousRemoteDirs` so the user can be warned. (Name-based
// only, so behaviour is identical on case-sensitive filesystems.)
//
// F#2: also treats any unsafe-charset name (see hasUnsafeDirNameChars) as
// suspicious. This single change ripples through every caller that already
// excludes isSuspiciousDirName() results: getUnknownRemoteDirs() stops
// offering such a name for add/skip, getSyncDirsForExport()'s allowExtra
// filter stops exporting one that slipped into config, and
// getSuspiciousRemoteDirs() surfaces it as a likely spoofing/injection
// attempt instead of silently dropping it.
function isSuspiciousDirName(name) {
  if (hasUnsafeDirNameChars(name)) return true;   // F#2: injection/spoofing charset
  return RESERVED_DIR_NAMES_LOWER.has(name.toLowerCase())
    && !DEFAULT_USER_CONFIG_DIRS.includes(name)
    && !SYSTEM_EXCLUDE_DIRS.has(name);
}

const PLUGIN_DATA_EXCLUDE = new Set([
  'cache', 'marketplaces',
  'installed_plugins.json', 'known_marketplaces.json',
  'install-counts-cache.json', '.DS_Store',
]);

// D-01: OS-generated junk files that must never be synced. Without this,
// e.g. macOS's `.DS_Store` gets exported into the repo and committed the
// moment someone opens the synced dir in Finder, producing a perpetual
// false "local changes" / session-end nag, and disagreeing with the diff
// functions (which already skipped `.DS_Store`) about what actually changed.
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.localized']);

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
    gitExecFile(['fetch', 'origin', getBranch()], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// A-05: judge "does the remote have updates" from the actual commit count
// (rev-list HEAD..origin/<branch>), not a hash mismatch -- HEAD != origin/<branch>
// is also true when local is merely ahead (unpushed commits) with nothing
// new on the remote side, which must read as "no remote updates".
function getRemoteUpdateCount() {
  return parseInt(gitExecFile(['rev-list', `HEAD..origin/${getBranch()}`, '--count']), 10);
}

function hasRemoteUpdates() {
  return getRemoteUpdateCount() > 0;
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

// C-09: like safeGitShow but returns the raw Buffer (no toString), so binary
// files compare correctly. execFileSync already returns a Buffer.
function safeGitShowBuffer(ref, filePath) {
  try {
    return execFileSync('git', ['-C', REPO_DIR, 'show', `${ref}:${filePath}`], {
      timeout: 30000, stdio: 'pipe',
    });
  } catch {
    return null;
  }
}

// C-01: remote-side counterpart to listFilesRecursive() (below) -- lists
// file paths under `prefix` at a git ref instead of walking a working-tree
// directory, so diff functions can see content that has been fetched
// (`git fetch`) but not yet checked out into REPO_DIR's working tree.
// `git ls-tree` only ever lists committed content, so unlike
// listFilesRecursive there is no need to filter out things like .DS_Store.
// C-01 (final review): `-c core.quotePath=false` is required so a non-ASCII
// filename comes back as raw UTF-8 instead of octal-escaped+quoted (e.g.
// `"caf\303\251.txt"`) -- the quoted form would never match
// listFilesRecursive's raw readdirSync name, and importPluginData()'s
// deleteSet comparison could then wrongly delete a non-ASCII plugin-data
// file present on both sides. Does not change the `\n`-per-line format.
// Returns an empty Set (never throws) for a ref that doesn't exist yet
// (not fetched) or a prefix with no matching tree entries, matching
// listFilesRecursive's behaviour for a non-existent directory.
function listFilesAtRef(ref, prefix) {
  const files = new Set();
  let output;
  try {
    output = gitExecFile(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', ref, '--', prefix]);
  } catch {
    return files;
  }
  if (!output) return files;
  const trimmedPrefix = prefix.replace(/\/+$/, '');
  const stripLen = trimmedPrefix ? trimmedPrefix.length + 1 : 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    files.add(stripLen > 0 ? line.slice(stripLen) : line);
  }
  return files;
}

// C-01 (review fix): list the top-level DIRECTORIES under `prefix` at a git
// ref -- the ref-side counterpart to getSyncDirsForImport()'s
// readdirSync(REPO_DIR/user-config) working-tree scan, so diffUserConfig()
// can discover a brand-new remote dir that has been fetched but not pulled.
// Non-recursive `ls-tree` (without --name-only) prints one entry per line as
// `<mode> <type> <sha>\t<path>`; only `tree` entries (subdirectories) are
// kept, so blobs like user-config/CLAUDE.md are ignored. Applies the same
// SYSTEM_EXCLUDE_DIRS filter that getSyncDirsForImport() applies. Returns
// an empty Set (never throws) when the ref or prefix doesn't exist,
// matching listFilesAtRef above.
function listDirsAtRef(ref, prefix) {
  const dirs = new Set();
  const trimmedPrefix = prefix.replace(/\/+$/, '');
  let output;
  try {
    // Trailing '/' makes non-recursive ls-tree list the CONTENTS of the
    // prefix tree instead of the prefix entry itself. `-c core.quotePath=false`
    // (see listFilesAtRef above, C-01 final review): keeps non-ASCII dir
    // names raw instead of octal-escaped+quoted.
    output = gitExecFile(['-c', 'core.quotePath=false', 'ls-tree', ref, '--', `${trimmedPrefix}/`]);
  } catch {
    return dirs;
  }
  if (!output) return dirs;
  const stripLen = trimmedPrefix ? trimmedPrefix.length + 1 : 0;
  for (const line of output.split('\n')) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const type = line.slice(0, tabIdx).split(' ')[1];
    if (type !== 'tree') continue;
    const name = line.slice(tabIdx + 1).slice(stripLen);
    // Fix 1: case-folded, so a spoofed 'Plugins'/'Sync' entry is excluded too.
    if (name && !SYSTEM_EXCLUDE_DIRS.has(name.toLowerCase())) dirs.add(name);
  }
  return dirs;
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

// C-04: single guarded reader for all JSON config/state files.
//   required:true  -> malformed JSON (or an unreadable-but-present file) throws
//                     a friendly, path-naming Error (never returns a fallback
//                     that could be merged/pushed as data loss).
//   required:false -> returns `fallback`; if a `warnings` array is passed, a
//                     human-readable line is appended to it.
// A genuinely MISSING file (ENOENT) always returns `fallback` regardless of
// `required` — absence is not corruption.
function readJsonFile(filePath, { required = false, fallback = null, warnings = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (required) throw new Error('Cannot read ' + path.basename(filePath) + ': ' + filePath + ' (' + err.code + ')');
    if (warnings) warnings.push('skipped unreadable file: ' + filePath);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (required) throw new Error('Malformed JSON in ' + path.basename(filePath) + ': ' + filePath + ' — fix it and retry.');
    if (warnings) warnings.push('ignored malformed JSON in: ' + filePath);
    return fallback;
  }
}

// C-04: config.json holds the repo URL + branch + allow/skip lists -- a `{}`
// fallback on corruption would make every command silently operate against a
// phantom empty config (wrong/absent remote), which is worse than stopping.
// Fail fast with a friendly, path-naming error instead (stricter than the
// original brief, which allowed config to fall back; pinned in
// task-C04-decisions.md).
function loadConfig() {
  return readJsonFile(CONFIG_PATH, { required: true, fallback: null });
}

function saveConfig(config) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// C-04: last-sync.json is AUXILIARY -- a corrupt/missing base falls back to
// {} instead of throwing. Callers see no commitHash/firstPullPending, so
// pull() takes the safe no-base overlay path (documented at the pull() call
// site) rather than crashing. Pass a `warnings` array (e.g. from pull()) to
// surface the corruption to the user instead of silently losing it.
function loadLastSync(warnings = null) {
  return readJsonFile(LAST_SYNC_PATH, { fallback: {}, warnings });
}

function saveLastSync(data) {
  fs.writeFileSync(LAST_SYNC_PATH, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
}

function isInitialized() {
  return fs.existsSync(CONFIG_PATH) && fs.existsSync(REPO_DIR);
}

// C-02: every engine call site that used to hardcode 'main'/'origin/main'
// now reads the branch name detected at init() time (see detectBranch()
// below) from config.branch. Configs written before this task never set
// that field, so the fallback here is 'main' -- unchanged behaviour for
// every pre-existing install.
function getBranch() {
  const config = loadConfig();
  return (config && config.branch) || 'main';
}

// Effective sync-dir set for export: default dirs + config.allowSyncDirs,
// minus config.skipSyncDirs and the system blacklist. Used by every code
// path that previously hard-coded USER_CONFIG_DIRS.
function getSyncDirsForExport() {
  const config = loadConfig() || {};
  // Fix 1: drop allow-list entries that case-fold-collide with a reserved
  // name (e.g. 'Hooks') — addAllowSyncDir() now rejects them, but a config
  // written before this fix may still carry one. The SYSTEM_EXCLUDE check is
  // case-folded too, so 'Plugins' can't alias plugins/ on macOS/Windows.
  const allowExtra = (config.allowSyncDirs || []).filter(d => !isSuspiciousDirName(d));
  const allow = new Set([...DEFAULT_USER_CONFIG_DIRS, ...allowExtra]);
  const skip = new Set(config.skipSyncDirs || []);
  return [...allow].filter(d => !skip.has(d) && !SYSTEM_EXCLUDE_DIRS.has(d.toLowerCase()));
}

// Effective sync-dir set for import: repo user-config/ dirs that are also in
// the local allow set (getSyncDirsForExport = DEFAULT ∪ allowSyncDirs − skip −
// system). B-03: import is now symmetric with export — a dir present in the
// repo but NOT locally allow-listed is NOT imported (see getUnknownRemoteDirs).
// This closes the asymmetry where any repo dir landed straight in ~/.claude;
// a machine now opts into a new remote dir via addAllowSyncDir() first.
function getSyncDirsForImport() {
  const repoUserConfig = path.join(REPO_DIR, 'user-config');
  if (!fs.existsSync(repoUserConfig)) return [];
  // Exact-name intersection with the allow set. getSyncDirsForExport already
  // excludes system dirs and case-fold-spoofed names, so no re-filter needed;
  // a spoofed repo dir like 'Hooks' can never match an allow entry.
  const allow = new Set(getSyncDirsForExport());
  return fs.readdirSync(repoUserConfig, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(d => allow.has(d));
}

// B-03: repo user-config/ dirs that are NOT in the local allow set and NOT
// explicitly skipped — i.e. dirs some other machine added that this machine
// has not decided about yet. pull() returns these under `unknownRemoteDirs`
// so the skill can prompt the user to add (addAllowSyncDir) or skip
// (addSkipSyncDir) each one. Skipped dirs are silently ignored (the user
// already declined), matching export/diff behaviour. Fix 1: names that
// case-fold-collide with a reserved dir are NOT opt-in candidates — they go
// to getSuspiciousRemoteDirs() instead, and the system-exclude check is
// case-folded.
function getUnknownRemoteDirs() {
  const repoUserConfig = path.join(REPO_DIR, 'user-config');
  if (!fs.existsSync(repoUserConfig)) return [];
  const allow = new Set(getSyncDirsForExport());
  const skip = new Set((loadConfig() || {}).skipSyncDirs || []);
  return fs.readdirSync(repoUserConfig, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(d => !allow.has(d) && !skip.has(d)
      && !SYSTEM_EXCLUDE_DIRS.has(d.toLowerCase()) && !isSuspiciousDirName(d));
}

// Fix 1: repo user-config/ dirs whose name case-fold-collides with a reserved
// dir (e.g. 'Hooks' aliasing hooks/ on macOS/Windows). These are NEVER
// importable and cannot be allow-listed; pull() surfaces them under
// `suspiciousRemoteDirs` so the skill can warn the user of a likely spoofing
// attempt in the sync repo.
function getSuspiciousRemoteDirs() {
  const repoUserConfig = path.join(REPO_DIR, 'user-config');
  if (!fs.existsSync(repoUserConfig)) return [];
  return fs.readdirSync(repoUserConfig, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(d => isSuspiciousDirName(d));
}

// Local subdirs of ~/.claude that look like sync candidates (not system
// state, not yet decided). Used by /sync-init and /sync-push skills to
// prompt the user about new directories they may want to sync.
function detectUnknownDirs() {
  if (!fs.existsSync(CLAUDE_HOME)) return [];
  const config = loadConfig() || {};
  // Fix 1: case-folded comparisons, so e.g. a local 'Skills' dir (aliasing
  // skills/ on macOS/Windows) is not offered as a sync candidate.
  const knownLower = new Set([
    ...DEFAULT_USER_CONFIG_DIRS,
    ...(config.allowSyncDirs || []),
    ...(config.skipSyncDirs || []),
  ].map(n => n.toLowerCase()));
  return fs.readdirSync(CLAUDE_HOME, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    // F#2: local dirs are lower risk than remote ones, but exclude an
    // odd-charset name here too for completeness — /sync-init should never
    // offer one as a sync candidate in the first place.
    .filter(d => !knownLower.has(d.toLowerCase()) && !SYSTEM_EXCLUDE_DIRS.has(d.toLowerCase())
      && !hasUnsafeDirNameChars(d));
}

function addAllowSyncDir(dirName) {
  // F#2: backstop — reject unsafe-charset names before they ever reach
  // config.json. isSuspiciousDirName() already keeps these out of
  // getUnknownRemoteDirs()/detectUnknownDirs() so the skill flow never
  // offers one, but this guard closes the door for any other caller (or a
  // config hand-edited/corrupted before this fix).
  if (hasUnsafeDirNameChars(dirName)) {
    throw new Error(`"${dirName}" contains characters not allowed in a sync directory name (allowed: letters, digits, . _ -).`);
  }
  // Fix 1: refuse any name that case-fold-collides with a reserved dir name
  // unless it IS exactly a default sync dir (allow-listing 'hooks' itself is
  // a harmless no-op). Blocks 'Hooks', 'Plugins', 'plugins', 'SYNC', etc. —
  // on case-insensitive filesystems those alias reserved paths and would
  // bypass the exec-dir confirmation or clobber system state.
  if (RESERVED_DIR_NAMES_LOWER.has(dirName.toLowerCase())
      && !DEFAULT_USER_CONFIG_DIRS.includes(dirName)) {
    throw new Error(
      `"${dirName}" collides with the reserved directory name ` +
      `"${dirName.toLowerCase()}" and cannot be allow-listed. On ` +
      'case-insensitive filesystems it would alias a protected directory.'
    );
  }
  const config = loadConfig() || {};
  config.allowSyncDirs = [...new Set([...(config.allowSyncDirs || []), dirName])];
  config.skipSyncDirs = (config.skipSyncDirs || []).filter(d => d !== dirName);
  saveConfig(config);
  return config;
}

function addSkipSyncDir(dirName) {
  // F#2: backstop, see addAllowSyncDir above.
  if (hasUnsafeDirNameChars(dirName)) {
    throw new Error(`"${dirName}" contains characters not allowed in a sync directory name (allowed: letters, digits, . _ -).`);
  }
  const config = loadConfig() || {};
  config.skipSyncDirs = [...new Set([...(config.skipSyncDirs || []), dirName])];
  config.allowSyncDirs = (config.allowSyncDirs || []).filter(d => d !== dirName);
  saveConfig(config);
  return config;
}

// C-03: lock dir also holds meta.json ({ pid, startedAt }) so a holder that
// crashed (or was kill -9'd) without releasing the lock can be told apart
// from a genuinely concurrent sync and reclaimed automatically, instead of
// wedging every future push/pull until a human deletes it by hand.
const LOCK_META_PATH = path.join(LOCK_PATH, 'meta.json');
const STALE_MS = 10 * 60 * 1000; // a sync op should never legitimately run this long

function lockBusyError() {
  return new Error(
    'Another sync operation is in progress. If no sync is running, a previous '
    + 'run may have crashed; remove the stale lock manually: rm -rf "' + LOCK_PATH + '"'
  );
}

// Reads and parses meta.json inside the lock dir. Returns null on any
// failure (file missing, unreadable, invalid JSON) — callers must treat null
// as "can't prove anything" and fail safe.
function readLockMeta() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_META_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// True only when we can prove the lock's holder is gone: process.kill(pid, 0)
// throws ESRCH (no such process). EPERM (process exists, owned by someone
// else) means alive. A live holder is still considered stale once it has
// held the lock past STALE_MS, since no sync op should legitimately run that
// long. Missing/malformed meta is never stale — never delete a lock we can't
// prove is dead.
function isLockStale(meta) {
  if (!meta || typeof meta.pid !== 'number' || typeof meta.startedAt !== 'number') return false;
  try {
    process.kill(meta.pid, 0);
  } catch (err) {
    return err.code === 'ESRCH';
  }
  return Date.now() - meta.startedAt > STALE_MS;
}

function tryMkdirLock() {
  try {
    fs.mkdirSync(LOCK_PATH, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  if (!tryMkdirLock()) {
    // Someone already holds the lock dir. Only reclaim it if we can prove
    // the holder is dead; otherwise fail safe and report busy.
    if (!isLockStale(readLockMeta())) return false;
    // Reclaim atomically. renameSync is atomic, so if several processes each
    // judge the same stale lock reclaimable, only ONE wins the rename of
    // LOCK_PATH; the losers get ENOENT and back off as busy instead of blindly
    // deleting a dir a winner may have just re-created — this closes the
    // two-reclaimer double-acquire race. (Residual, negligible for a
    // single-user tool and impossible for the dead-pid case since a dead
    // holder cannot release: an age-stale but still-live holder releasing AND
    // a fresh holder mkdir-ing in the sub-ms window between the isLockStale
    // check and this rename could still be clobbered.)
    const stalePath = LOCK_PATH + '.stale-' + process.pid;
    try {
      fs.renameSync(LOCK_PATH, stalePath);
    } catch {
      return false; // lost the reclaim race
    }
    fs.rmSync(stalePath, { recursive: true, force: true });
    // Retry the create exactly once. mkdir is atomic, so if another process
    // wins the race for the now-freed lock, we give up rather than loop.
    if (!tryMkdirLock()) return false;
  }
  try {
    fs.writeFileSync(LOCK_META_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return true;
  } catch {
    // Meta write failed — don't leak a lock dir with no meta.
    fs.rmSync(LOCK_PATH, { recursive: true, force: true });
    return false;
  }
}

function releaseLock() {
  // The lock dir now holds meta.json, so it's never empty — rmdirSync would
  // throw ENOTEMPTY and leak the lock. Use a recursive, force-ignore-missing
  // removal instead.
  try { fs.rmSync(LOCK_PATH, { recursive: true, force: true }); } catch {}
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
  // C-04: SOURCE file being read to push -- must fail fast on corruption,
  // never fall back to {} (which would export/push "delete every setting").
  const full = readJsonFile(settingsPath, { required: true });
  const filtered = {};
  for (const key of Object.keys(full)) {
    if (!SETTINGS_BLACKLIST.includes(key)) filtered[key] = full[key];
  }
  // A-04: transform absolute CLAUDE_HOME paths (hook commands, etc.) to the
  // ${CLAUDE_HOME} placeholder so settings.json is portable across machines,
  // same convention already used for plugin configs (transformPathsForExport
  // below).
  const transformed = transformPathsForExport(filtered);
  const outDir = path.join(REPO_DIR, 'global');
  fs.mkdirSync(outDir, { recursive: true });
  unlinkIfSymlink(outPath); // F#9: never write THROUGH a planted symlink
  fs.writeFileSync(outPath, JSON.stringify(transformed, null, 2));
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
    // C-04: SOURCE file being read to push -- fail fast, never {}-push.
    const data = readJsonFile(src, { required: true });
    const transformed = transformPathsForExport(data);
    const destPath = path.join(outDir, file);
    unlinkIfSymlink(destPath); // F#9: never write THROUGH a planted symlink
    fs.writeFileSync(destPath, JSON.stringify(transformed, null, 2));
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
    if (entry.isSymbolicLink()) {
      // F#1: a top-level plugin-data symlink would otherwise fall to the
      // copyFileSync below and follow the link (exports the TARGET's
      // content into the repo). Skip it, same as copyDirSync.
      console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(pluginsDir, entry.name)}`);
      continue;
    }
    const srcPath = path.join(pluginsDir, entry.name);
    const destPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      unlinkIfSymlink(destPath); // F#9 review: neutralize a symlinked dest dir root before copying INTO it
      copyDirSync(srcPath, destPath);
    } else {
      unlinkIfSymlink(destPath); // F#9: never copy THROUGH a planted symlink
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeStalePaths(src, dest, exclude) {
  if (!fs.existsSync(dest)) return;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      // C-09: a symlink in dest has nothing meaningful to compare against
      // src (syncing symlinks is unsupported) -- leave it alone rather than
      // treating it as stale and deleting it. Warn with the source-side path
      // when a same-named entry exists there, else the dest entry itself.
      const srcPath = path.join(src, entry.name);
      const warnPath = fs.existsSync(srcPath) ? srcPath : path.join(dest, entry.name);
      console.warn(`[claude-sync] skipping symlink (not synced): ${warnPath}`);
      continue;
    }
    if (IGNORED_FILES.has(entry.name)) continue;
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
    if (entry.isSymbolicLink()) {
      // C-09: syncing a symlink is almost always wrong (it would copy the
      // link target's content, or throw on a dir/broken link and abort the
      // whole export/import). Skip it and tell the user.
      console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(src, entry.name)}`);
      continue;
    }
    if (IGNORED_FILES.has(entry.name)) continue;
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
// A-03: recursively delete only the files under `destPath` whose relative
// path (forward-slash joined, matching listFilesAtRef()'s format) is a
// member of `deleteSet`. Used by syncDirReportChanges() below when an
// entire dest entry has no counterpart in src -- a bulk "delete the whole
// directory" can't tell an explicit remote deletion apart from a file that
// was added locally and never made it into the sync base, so this walks the
// subtree file-by-file instead. A directory left empty after pruning is
// removed too, so stale empty dirs don't linger.
function pruneByDeleteSet(destPath, rel, deleteSet, changes) {
  // F#1: lstatSync (not statSync) so a dest-side symlink is treated as a
  // leaf. statSync FOLLOWS a symlink -- a dest symlink pointing at a
  // directory would report isDirectory() true and readdirSync below would
  // recurse into the LINK TARGET. With lstatSync, the symlink itself is a
  // non-directory leaf: it is only removed (the link, never the target) if
  // its rel is explicitly in deleteSet.
  const stat = fs.lstatSync(destPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(destPath, { withFileTypes: true })) {
      pruneByDeleteSet(path.join(destPath, entry.name), `${rel}/${entry.name}`, deleteSet, changes);
    }
    if (fs.existsSync(destPath) && fs.readdirSync(destPath).length === 0) {
      fs.rmSync(destPath, { recursive: true, force: true });
    }
  } else if (deleteSet.has(rel)) {
    changes.push(rel);
    fs.rmSync(destPath, { force: true });
  }
}

// A-03: optional 5th param `deleteSet` turns off mirror-deletion. When
// provided (even as an empty Set), a dest entry missing from src is deleted
// ONLY if its relative path is a member of deleteSet -- everything else
// missing from src is left on disk untouched. Omitted (undefined), behaviour
// is unchanged from before: every dest entry missing from src is deleted
// (full mirror), which is still what importUserConfig() wants for
// commands/agents/etc.
function syncDirReportChanges(src, dest, exclude, prefix, deleteSet) {
  prefix = prefix || '';
  const changes = [];

  // Deletions: dest entries with no counterpart in src.
  if (fs.existsSync(dest)) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        // F#1: a dest-side symlink is left alone, not deleted -- same as
        // removeStalePaths (syncing symlinks is unsupported). Warn with the
        // source-side path when a same-named entry exists there, else the
        // dest entry itself.
        const srcPath = path.join(src, entry.name);
        const warnPath = fs.existsSync(srcPath) ? srcPath : path.join(dest, entry.name);
        console.warn(`[claude-sync] skipping symlink (not synced): ${warnPath}`);
        continue;
      }
      // D-01 regression: mirror the IGNORED_FILES filter the other walkers
      // apply, or a local .DS_Store never matches the (already-filtered)
      // src/export side and gets reported as a phantom deletion.
      if (IGNORED_FILES.has(entry.name)) continue;
      if (exclude && exclude.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!fs.existsSync(srcPath)) {
        if (deleteSet) {
          pruneByDeleteSet(destPath, rel, deleteSet, changes);
        } else if (entry.isDirectory()) {
          for (const f of listFilesRecursive(destPath, rel)) changes.push(f);
          fs.rmSync(destPath, { recursive: true, force: true });
        } else {
          changes.push(rel);
          fs.rmSync(destPath, { recursive: true, force: true });
        }
      }
    }
  }

  // Additions/overwrites: copy src entries whose content actually differs.
  if (!fs.existsSync(src)) return changes;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      // F#1: src is the repo/remote side here -- following this symlink
      // would readFileSync/copyFileSync the LINK TARGET's content into
      // CLAUDE_HOME (exfiltration risk: a malicious remote could commit a
      // symlink pointing at an arbitrary local file, e.g. ~/.ssh/id_rsa).
      // Skip it, same as copyDirSync.
      console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(src, entry.name)}`);
      continue;
    }
    // D-01 regression: same IGNORED_FILES filter as the deletion loop above.
    if (IGNORED_FILES.has(entry.name)) continue;
    if (exclude && exclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const destIsDir = fs.existsSync(destPath) && fs.statSync(destPath).isDirectory();
    if (entry.isDirectory()) {
      if (fs.existsSync(destPath) && !destIsDir) fs.rmSync(destPath, { force: true });
      for (const f of syncDirReportChanges(srcPath, destPath, undefined, rel, deleteSet)) changes.push(f);
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

// B-02: read-only twin of syncDirReportChanges — returns the same relative
// change list (additions, content overwrites, and deletions of dest entries
// absent from src) WITHOUT touching the filesystem. Used to preview what a
// deferred CONFIRM_REQUIRED_DIR would change so pull() can surface it under
// `pendingConfirmation` before anything is written. Handles a file↔dir type
// mismatch defensively (statSync before readdirSync) since it may recurse into
// a dest path that is currently a file where src has a directory.
function computeDirChanges(src, dest, prefix) {
  prefix = prefix || '';
  const changes = [];
  const destIsDir = fs.existsSync(dest) && fs.statSync(dest).isDirectory();
  if (destIsDir) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        // F#1: mirror syncDirReportChanges' skip so the preview agrees with
        // the actual import -- a symlink is left alone, not reported as a
        // pending deletion.
        const srcPath = path.join(src, entry.name);
        const warnPath = fs.existsSync(srcPath) ? srcPath : path.join(dest, entry.name);
        console.warn(`[claude-sync] skipping symlink (not synced): ${warnPath}`);
        continue;
      }
      // D-01 regression: mirror the IGNORED_FILES filter syncDirReportChanges
      // applies, so preview and the real mirror agree on what's a change.
      if (IGNORED_FILES.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!fs.existsSync(srcPath)) {
        if (entry.isDirectory()) {
          for (const f of listFilesRecursive(path.join(dest, entry.name), rel)) changes.push(f);
        } else {
          changes.push(rel);
        }
      }
    }
  }
  if (!fs.existsSync(src)) return changes;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      // F#1: keep the preview consistent with the now-symlink-skipping
      // import -- a symlink is not synced, so it must not show up as a
      // pending change (and its target must not be read to compare).
      console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(src, entry.name)}`);
      continue;
    }
    // D-01 regression: same IGNORED_FILES filter as the deletion loop above.
    if (IGNORED_FILES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const childIsDir = fs.existsSync(destPath) && fs.statSync(destPath).isDirectory();
    if (entry.isDirectory()) {
      for (const f of computeDirChanges(srcPath, destPath, rel)) changes.push(f);
    } else {
      const srcBuf = fs.readFileSync(srcPath);
      const unchanged = !childIsDir && fs.existsSync(destPath) && srcBuf.equals(fs.readFileSync(destPath));
      if (!unchanged) changes.push(rel);
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

// Phase 1A (sync-pin): snapshot the exact version/commit of every ENABLED
// plugin into REPO_DIR/global/plugins.lock.json, so another machine can
// reproduce the same plugin versions on pull. Truth source per plugin is
// the gitCommitSha the CLI records in installed_plugins.json at install
// time; when that's missing we fall back to the HEAD of the marketplace's
// local clone (pinned-marketplaces/ or known_marketplaces.json's
// installLocation). Plugins we can't pin a commit for are reported back as
// `unlockable` instead of silently dropped.
function exportPluginLock() {
  const config = loadConfig() || {};
  if (config.pinPlugins === false) {
    return { skipped: true, unlockable: [] };
  }

  const settings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), { fallback: {} });
  const enabledPlugins = settings.enabledPlugins || {};
  // AUXILIARY reads, same fallback:{} reasoning as detectMissingPlugins().
  const installed = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), { fallback: {} });
  const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });
  // F#1: once a machine has APPLIED a pin, known[marketplace].source is a
  // local path-source clone, not the original upstream -- the naive
  // github/source.url derivation below would then overwrite the lock's real
  // url with a machine-local path on re-push. previousLock lets us prefer
  // the url a prior export already recorded (read once here for that).
  const previousLock = readJsonFile(path.join(REPO_DIR, 'global', 'plugins.lock.json'), { fallback: null });

  const enabledIds = Object.keys(enabledPlugins).filter(id => enabledPlugins[id]).sort();

  const pluginResults = {};
  const marketplaceResults = {};
  const unlockable = [];

  for (const id of enabledIds) {
    const marketplace = id.slice(id.lastIndexOf('@') + 1);
    const versions = (installed.plugins && installed.plugins[id]) || [];
    const entry = versions.find(v => v.gitCommitSha) || versions[0];

    let commit = entry && entry.gitCommitSha;
    if (!commit) {
      const candidateDirs = [
        path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces', marketplace),
        known[marketplace] && known[marketplace].installLocation,
      ].filter(dir => dir && fs.existsSync(dir));
      for (const dir of candidateDirs) {
        try {
          // gitExecFile hardcodes `-C REPO_DIR`, so it can't target an
          // arbitrary clone -- shell out directly, same style used for
          // the global git config reads above.
          const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim();
          if (out) { commit = out; break; }
        } catch { /* not a git repo / no HEAD -- try the next candidate */ }
      }
    }

    if (!commit) {
      unlockable.push(id);
      continue;
    }

    pluginResults[id] = { marketplace, version: entry && entry.version };
    if (!(marketplace in marketplaceResults)) {
      const source = known[marketplace] && known[marketplace].source;
      // F#1 url priority: (1) the url already committed for this
      // marketplace in the EXISTING lock -- preserves the original upstream
      // across re-pushes from a machine that has since applied the pin and
      // whose known_marketplaces.json source is now a local clone; (2) a
      // github source; (3) the pinned clone's own `origin` remote, which was
      // cloned FROM the original url; (4) the existing source.url fallback.
      const previousUrl = previousLock && previousLock.marketplaces
        && previousLock.marketplaces[marketplace] && previousLock.marketplaces[marketplace].url;
      let url = previousUrl;
      if (!url) {
        url = source && source.source === 'github'
          ? `https://github.com/${source.repo}.git`
          : null;
      }
      if (!url) {
        const pinnedCloneDir = path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces', marketplace);
        if (fs.existsSync(pinnedCloneDir)) {
          try {
            url = execFileSync('git', ['-C', pinnedCloneDir, 'remote', 'get-url', 'origin'], { stdio: 'pipe' })
              .toString().trim() || null;
          } catch { /* no origin remote / not a git repo -- fall through */ }
        }
      }
      if (!url) url = source && source.url;
      marketplaceResults[marketplace] = { url, pinnedCommit: commit };
    }
  }

  // Determinism: assemble both maps with alphabetically-sorted keys so the
  // lockfile diffs cleanly across machines/runs.
  const plugins = {};
  for (const id of Object.keys(pluginResults).sort()) plugins[id] = pluginResults[id];
  const marketplaces = {};
  for (const name of Object.keys(marketplaceResults).sort()) marketplaces[name] = marketplaceResults[name];

  const outDir = path.join(REPO_DIR, 'global');
  const destPath = path.join(outDir, 'plugins.lock.json');

  // Idempotency: computeLocalChanges() runs exportAll() (hence
  // exportPluginLock()) as a status/preview probe that writes then reverts,
  // and push() runs it again right before committing. A volatile
  // generatedAt would make the lockfile look changed on every call even
  // when nothing substantive did -- status would permanently report "local
  // changes" and push would commit pure noise. Reuse the previous
  // generatedAt/generatedBy when the content is unchanged.
  let generatedAt = new Date().toISOString();
  let generatedBy = os.hostname();
  // previousLock was already read (above, for the url-preservation logic)
  // from this exact destPath -- reuse it instead of reading it twice.
  const existing = previousLock;
  if (
    existing &&
    JSON.stringify(existing.marketplaces) === JSON.stringify(marketplaces) &&
    JSON.stringify(existing.plugins) === JSON.stringify(plugins)
  ) {
    generatedAt = existing.generatedAt;
    generatedBy = existing.generatedBy;
  }

  fs.mkdirSync(outDir, { recursive: true });
  unlinkIfSymlink(destPath); // F#9: never write THROUGH a planted symlink
  fs.writeFileSync(destPath, JSON.stringify({ version: 1, generatedAt, generatedBy, marketplaces, plugins }, null, 2));

  return { skipped: false, unlockable };
}

function pinPluginsEnabled() {
  return (loadConfig() || {}).pinPlugins !== false;
}

function pinPluginsDecided() {
  const config = loadConfig() || {};
  return Object.prototype.hasOwnProperty.call(config, 'pinPlugins');
}

function setPinPlugins(enabled) {
  const config = loadConfig() || {};
  config.pinPlugins = enabled;
  saveConfig(config);
}

// Phase 2 (sync-pin vendor fallback): config.vendorMarketplaces is the list
// of marketplace names exportPluginVendorBundles() vendors on push (git
// bundle of the pinned commit, stored in the sync repo). Exposed to users
// via `/sync-pin vendor <marketplace> [off]`.
function vendorMarketplaces() {
  return (loadConfig() || {}).vendorMarketplaces || [];
}

function setVendorMarketplace(name, enabled) {
  const config = loadConfig() || {};
  const names = Array.isArray(config.vendorMarketplaces) ? config.vendorMarketplaces : [];
  config.vendorMarketplaces = enabled
    ? (names.includes(name) ? names : [...names, name])
    : names.filter(n => n !== name);
  saveConfig(config);
  return config.vendorMarketplaces;
}

// Phase 1A (sync-pin), read-only: compare the plugin lock recorded at `ref`
// (default 'HEAD', i.e. the last commit) against what's actually installed
// on THIS machine right now, so /sync-status and pull-preview can show drift
// without mutating anything. No lockfile at `ref` means nothing to compare
// against -- returns [] rather than throwing.
function getPluginLockDrift(ref = 'HEAD') {
  const lock = readJsonAtRef(ref, 'global/plugins.lock.json');
  if (!lock) return [];

  const installed = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), { fallback: {} });
  const settings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), { fallback: {} });
  const enabledPlugins = settings.enabledPlugins || {};
  const lockedPlugins = lock.plugins || {};
  const marketplaces = lock.marketplaces || {};

  const ids = new Set([
    ...Object.keys(lockedPlugins),
    ...Object.keys(enabledPlugins).filter(id => enabledPlugins[id]),
  ]);

  const rows = [];
  for (const id of ids) {
    const lockedEntry = lockedPlugins[id];
    const lockedVersion = (lockedEntry && lockedEntry.version) || null;
    const lockedCommit = (lockedEntry && marketplaces[lockedEntry.marketplace] && marketplaces[lockedEntry.marketplace].pinnedCommit) || null;

    const versions = (installed.plugins && installed.plugins[id]) || [];
    const installedEntry = versions.find(v => v.gitCommitSha) || versions[0];
    const currentVersion = (installedEntry && installedEntry.version) || null;
    const currentCommit = (installedEntry && installedEntry.gitCommitSha) || null;

    let action;
    if (!lockedEntry) {
      action = 'unlocked';
    } else if (!installedEntry) {
      action = 'missing';
    } else if (currentCommit || lockedCommit) {
      action = currentCommit === lockedCommit ? 'in-sync' : 'reinstall';
    } else {
      action = currentVersion === lockedVersion ? 'in-sync' : 'reinstall';
    }

    rows.push({ plugin: id, lockedVersion, lockedCommit, currentVersion, currentCommit, action });
  }

  rows.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  return rows;
}

function exportAll() {
  exportSettings();
  exportPluginConfigs();
  exportPluginData();
  exportUserConfig();
  const { unlockable } = exportPluginLock();
  const { vendored } = exportPluginVendorBundles();
  return { unlockable, vendored };
}

// Phase 2 (sync-pin): protects a vendored marketplace against upstream
// history rewrites (force-push that deletes the pinned commit). For every
// name in config.vendorMarketplaces, git-bundles the pinned commit's full
// reachable history into REPO_DIR/global/plugin-vendor/<name>/<commit>.bundle
// -- the bundle file's PRESENCE is itself the "this marketplace is vendored"
// signal; there is no lockfile flag for it. Bundles are commit-named (not
// marketplace-named) rather than marketplace-named, so a re-run with the
// same pin is a no-op: git bundles are not byte-deterministic across runs,
// so regenerating one every push would produce a spurious diff. Any bundle
// left over from a previously-pinned commit is pruned, so only the current
// pin's bundle survives per marketplace.
function exportPluginVendorBundles() {
  const config = loadConfig() || {};
  const names = config.vendorMarketplaces || [];
  if (names.length === 0) return { vendored: [], skipped: [] };

  const lock = readJsonFile(path.join(REPO_DIR, 'global', 'plugins.lock.json'), { fallback: null });
  if (!lock) return { vendored: [], skipped: [] };

  const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });

  const vendored = [];
  const skipped = [];

  for (const name of names) {
    const safeName = sanitizeMarketplaceName(name);
    if (!safeName) { skipped.push({ name, status: 'invalid-name' }); continue; }

    const commit = lock.marketplaces && lock.marketplaces[name] && lock.marketplaces[name].pinnedCommit;
    if (!commit) { skipped.push({ name, status: 'not-in-lock' }); continue; }

    // Find a local clone that actually HAS the commit: the pinned clone
    // first (checked out detached at exactly this commit), then the
    // marketplace's registered install location as a fallback.
    const candidateDirs = [
      path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces', name),
      known[name] && known[name].installLocation,
    ].filter(dir => dir && fs.existsSync(dir));

    let sourceDir = null;
    for (const dir of candidateDirs) {
      try {
        execFileSync('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'pipe' });
        sourceDir = dir;
        break;
      } catch { /* doesn't have the commit -- try the next candidate */ }
    }
    if (!sourceDir) { skipped.push({ name, status: 'no-source' }); continue; }

    const outDir = path.join(REPO_DIR, 'global', 'plugin-vendor', name);
    const bundleFile = path.join(outDir, `${commit}.bundle`);

    // Prune bundles for any OTHER commit -- stale leftovers from a
    // previous pin of this marketplace.
    if (fs.existsSync(outDir)) {
      for (const entry of fs.readdirSync(outDir)) {
        if (entry.endsWith('.bundle') && entry !== `${commit}.bundle`) {
          fs.rmSync(path.join(outDir, entry), { force: true });
        }
      }
    }

    if (!fs.existsSync(bundleFile)) {
      fs.mkdirSync(outDir, { recursive: true });
      unlinkIfSymlink(bundleFile); // F#9: never write THROUGH a planted symlink
      // A bare commit sha is refused by `git bundle create` ("Refusing to
      // create empty bundle") since it isn't a ref. Create a temporary tag
      // at the commit, bundle THAT (captures the commit's full reachable
      // history), then delete the tag -- works regardless of what the
      // source repo's HEAD currently points at (a pinned clone's HEAD is
      // already the commit, but an installLocation clone's HEAD may not be).
      const tempTag = `claude-sync-vendor-tmp-${process.pid}-${Date.now()}`;
      try {
        execFileSync('git', ['-C', sourceDir, 'tag', tempTag, commit], { stdio: 'pipe' });
        execFileSync('git', ['-C', sourceDir, 'bundle', 'create', bundleFile, tempTag], { stdio: 'pipe' });
      } finally {
        try { execFileSync('git', ['-C', sourceDir, 'tag', '-d', tempTag], { stdio: 'pipe' }); } catch {}
      }
    }

    vendored.push({ name, commit, status: 'vendored' });
  }

  // F#4: prune bundle dirs for marketplaces that USED to be vendored but
  // were removed from config.vendorMarketplaces (e.g. `/sync-pin vendor
  // <name> off`). Without this, the old dir keeps syncing and is still
  // auto-discovered as a restore fallback by preparePinnedClone(), so
  // turning vendoring off doesn't actually stop it.
  const vendorRoot = path.join(REPO_DIR, 'global', 'plugin-vendor');
  if (fs.existsSync(vendorRoot)) {
    for (const entry of fs.readdirSync(vendorRoot)) {
      if (!names.includes(entry)) {
        fs.rmSync(path.join(vendorRoot, entry), { recursive: true, force: true });
      }
    }
  }

  return { vendored, skipped };
}

// ---------------------------------------------------------------------------
// Phase 1B (sync-pin): pinned-marketplace clone mechanics
// ---------------------------------------------------------------------------

// A marketplace name (sourced from plugins.lock.json, which round-trips
// through a synced repo an attacker may control) is only ever safe to use as
// a single path segment under cloneRoot if it matches this charset -- no
// separators, no leading dot, no traversal. Returns the name unchanged when
// safe, else null.
const SAFE_MARKETPLACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function sanitizeMarketplaceName(name) {
  if (typeof name !== 'string') return null;
  if (name === '' || name === '.' || name === '..') return null;
  if (name.length > 128) return null;
  if (!SAFE_MARKETPLACE_NAME.test(name)) return null;
  return name;
}

// Prepares <cloneRoot>/<name> as a full clone of `url`, checked out
// (detached) at `commit`. Pure git/filesystem mechanics -- no `claude plugin`
// CLI calls (that's a later task), so this is fully testable against local
// git repos. gitExecFile() is hardcoded to `-C REPO_DIR` and cannot target an
// arbitrary directory, so every git call here shells out directly via
// execFileSync with an explicit array + `-C <cloneDir>` (no shell, matching
// B-01's no-shell contract elsewhere in this file).
//
// Idempotent: a pre-existing cloneDir is reused (verify/fetch/checkout)
// instead of re-cloned, so re-pinning at a new commit (or re-running after a
// partial failure) doesn't error on "destination path already exists".
//
// opts.vendorBundle (Phase 2, optional): absolute path to a
// `<commit>.bundle` produced by exportPluginVendorBundles(), used as a
// last-resort restore source when the pinned commit is unreachable from
// `url` -- e.g. after an upstream force-push rewrote it away. A git bundle
// is a valid clone/fetch source in its own right, so it's tried exactly
// where origin would otherwise be given up on. Omitting it (or pointing it
// at a file that doesn't exist) leaves every code path byte-identical to
// before this option existed.
function preparePinnedClone(name, url, commit, opts = {}) {
  const safeName = sanitizeMarketplaceName(name);
  if (!safeName) return { status: 'invalid-name' };

  try {
    validateRemoteUrl(url);
  } catch {
    return { status: 'invalid-url' };
  }

  const cloneRoot = opts.cloneRoot || path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces');
  const cloneDir = path.join(cloneRoot, safeName);
  const hasBundle = opts.vendorBundle && fs.existsSync(opts.vendorBundle);

  if (!fs.existsSync(cloneDir)) {
    try {
      execFileSync('git', ['clone', url, cloneDir], { stdio: 'pipe' });
    } catch (err) {
      if (!hasBundle) return { status: 'clone-failed', error: err.message };
      // Origin is unreachable/invalid -- a bundle is itself a valid clone
      // source, so fall back to cloning from it directly.
      try {
        execFileSync('git', ['clone', opts.vendorBundle, cloneDir], { stdio: 'pipe' });
      } catch (bundleErr) {
        return { status: 'clone-failed', error: bundleErr.message };
      }
    }
  }

  const hasCommit = () => {
    try {
      execFileSync('git', ['-C', cloneDir, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };

  if (!hasCommit()) {
    // Best-effort: the clone may simply be behind origin. Ignore fetch
    // failure (offline, unreachable remote) and re-check below -- either way
    // a still-absent commit means we must not touch the checkout.
    try {
      execFileSync('git', ['-C', cloneDir, 'fetch', 'origin'], { stdio: 'pipe' });
    } catch { /* best-effort */ }
    if (!hasCommit() && hasBundle) {
      // Origin is reachable but no longer has the commit (history rewrite)
      // -- pull it in from the vendor bundle instead, into a namespaced ref
      // so it doesn't collide with anything origin has.
      try {
        execFileSync('git', ['-C', cloneDir, 'fetch', opts.vendorBundle, 'refs/*:refs/vendor/*'], { stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
    if (!hasCommit()) {
      return { status: 'unreproducible', commit };
    }
  }

  execFileSync('git', ['-C', cloneDir, 'checkout', '--detach', commit], { stdio: 'pipe' });

  return { status: 'ready', cloneDir, commit };
}

// Phase 1B (sync-pin): the `claude plugin` CLI is the only way to mutate
// global plugin state (marketplace registration, install/uninstall/enable),
// so it's the seam applyPluginLock() calls through. Setting CLAUDE_CONFIG_DIR
// explicitly makes the CLI operate on the SAME home the engine itself is
// using (production ~/.claude, or a tmp CLAUDE_SYNC_HOME in tests) -- this is
// the isolation contract that keeps applyPluginLock() from ever touching the
// developer's real plugin state when a test injects a different runPlugin.
function runPluginCli(args) {
  return execFileSync('claude', ['plugin', ...args], {
    stdio: 'pipe',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_HOME },
  }).toString();
}

// Phase 1C (sync-pin): per-marketplace pin mechanics shared by
// applyPluginLock() (reproduce a stored lock) and migrateMarketplaceToPinned()
// (pin what's installed right now). Prepares a pinned local clone
// (preparePinnedClone) at `commit`, registers it as a path-source marketplace
// under `name` (replacing any existing registration at a different
// installLocation), then reinstalls every plugin that was either previously
// installed from that marketplace or passed in via opts.lockedIds, so nothing
// is left orphaned by the marketplace swap. Disabled plugins are re-disabled
// afterward, since install/update always re-enables.
function pinMarketplaceToCommit(name, url, commit, opts = {}) {
  const runPlugin = opts.runPlugin || runPluginCli;

  // A vendor bundle at the conventional exportPluginVendorBundles() path is
  // auto-discovered as the restore fallback for preparePinnedClone() -- the
  // bundle's mere presence on disk IS the "this marketplace is vendored"
  // signal, so no separate config lookup is needed here.
  const bundlePath = path.join(REPO_DIR, 'global', 'plugin-vendor', name, `${commit}.bundle`);
  const prepareOpts = {
    ...(opts.prepareOpts || {}),
    vendorBundle: fs.existsSync(bundlePath) ? bundlePath : undefined,
  };

  const prep = preparePinnedClone(name, url, commit, prepareOpts);
  if (prep.status !== 'ready') {
    return { name, status: prep.status }; // touch NO installs for a marketplace we couldn't prepare
  }

  const installed = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), { fallback: {} });
  const settings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), { fallback: {} });
  const enabledPlugins = settings.enabledPlugins || {};
  const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });

  // Snapshot before mutating anything, so the reinstall set accounts for
  // both what's actually installed right now and what the caller expects.
  const priorInstalledIds = Object.keys(installed.plugins || {})
    .filter(id => id.slice(id.lastIndexOf('@') + 1) === name);
  const disabledIds = priorInstalledIds.filter(id => enabledPlugins[id] === false);
  const lockedIds = opts.lockedIds || [];
  const reinstallIds = Array.from(new Set([...priorInstalledIds, ...lockedIds])).sort();

  // Registration: only remove an existing registration pointed elsewhere
  // (re-adding under the same name/location would be a needless uninstall).
  if (known[name] && known[name].installLocation !== prep.cloneDir) {
    runPlugin(['marketplace', 'remove', name]);
  }
  runPlugin(['marketplace', 'add', prep.cloneDir]);
  runPlugin(['marketplace', 'update', name]);

  // install is idempotent on an already-installed id, so a plain uninstall
  // then install is required to land a possibly different pinned version.
  for (const id of reinstallIds) {
    try { runPlugin(['uninstall', id]); } catch { /* wasn't installed -- fine */ }
    runPlugin(['install', id]);
  }

  // install/update always re-enables -- restore anything that was
  // deliberately disabled before we touched it.
  for (const id of disabledIds) {
    runPlugin(['disable', id]);
  }

  return { name, status: 'applied', commit, reinstalled: reinstallIds, disabled: disabledIds };
}

// Phase 1B (sync-pin): reproduces the plugin versions recorded in
// plugins.lock.json on this machine. For each selected marketplace, hands off
// to pinMarketplaceToCommit() with the lock's url/commit and the plugin ids
// the lock expects for that marketplace.
function applyPluginLock(options = {}) {
  const runPlugin = options.runPlugin || runPluginCli;

  if (!pinPluginsEnabled()) {
    return { skipped: 'disabled', results: [], unreproducible: [] };
  }

  const lock = readJsonFile(path.join(REPO_DIR, 'global', 'plugins.lock.json'), { fallback: null });
  if (!lock) {
    return { skipped: 'no-lock', results: [], unreproducible: [] };
  }

  const selected = options.marketplaces || Object.keys(lock.marketplaces);

  const results = [];
  const unreproducible = [];

  for (const name of selected) {
    const marketplaceEntry = lock.marketplaces[name];
    if (!marketplaceEntry) continue; // not in the lock -- nothing to reproduce

    const { url, pinnedCommit } = marketplaceEntry;
    const lockedIds = Object.keys(lock.plugins || {})
      .filter(id => lock.plugins[id].marketplace === name);

    const result = pinMarketplaceToCommit(name, url, pinnedCommit, {
      runPlugin, prepareOpts: options.prepareOpts, lockedIds,
    });

    if (result.status === 'unreproducible') unreproducible.push(name);
    results.push(result);
  }

  return { skipped: false, results, unreproducible };
}

// Phase 1C (sync-pin): pins THIS machine's CURRENT github-source marketplace
// to its CURRENT commit -- "pin what you have now", no lockfile required.
// Lets a machine opt an existing github-source marketplace into pinning
// without first exporting/pushing a lock.
function migrateMarketplaceToPinned(name, opts = {}) {
  const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });
  if (!known[name]) return { name, status: 'unknown-marketplace' };

  const source = known[name].source;
  const url = source && source.source === 'github'
    ? `https://github.com/${source.repo}.git`
    : source && source.url;
  if (!url) return { name, status: 'no-url' };

  // Prefer the marketplace's installed clone HEAD; fall back to any
  // installed plugin's recorded gitCommitSha for this marketplace.
  let commit;
  try {
    commit = execFileSync('git', ['-C', known[name].installLocation, 'rev-parse', 'HEAD'], { stdio: 'pipe' })
      .toString().trim();
  } catch { /* no installLocation, not a git repo, or no HEAD -- fall back below */ }

  if (!commit) {
    const installed = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), { fallback: {} });
    for (const id of Object.keys(installed.plugins || {})) {
      if (id.slice(id.lastIndexOf('@') + 1) !== name) continue;
      const entry = (installed.plugins[id] || []).find(v => v.gitCommitSha);
      if (entry) { commit = entry.gitCommitSha; break; }
    }
  }
  if (!commit) return { name, status: 'no-commit' };

  return pinMarketplaceToCommit(name, url, commit, { runPlugin: opts.runPlugin, prepareOpts: opts.prepareOpts });
}

// Phase 1C (sync-pin): UNPIN -- converts a claude-sync-managed path-source
// marketplace back to its original github source and reinstalls at latest.
// Without this, a marketplace pinned by migrateMarketplaceToPinned() or
// applyPluginLock() would be frozen at that commit forever with no way back
// (a "zombie pin").
function reverseMigrateMarketplace(name, opts = {}) {
  const runPlugin = opts.runPlugin || runPluginCli;

  // The lockfile preserves the original github url even after the local
  // registration became a path-source clone; prefer it, and fall back to
  // known_marketplaces.json for a machine that never pulled a lock.
  const lock = readJsonFile(path.join(REPO_DIR, 'global', 'plugins.lock.json'), { fallback: null });
  let originalUrl = lock && lock.marketplaces && lock.marketplaces[name] && lock.marketplaces[name].url;

  if (!originalUrl) {
    const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });
    const source = known[name] && known[name].source;
    originalUrl = source && source.source === 'github'
      ? `https://github.com/${source.repo}.git`
      : source && source.url;
  }
  if (!originalUrl) return { name, status: 'no-origin-url' };

  // originalUrl round-trips through a synced repo an attacker may control --
  // validate before handing it to `claude plugin marketplace add`, which
  // git-clones it, same as every other clone/add path in this file
  // (preparePinnedClone). Return BEFORE any runPlugin call so a bad url
  // touches no plugin state.
  try {
    validateRemoteUrl(originalUrl);
  } catch {
    return { name, status: 'invalid-origin-url' };
  }

  const installed = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), { fallback: {} });
  const settings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), { fallback: {} });
  const enabledPlugins = settings.enabledPlugins || {};

  // Snapshot before removing the marketplace (which uninstalls its plugins).
  const priorInstalledIds = Object.keys(installed.plugins || {})
    .filter(id => id.slice(id.lastIndexOf('@') + 1) === name)
    .sort();
  const disabledIds = priorInstalledIds.filter(id => enabledPlugins[id] === false);

  runPlugin(['marketplace', 'remove', name]);
  runPlugin(['marketplace', 'add', originalUrl]);
  runPlugin(['marketplace', 'update', name]);

  for (const id of priorInstalledIds) {
    try { runPlugin(['uninstall', id]); } catch { /* wasn't installed -- fine */ }
    runPlugin(['install', id]);
  }
  for (const id of disabledIds) {
    runPlugin(['disable', id]);
  }

  // Best-effort: remove the managed clone dir so it can't be silently
  // re-registered later (e.g. by a stale addAllowSyncDir/apply call).
  try {
    fs.rmSync(path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces', name), { recursive: true, force: true });
  } catch { /* best-effort */ }

  return { name, status: 'unpinned', reinstalled: priorInstalledIds, disabled: disabledIds };
}

// Phase 1C (sync-pin): upgrade primitive behind `/sync-pin set` -- re-pins
// `name` to a specific git ref (tag, branch, or sha) instead of a commit the
// caller already knows. Resolves the url the same way reverseMigrateMarketplace()
// does (lockfile first, known_marketplaces.json fallback), ensures a local
// clone exists, fetches so a newly-created tag/branch is reachable, then
// resolves `ref` to a commit sha BEFORE calling pinMarketplaceToCommit() --
// so a bad ref touches no plugin state, same contract as preparePinnedClone's
// 'unreproducible' path.
function setPinnedRef(name, ref, opts = {}) {
  const safeName = sanitizeMarketplaceName(name);
  if (!safeName) return { name, status: 'invalid-name' };

  const lock = readJsonFile(path.join(REPO_DIR, 'global', 'plugins.lock.json'), { fallback: null });
  let url = lock && lock.marketplaces && lock.marketplaces[name] && lock.marketplaces[name].url;

  if (!url) {
    const known = readJsonFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), { fallback: {} });
    const source = known[name] && known[name].source;
    url = source && source.source === 'github'
      ? `https://github.com/${source.repo}.git`
      : source && source.url;
  }
  if (!url) return { name, status: 'no-url' };

  try {
    validateRemoteUrl(url);
  } catch {
    return { name, status: 'invalid-url' };
  }

  const cloneRoot = (opts.prepareOpts && opts.prepareOpts.cloneRoot)
    || path.join(CLAUDE_HOME, 'sync', 'pinned-marketplaces');
  const cloneDir = path.join(cloneRoot, safeName);

  if (!fs.existsSync(cloneDir)) {
    try {
      execFileSync('git', ['clone', url, cloneDir], { stdio: 'pipe' });
    } catch (err) {
      return { name, status: 'clone-failed', error: err.message };
    }
  }

  // Best-effort: an already-present clone may not yet have `ref` (a tag
  // pushed after the clone was made, or a branch never fetched).
  try {
    execFileSync('git', ['-C', cloneDir, 'fetch', '--tags', 'origin'], { stdio: 'pipe' });
  } catch { /* best-effort */ }

  // F#3: for a BRANCH ref, fetch above updates origin/<ref> but the clone
  // stays detached at its old pin -- it never has (and never updates) a
  // local branch named `ref`. Resolving `ref` directly would therefore
  // silently return the STALE commit instead of the fetched tip. Try the
  // candidates most-specific-first: an explicit tag, then the fetched
  // remote-tracking branch, then `ref` as-is (covers a raw sha).
  const candidates = [`refs/tags/${ref}`, `refs/remotes/origin/${ref}`, ref];
  let commit;
  for (const candidate of candidates) {
    try {
      commit = execFileSync('git', ['-C', cloneDir, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { stdio: 'pipe' })
        .toString().trim();
      if (commit) break;
    } catch { /* this candidate doesn't resolve -- try the next */ }
  }
  if (!commit) {
    return { name, status: 'bad-ref', ref };
  }

  const result = pinMarketplaceToCommit(name, url, commit, { runPlugin: opts.runPlugin, prepareOpts: opts.prepareOpts });
  return { ...result, ref };
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
      if (entry.isSymbolicLink()) {
        // F#1: same as exportPluginData -- skip a top-level plugin-data
        // symlink instead of letting the copyFileSync below follow it into
        // the backup.
        console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(pluginsDir, entry.name)}`);
        continue;
      }
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
  for (const old of backups.slice(BACKUP_RETENTION)) {
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

// F#1 review: guard for the import-side reads of fixed-name files under
// REPO_DIR (settings.json, plugin config JSON, CLAUDE.md). The C-09/F#1
// walkers already skip symlinks inside synced *directories*, but these three
// fixed-name repo files are read directly, bypassing those walkers. A
// malicious remote can commit any of them as a symlink pointing at an
// arbitrary local file (e.g. `../../../.ssh/id_rsa`); following it on import
// would read the TARGET's content into ~/.claude and the next push would
// exfiltrate it (reviewer reproduced this on CLAUDE.md). Callers refuse
// (warn + skip) when this returns true.
//
// This guards the REPO side ONLY. The export side (local -> repo) deliberately
// still follows local symlinks: a user pointing ~/.claude/settings.json or
// CLAUDE.md at their own dotfiles repo is a legitimate, common setup, and
// exporting the link target's content is the correct, expected behaviour there.
function isRepoSymlink(p) {
  return fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink();
}

// F#9 (F#1 review): before writing a managed file into the sync repo, drop it if it
// is a symlink. A malicious remote can commit a symlink at a managed repo path;
// reset --hard materializes it, and a plain writeFileSync/copyFileSync would then
// write THROUGH the link to its target (arbitrary local-file overwrite). Replacing
// the link with a fresh regular file neutralizes that.
function unlinkIfSymlink(p) {
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true }); } catch {}
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
  if (isRepoSymlink(repoSettings)) {
    // F#1 review: a symlinked repo settings.json would follow the link and
    // read an arbitrary local file as "remote settings". Refuse it and treat
    // the remote as having no settings this pull (same as the file being
    // absent above) -- warn but DON'T throw, so a single planted symlink can't
    // DoS the whole pull; the rest of the import proceeds normally.
    console.warn(`[claude-sync] refusing to import symlinked repo file (possible attack): ${repoSettings}`);
    return { changed: false, conflicts: [] };
  }
  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  // C-04: both sides feed the 3-way merge below -- a corrupt local OR remote
  // settings.json must fail fast, never silently merge as {} (which would
  // read as "the user deleted every setting" and propagate on the next push).
  const localFull = readJsonFile(localPath, { required: true, fallback: {} });
  const local = { ...localFull };
  for (const key of SETTINGS_BLACKLIST) delete local[key];
  // A-04: repo-side settings.json holds ${CLAUDE_HOME} placeholders (see
  // exportSettings) -- transform back to this machine's absolute paths
  // before merging against local, matching importPluginConfigs.
  const remote = transformPathsForImport(readJsonFile(repoSettings, { required: true }));

  let merged, conflicts = [];
  if (forceRemote || !baseCommit) {
    // Plain overlay: take all remote keys, keep any local-only keys.
    merged = { ...local, ...remote };
  } else {
    const baseRaw = readJsonAtRef(baseCommit, 'global/settings.json');
    const base = baseRaw ? transformPathsForImport(baseRaw) : {};
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
    if (isRepoSymlink(repoFile)) {
      // F#1 review: a symlinked repo config JSON would follow the link and
      // read an arbitrary local file as "remote". Refuse it -- warn and skip
      // this file's merge (treat as absent), letting the other file and the
      // rest of the pull proceed. Don't throw (no single-file DoS).
      console.warn(`[claude-sync] refusing to import symlinked repo file (possible attack): ${repoFile}`);
      continue;
    }
    // C-04: both sides feed the 3-way merge below -- fail fast on corruption,
    // same reasoning as importSettings() above.
    const remoteRaw = readJsonFile(repoFile, { required: true });
    const remote = transformPathsForImport(remoteRaw);
    const destPath = path.join(CLAUDE_HOME, 'plugins', file);
    const localFull = readJsonFile(destPath, { required: true, fallback: {} });

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

// A-03: base-aware import for plugin-data -- NOT a full mirror. A dest file
// is deleted only when it existed in the BASE (last-sync commit) tree AND is
// absent from the current remote (the repo working tree, already reset to
// origin/<branch> by pull() before importAll() runs) -- i.e. the remote side
// explicitly deleted it. A local file that was never part of base (written
// locally after the last push/pull -- e.g. blocklist entries, learned data)
// has no base entry, so it is never a deletion candidate and survives even
// though getLocalDelta() deliberately excludes plugin-data from its
// "local has unpushed changes?" check (see getLocalDelta's comment) and
// would otherwise have let a mirror import wipe it out silently (A-03).
//
// options.baseCommit: the last-sync commit to diff against. Falsy (missing
// last-sync.json / corrupted state, or firstPullPending -- pull() passes
// baseCommit: null on a first pull because ~/.claude isn't yet a faithful
// copy of any base) means the deletion set is EMPTY: nothing is deleted this
// pull. That is the most conservative choice; a genuine remote deletion
// still propagates on a LATER pull once a real base commit exists. This is
// reported via `warnings` instead of throwing.
function importPluginData(options = {}) {
  const { baseCommit = null } = options;
  const srcDir = path.join(REPO_DIR, 'global', 'plugin-data');
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  const warnings = [];

  let deleteSet;
  if (baseCommit) {
    const baseFiles = listFilesAtRef(baseCommit, 'global/plugin-data');
    // listFilesRecursive() returns an empty Set for a non-existent dir, which
    // is exactly right here: git has no concept of an empty directory, so if
    // the remote side's LAST plugin-data file was deleted, `global/plugin-data`
    // itself no longer exists in the tree at all -- that must still read as
    // "every base file is a deletion candidate", not "nothing to compare".
    const remoteFiles = listFilesRecursive(srcDir);
    deleteSet = new Set([...baseFiles].filter(f => !remoteFiles.has(f)));
  } else {
    deleteSet = new Set();
    warnings.push(
      'plugin-data: no base commit available (first pull or missing last-sync state) -- skipped deletions this pull.'
    );
  }

  if (!fs.existsSync(srcDir) && !fs.existsSync(pluginsDir)) {
    // Nothing on the remote side to import and nothing local to prune
    // against -- skip entirely rather than creating an empty ~/.claude/plugins
    // as a side effect.
    return { changes: [], warnings };
  }
  fs.mkdirSync(pluginsDir, { recursive: true });
  // syncDirReportChanges's deletion phase does not require srcDir to exist
  // (it checks per-entry, not the top-level src), so this still correctly
  // prunes deleteSet-listed local files even when srcDir is entirely absent;
  // its copy phase is a no-op in that case since there is nothing to copy.
  const changes = syncDirReportChanges(srcDir, pluginsDir, PLUGIN_DATA_EXCLUDE, '', deleteSet);
  return { changes, warnings };
}

// F#4: a whole synced dir deleted on the remote (git drops the emptied dir) is
// invisible to getSyncDirsForImport (lists CURRENT repo dirs), so its stale local
// files linger and can be re-pushed. Base-aware prune: for an allow-listed dir that
// was in `baseCommit` but is now absent from the repo, delete the files that were in
// the base (== the ones the remote removed), leaving any local-only additions.
// Mirrors A-03's base-aware plugin-data deletion.
function pruneRemotelyDeletedUserDirs(baseCommit, changes) {
  if (!baseCommit) return;                          // first-pull / no base: never prune
  const allow = new Set(getSyncDirsForExport());
  const currentRepo = new Set(getSyncDirsForImport());
  for (const dir of listDirsAtRef(baseCommit, 'user-config')) {
    // F#4 review: NEVER prune CONFIRM_REQUIRED_DIRS (hooks/skills/rules). getLocalDelta
    // (safe-pull check) and pull's main import both skip these on purpose -- they flow
    // ONLY through content-based pendingConfirmation, never the automatic delta/import
    // path. Pruning them here would silently delete an UNPUSHED local exec-dir edit on a
    // safe pull (the delta check is blind to exec dirs, so the pull is never refused).
    // Residual (a remote whole-exec-dir deletion no longer auto-propagates) matches F#3's
    // whole-dir gap and the general exec-dir opt-in-only design -- acceptable.
    if (!allow.has(dir) || currentRepo.has(dir) || CONFIRM_REQUIRED_DIRS.includes(dir.toLowerCase())) continue;
    const localDir = path.join(CLAUDE_HOME, dir);
    if (!fs.existsSync(localDir)) continue;
    for (const rel of listFilesAtRef(baseCommit, `user-config/${dir}`)) {
      const p = path.join(localDir, rel);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); changes.push(`${dir}/${rel} (deleted)`); }
    }
  }
}

// Import user-config dirs from the repo into ~/.claude.
//   options.excludeDirs : dir names to skip entirely (B-02: pull() passes the
//                         CONFIRM_REQUIRED_DIRS so executable content is
//                         deferred, not written here).
//   options.onlyDirs    : if set, import ONLY these dirs (applyPendingDirs()
//                         passes the user-confirmed executable dirs). When set,
//                         CLAUDE.md is left untouched — it belongs to the main
//                         import pass, not the deferred-apply pass.
//   options.baseCommit  : F#4 -- the pull's last-sync base, used to prune dirs the
//                         remote deleted wholesale. Absent on the deferred-apply
//                         (onlyDirs) path, so that pass never prunes.
function importUserConfig(options = {}) {
  const { excludeDirs = [], onlyDirs = null, baseCommit = null } = options;
  const changes = [];
  let dirs = getSyncDirsForImport();
  if (onlyDirs) {
    // onlyDirs matches EXACTLY (never case-folded): it comes from the
    // pending-apply state, whose names are the canonical lowercase
    // CONFIRM_REQUIRED_DIRS. A folded match here could let a spoofed 'Hooks'
    // ride an applyPendingDirs(['hooks']) call.
    const only = new Set(onlyDirs);
    dirs = dirs.filter(d => only.has(d));
  } else if (excludeDirs.length) {
    // excludeDirs matches case-FOLDED (fail closed): if a hooks-aliasing name
    // ever reached the import set, it must still be deferred, not written.
    const excl = new Set(excludeDirs.map(d => d.toLowerCase()));
    dirs = dirs.filter(d => !excl.has(d.toLowerCase()));
  }
  for (const dir of dirs) {
    const src = path.join(REPO_DIR, 'user-config', dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(CLAUDE_HOME, dir);
    // Mirror sync: remove stale files in destination that don't exist in
    // source, and only copy entries whose content actually differs (A-02).
    for (const rel of syncDirReportChanges(src, dest)) {
      changes.push(`${dir}/${rel}`);
    }
  }
  if (onlyDirs) return changes;
  // F#4: after the main import, prune dirs the remote deleted wholesale. Skipped
  // on the onlyDirs (deferred-apply) path above, and skipped when baseCommit is
  // null (first pull) inside the helper.
  pruneRemotelyDeletedUserDirs(baseCommit, changes);
  const claudeMdSrc = path.join(REPO_DIR, 'user-config', 'CLAUDE.md');
  if (isRepoSymlink(claudeMdSrc)) {
    // F#1 review (CRITICAL): a symlinked repo CLAUDE.md would follow the link
    // and copy the TARGET's content into ~/.claude/CLAUDE.md (then push it) --
    // arbitrary local-file exfiltration via a malicious remote. Refuse it:
    // warn and skip the import entirely (don't read, don't copy).
    console.warn(`[claude-sync] refusing to import symlinked repo file (possible attack): ${claudeMdSrc}`);
  } else if (fs.existsSync(claudeMdSrc)) {
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
  // A-03: importPluginData needs baseCommit to compute its base-aware
  // deletion set, so it gets the full options object (same as importSettings
  // / importPluginConfigs above).
  const pluginDataResult = importPluginData(options);
  // B-02: pull() passes excludeUserDirs = CONFIRM_REQUIRED_DIRS so executable
  // dirs are deferred here and applied later via applyPendingDirs(). Default
  // (no option) imports everything, preserving importAll's original contract.
  // F#4: thread the pull's baseCommit through so importUserConfig can prune
  // dirs the remote deleted wholesale (skipped when baseCommit is null).
  const configChanges = importUserConfig({ excludeDirs: options.excludeUserDirs || [], baseCommit: options.baseCommit || null });
  // Preserve the legacy `pluginChanges` field (array of files), and surface
  // any conflicts collected during the JSON merges.
  const pluginChanges = pluginConfigsResult.changes;
  const mergeConflicts = [
    ...(settingsResult.conflicts || []),
    ...pluginConfigsResult.conflicts.map(c => ({ ...c, source: c.file })),
  ];
  return {
    settingsResult,
    pluginChanges,
    pluginDataChanges: pluginDataResult.changes,
    configChanges,
    mergeConflicts,
    // A-03: notes about conservative fallbacks (e.g. plugin-data deletions
    // skipped because no base commit was available) -- surfaced instead of
    // thrown, so callers can show the user a heads-up without pull() failing.
    warnings: pluginDataResult.warnings,
  };
}

// Returns the install-ready identifiers of plugins whose installPath is gone.
// The keys of installed_plugins.json's `plugins` object are already in
// `plugin@marketplace` form (e.g. "superpowers@claude-plugins-official"), which
// is exactly the argument `claude plugin install <arg>` expects -- callers pass
// each returned string VERBATIM, they must NOT append a marketplace themselves.
function detectMissingPlugins() {
  const installedPath = path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return [];
  // C-04: AUXILIARY -- installed_plugins.json is operational metadata, not
  // something we merge/push. Corruption falls back to {} (== "nothing
  // installed") instead of crashing; this function returns a plain array
  // (external callers, e.g. commands/sync-pull.md, treat it as one), so
  // there's no result-object `warnings` channel to thread through -- log via
  // console.warn instead of inventing a new sink.
  const warnings = [];
  const data = readJsonFile(installedPath, { fallback: {}, warnings });
  for (const w of warnings) console.warn(`claude-sync: ${w}`);
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
  // C-04: AUXILIARY, same reasoning as detectMissingPlugins() above.
  const warnings = [];
  const data = readJsonFile(mpPath, { fallback: {}, warnings });
  for (const w of warnings) console.warn(`claude-sync: ${w}`);
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
  'global/plugins.lock.json',
];

function safeMergeBase() {
  try {
    return gitExecFile(['merge-base', 'HEAD', `origin/${getBranch()}`]);
  } catch {
    throw new Error(
      '無法計算合併基準（本地與遠端沒有共同歷史）。\n' +
      '這通常表示遠端 repo 被重建過。\n' +
      '建議：執行 /sync-uninstall 後重新 /sync-init。'
    );
  }
}

function performSmartMerge(preference, fallbackStrategy) {
  const branch = getBranch();
  const remoteRef = `origin/${branch}`;
  const base = safeMergeBase();
  const allConflicts = [];
  // C-04: previously collected per-file JSON-parse failures so the merge
  // could continue past a corrupt file; that site now throws instead (see
  // below), so this stays empty. Kept in the return shape for compatibility
  // in case a future non-parse merge warning needs it.
  const mergeWarnings = [];
  const mergedFiles = {};
  for (const file of MERGE_JSON_FILES) {
    const b = safeGitShow(base, file);
    const l = safeGitShow('HEAD', file);
    const r = safeGitShow(remoteRef, file);
    if (b != null && l != null && r != null) {
      // C-04: base/local/remote are SOURCE content for a 3-way merge -- a
      // corrupt side must ABORT the merge, not be silently skipped. Skipping
      // (the old behaviour) would leave the file at whatever git's raw
      // textual merge produced -- possibly unresolved <<<<<<< conflict
      // markers -- and push() would push that as-is.
      let baseJson, localJson, remoteJson;
      try {
        baseJson = JSON.parse(b);
        localJson = JSON.parse(l);
        remoteJson = JSON.parse(r);
      } catch {
        throw new Error(`Malformed JSON in ${file} during merge (base/local/remote) -- fix it and retry.`);
      }
      const m = mergeJsonFields(baseJson, localJson, remoteJson, preference);
      mergedFiles[file] = m.result;
      allConflicts.push(...m.conflicts);
    }
  }

  // Git merge for non-JSON files
  try {
    gitExecFile(['merge', remoteRef, '--no-edit']);
  } catch (mergeErr) {
    // The first merge can fail for reasons other than a conflict (untracked
    // files would be overwritten, dirty/odd repo state). In those cases no
    // merge is in progress and `merge --abort` would throw and mask the real
    // error, so ignore an abort failure.
    try { gitExecFile(['merge', '--abort']); } catch {}
    try {
      gitExecFile(['merge', remoteRef, '--no-edit', '-X', fallbackStrategy]);
    } catch (fallbackErr) {
      // Fallback merge also failed — the sync repo needs manual attention.
      // Surface git's own stderr (execFileSync puts it on .stderr, not in
      // .message) so the user can see why.
      const gitSaid = (fallbackErr.stderr && fallbackErr.stderr.toString().trim())
        || fallbackErr.message;
      throw new Error(
        'Automatic merge of the sync repo failed and could not be resolved with -X '
        + fallbackStrategy + '. The sync repo may need manual repair '
        + '(~/.claude/sync/repo). git said: ' + gitSaid
      );
    }
  }

  // Overwrite JSON files with field-level merge results
  let needsFixup = false;
  for (const [file, merged] of Object.entries(mergedFiles)) {
    const filePath = path.join(REPO_DIR, file);
    const content = JSON.stringify(merged, null, 2);
    if (fs.readFileSync(filePath, 'utf8') !== content) {
      unlinkIfSymlink(filePath); // F#9: never write THROUGH a planted symlink
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

// D-04: set a value at a dot-path (e.g. "env.API_KEY"), creating/replacing
// any missing/non-object intermediate segments. Used by resolvePushConflicts
// to apply chosen values keyed by the dot-paths mergeJsonFields reports for
// nested-object conflicts.
function setByPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
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

// C-01: `ref` defaults to origin/<branch> (fetched-but-not-pulled remote
// state) rather than REPO_DIR's working tree (= local clone's HEAD as of the
// last pull/push). No internal call site needs the old HEAD-comparing
// behaviour -- pass ref='HEAD' explicitly if that ever changes.
// C-02: null (the actual default) is resolved to origin/${getBranch()} here
// rather than baked into the parameter default, since the branch name isn't
// known until config.json is read at call time.
function diffSettings(ref = null) {
  ref = ref || `origin/${getBranch()}`;
  const remoteRaw = safeGitShow(ref, 'global/settings.json');
  if (remoteRaw == null) return [];
  const localPath = path.join(CLAUDE_HOME, 'settings.json');
  // C-04: DIFF preview reads both sides -- fail fast, name the file, rather
  // than surfacing a raw SyntaxError or (worse) a false empty-object diff.
  const local = readJsonFile(localPath, { required: true, fallback: {} });
  // A-04: repo-side settings.json holds ${CLAUDE_HOME} placeholders -- transform
  // back before comparing, matching diffPluginConfigs, or every machine sees a
  // permanent false diff.
  // remoteRaw comes from `git show`, not a filesystem path, so readJsonFile
  // (which reads via fs) doesn't apply here -- guard the parse directly.
  let remoteParsed;
  try {
    remoteParsed = JSON.parse(remoteRaw);
  } catch {
    throw new Error(`Malformed JSON in ${ref}:global/settings.json -- can't diff, fix it and retry.`);
  }
  const remote = transformPathsForImport(remoteParsed);
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

// C-01: see diffSettings() above -- `ref` defaults to origin/<branch>.
function diffPluginConfigs(ref = null) {
  ref = ref || `origin/${getBranch()}`;
  const diffs = [];
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const remoteRaw = safeGitShow(ref, `global/${file}`);
    if (remoteRaw == null) continue;
    // C-04: remoteRaw comes from `git show`, not a filesystem path -- guard
    // the parse directly (readJsonFile reads via fs, so it doesn't apply).
    let remoteParsed;
    try {
      remoteParsed = JSON.parse(remoteRaw);
    } catch {
      throw new Error(`Malformed JSON in ${ref}:global/${file} -- can't diff, fix it and retry.`);
    }
    const remote = transformPathsForImport(remoteParsed);
    const localPath = path.join(CLAUDE_HOME, 'plugins', file);
    // C-04: DIFF preview -- fail fast on the local side too.
    const local = readJsonFile(localPath, { required: true, fallback: {} });
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
    if (entry.isSymbolicLink()) {
      // C-09: symlinks are never synced -- omit them from the listing so
      // diff/export/import all agree a symlink doesn't exist for sync
      // purposes.
      console.warn(`[claude-sync] skipping symlink (not synced): ${path.join(dir, entry.name)}`);
      continue;
    }
    if (IGNORED_FILES.has(entry.name)) continue;
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

// C-01: see diffSettings() above -- `ref` defaults to origin/<branch>. The
// repo side is read via listFilesAtRef()/safeGitShow() at `ref` instead of
// walking REPO_DIR's working tree.
function diffUserConfig(ref = null) {
  ref = ref || `origin/${getBranch()}`;
  const diffs = [];
  // Diff covers the union of dirs that exist on either side, so the user
  // sees newly-added remote dirs they may want to allow as well as local
  // dirs that haven't been pushed yet. The remote side is discovered from
  // the ref (C-01 review fix) -- getSyncDirsForImport() scans REPO_DIR's
  // working tree, which cannot see a brand-new dir that has been fetched
  // but not pulled. skipSyncDirs filtering is preserved so skipped dirs
  // stay out of the diff, exactly as getSyncDirsForImport() filtered them.
  const skip = new Set((loadConfig() || {}).skipSyncDirs || []);
  const dirs = new Set([
    ...getSyncDirsForExport(),
    ...[...listDirsAtRef(ref, 'user-config')].filter(d => !skip.has(d)),
  ]);
  for (const dir of dirs) {
    const repoPrefix = `user-config/${dir}`;
    const localDir = path.join(CLAUDE_HOME, dir);
    const repoFiles = listFilesAtRef(ref, repoPrefix);
    const localFiles = listFilesRecursive(localDir);
    const allFiles = new Set([...repoFiles, ...localFiles]);
    for (const file of allFiles) {
      const inRepo = repoFiles.has(file);
      const inLocal = localFiles.has(file);
      if (inRepo && inLocal) {
        // C-09: compare as raw bytes, not utf8 strings -- two different
        // binary files (e.g. images under skills/) can both decode to the
        // same invalid-utf8 replacement sequence and falsely compare equal.
        const repoBuf = safeGitShowBuffer(ref, `${repoPrefix}/${file}`);
        const localBuf = fs.readFileSync(path.join(localDir, file));
        if (repoBuf == null || !repoBuf.equals(localBuf)) {
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

// C-01: see diffSettings() above -- `ref` defaults to origin/<branch>.
function diffPluginData(ref = null) {
  ref = ref || `origin/${getBranch()}`;
  const repoPrefix = 'global/plugin-data';
  const localDir = path.join(CLAUDE_HOME, 'plugins');
  const repoPaths = listFilesAtRef(ref, repoPrefix);
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
      // C-09: see diffUserConfig() above -- Buffer compare, not utf8.
      const repoBuf = safeGitShowBuffer(ref, `${repoPrefix}/${file}`);
      const localBuf = fs.readFileSync(path.join(localDir, file));
      if (repoBuf == null || !repoBuf.equals(localBuf)) {
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

// Read-only-from-the-caller's-view local-change probe. push()/pull() aside,
// several callers (getStatus, the session-end best-effort check) want to know
// "does local ~/.claude differ from the repo?" without (a) racing a concurrent
// push/pull, or (b) leaving the working tree dirty. This takes the sync lock
// (so it can't interleave with push's add/commit), exports into the working
// tree, checks, then in a finally reverts tracked changes AND removes ONLY the
// untracked files the export created — a SCOPED clean, never a blanket
// `clean -fd`, which would also delete an interrupted operation's artifacts
// (e.g. a half-finished merge). Returns { localChanges, busy }.
function computeLocalChanges() {
  if (!acquireLock()) return { localChanges: false, busy: true };
  try {
    exportAll();
    return { localChanges: hasLocalChanges(), busy: false };
  } finally {
    try { gitExecFile(['checkout', '--', '.']); } catch {}
    // Scoped clean: only the dirs exportAll() writes to. Do NOT drop the
    // pathspec — a bare `clean -fd` would nuke unrelated untracked state.
    try { gitExecFile(['clean', '-fd', '--', 'global', 'plugin-data', 'user-config']); } catch {}
    releaseLock();
  }
}

function getStatus() {
  if (!isInitialized()) return { initialized: false };
  const config = loadConfig();
  const warnings = [];
  const lastSync = loadLastSync(warnings);
  const fetched = gitFetch(5000);
  let remoteUpdates = 0;
  let localChanges = false;
  if (fetched) {
    try {
      remoteUpdates = hasRemoteUpdates() ? getRemoteUpdateCount() : 0;
    } catch { remoteUpdates = -1; }
  }
  try {
    const probe = computeLocalChanges();
    localChanges = probe.localChanges;
    if (probe.busy) warnings.push('sync in progress; local-change check skipped');
  } catch (err) {
    // exportAll() fails fast on a corrupt local settings.json (C-04). getStatus
    // is read-only and must still render — downgrade to a warning.
    warnings.push(`could not compute local changes: ${err.message}`);
  }
  // Phase 1A: drift between the last-committed lock and what's installed
  // locally right now. Never let this fail getStatus().
  let pluginDrift = [];
  try {
    pluginDrift = getPluginLockDrift('HEAD');
  } catch (err) {
    warnings.push(`could not compute plugin drift: ${err.message}`);
  }
  return {
    initialized: true,
    repoUrl: config?.repo || 'unknown',
    lastSync: lastSync.timestamp || 'never',
    remoteUpdates,
    localChanges,
    fetchFailed: !fetched,
    warnings,
    pluginDrift,
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

// C-02: after clone, determine the remote's actual default branch instead of
// assuming 'main'. An existing remote may have been created with a different
// default (e.g. `git init --initial-branch=master`, or an old git version's
// 'master' default) -- pushing/fetching 'main' against such a remote fails
// outright. `git symbolic-ref` reads the ref `git clone` sets up to track the
// remote's advertised HEAD (e.g. "origin/master" -- the "origin/" prefix is
// stripped below). A brand-new EMPTY remote has no HEAD to advertise, so this
// throws; the fallback then mirrors what `git init`/`git clone` would pick
// locally on this machine: the user's configured `init.defaultBranch`, or
// 'main' if that isn't set either.
function detectBranch() {
  try {
    const ref = gitExecFile(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
    return ref.replace(/^origin\//, '');
  } catch {
    try {
      const configured = execFileSync(
        'git', ['config', '--global', 'init.defaultBranch'], { stdio: 'pipe' },
      ).toString().trim();
      return configured || 'main';
    } catch {
      return 'main';
    }
  }
}

function init(remoteUrl) {
  if (isInitialized()) throw new Error('Already initialized. Run /sync-uninstall first.');
  validateRemoteUrl(remoteUrl);
  // LOCK_PATH lives inside SYNC_DIR, so SYNC_DIR must exist before we can take
  // the lock. Create it first (idempotent), then serialize against every other
  // sync operation. Holding the lock is what makes the REPO_DIR residue cleanup
  // below safe: without it, a concurrent init/push/pull could be mid-clone in
  // REPO_DIR when we rmSync it. (C-02 review)
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  if (!acquireLock()) throw lockBusyError();
  try {
    // C-02: a previous init() that failed after clone but before saveConfig()
    // leaves REPO_DIR on disk with no CONFIG_PATH next to it. isInitialized()
    // correctly reads that as "not initialized" (so a retry is allowed), but a
    // plain `git clone` into REPO_DIR then fails because the destination path
    // already exists -- wedging every retry until the user manually `rm -rf`s
    // it. Clear that stale residue before cloning.
    if (fs.existsSync(REPO_DIR) && !fs.existsSync(CONFIG_PATH)) {
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
    }
    // '--' stops git from treating remoteUrl as an option; execFileSync means no
    // shell ever sees it (B-01).
    execFileSync('git', ['clone', '--', remoteUrl, REPO_DIR], { timeout: 60000, stdio: 'pipe' });
    try {
      ensureGitIdentity();
      const branch = detectBranch();
      const hasContent = fs.existsSync(path.join(REPO_DIR, 'global'));
      if (!hasContent) {
        // Empty repo — push our local state as the initial sync. Force the
        // local branch name to match `branch` first: after cloning a brand-new
        // empty remote, git's own local default (independent of the fallback
        // logic in detectBranch() above, and possibly different from it) may
        // name the branch something else, and pushing under the wrong local
        // name would create a second, unexpected branch on the remote instead
        // of updating the one future clones will look for.
        gitExecFile(['checkout', '-B', branch]);
        // D-01: only the fresh-init (empty-repo) path needs this -- an
        // already-initialized repo has its residual junk files cleaned up by
        // the export stale-sweep + IGNORED_FILES filter on the next push.
        const gitignorePath = path.join(REPO_DIR, '.gitignore');
        if (!fs.existsSync(gitignorePath)) {
          fs.writeFileSync(gitignorePath, [...IGNORED_FILES].join('\n') + '\n');
        }
        exportAll();
        gitExecFile(['add', '-A']);
        gitExecFile(['commit', '-m', 'Initial sync from first machine']);
        gitExecFile(['push', 'origin', branch]);
      }
      saveConfig({ repo: remoteUrl, branch, autoPull: false, autoPush: false });
      // Track the commit we synced against so future pulls can do real 3-way
      // merges. firstPullPending=true tells pull() that ~/.claude is not yet
      // a faithful copy of base — the next pull should overlay remote rather
      // than try to merge.
      const commitHash = gitExecFile(['rev-parse', 'HEAD']);
      saveLastSync({ action: 'init', commitHash, firstPullPending: hasContent });
      return { hasContent, repoUrl: remoteUrl, branch };
    } catch (err) {
      // C-02: clone succeeded but a later step failed (bad git identity,
      // network drop during the initial push, an unwritable remote, ...) --
      // saveConfig() never ran, so isInitialized() still reads false. Remove
      // the half-initialized REPO_DIR so the NEXT init() attempt (same or a
      // different remote) can clone cleanly instead of failing on "destination
      // path already exists".
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
      throw err;
    }
  } finally {
    releaseLock();
  }
}

// B-04: heuristic scan for likely secrets so push() can WARN (never block)
// before sending settings.json to a git remote. Checks env-var NAMES against a
// keyword pattern and string VALUES against common secret prefixes. Returns
// [{ path, reason }] (path like "env.OPENAI_API_KEY"). Heuristic by design:
// false negatives are acceptable (worst case = today's silent behavior), and it
// never blocks a push.
const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
const SECRET_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9]/,          // OpenAI / Anthropic-style keys
  /^ghp_[A-Za-z0-9]/,         // GitHub personal access token
  /^gh[ousr]_[A-Za-z0-9]/,    // other GitHub tokens
  /^xox[baprs]-/,             // Slack tokens
  /^AKIA[0-9A-Z]{16}/,        // AWS access key id
  /^AIza[0-9A-Za-z_-]{35}/,   // Google API key
];
function scanForSecrets(settingsObj) {
  const found = [];
  const env = settingsObj && settingsObj.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) {
      const nameHit = SECRET_KEY_PATTERN.test(k);
      const valHit = typeof v === 'string' && SECRET_VALUE_PATTERNS.some(re => re.test(v));
      if (nameHit || valHit) {
        found.push({
          path: `env.${k}`,
          reason: nameHit ? 'name matches a secret keyword' : 'value looks like a secret token',
        });
      }
    }
  }
  return found;
}

function push(options = {}) {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw lockBusyError();
  try {
    const exportResult = exportAll();
    if (!hasLocalChanges()) {
      return { pushed: false, reason: 'no-changes' };
    }
    // F#7: scan for likely secrets BEFORE committing/pushing. Secrets ARE
    // allowed to sync (e.g. a private repo), but only with an explicit
    // confirmSecrets -- a warning that arrives after the key is already in
    // remote history is too late. Without confirmation, STOP here having
    // pushed nothing. fallback:{} is safe here since exportAll() above
    // already required settings.json to parse cleanly; this is just
    // re-reading the known-good local file (pre A-04 path transform, so
    // values are intact).
    const localSettings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), { fallback: {} });
    const secretWarnings = scanForSecrets(localSettings);
    if (secretWarnings.length > 0 && !options.confirmSecrets) {
      return { pushed: false, reason: 'secrets-detected', secretWarnings };
    }
    gitExecFile(['add', '-A']);
    const hostname = require('os').hostname();
    gitExecFile(['commit', '-m', `sync from ${hostname} at ${new Date().toISOString()}`]);
    const branch = getBranch();
    let mergeResult = {};
    try {
      gitExecFile(['push', 'origin', branch]);
    } catch {
      gitExecFile(['fetch', 'origin', branch]);
      mergeResult = performSmartMerge('local', 'ours');
      gitExecFile(['push', 'origin', branch]);
    }
    // After a successful push, ~/.claude is the source of truth for the
    // new commit; clear firstPullPending if it was lingering from init.
    saveLastSync({ action: 'push', commitHash: gitExecFile(['rev-parse', 'HEAD']), firstPullPending: false });
    // Still surface the (confirmed) secret warnings on success, informationally.
    return { pushed: true, ...mergeResult, secretWarnings, unlockable: exportResult?.unlockable || [] };
  } finally {
    releaseLock();
  }
}

// D-04: apply the user's chosen values for push-time field conflicts to the
// repo's settings.json, commit, push, AND advance last-sync so the next
// status/preview doesn't falsely see "remote has updates". `overrides` is
// { <dotPath>: <value> } keyed by the conflict `key` reported in
// push().mergeConflicts (dot-paths for nested fields, e.g. "env.API_KEY").
// Values are written in the repo's canonical form -- mergeConflicts already
// reports local/remote values in that form (they come from `git show` of the
// repo content), so no path transform is applied here. Runs under the sync lock.
function resolvePushConflicts(overrides) {
  if (!acquireLock()) throw lockBusyError();
  try {
    const fp = path.join(REPO_DIR, 'global', 'settings.json');
    const data = readJsonFile(fp, { required: true, fallback: {} });
    for (const [dotPath, value] of Object.entries(overrides)) {
      setByPath(data, dotPath, value);
    }
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    if (!hasLocalChanges()) {
      // Chosen values already match what was pushed -- nothing to do (avoid an
      // empty commit). last-sync is already correct from the original push().
      return { pushed: false, reason: 'no-changes' };
    }
    gitExecFile(['add', '-A']);
    gitExecFile(['commit', '-m', 'resolve merge conflicts']);
    gitExecFile(['push', 'origin', getBranch()]);
    const commitHash = gitExecFile(['rev-parse', 'HEAD']);
    saveLastSync({ action: 'push', commitHash, firstPullPending: false });
    return { pushed: true, commitHash };
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
    userConfigFiles: [],// user-config files (commands/, agents/, ...) differing
  };
  // Fix 2a (B-02 review): while a deferred confirmation is pending, the
  // last pull already applied all NON-exec content from the stashed commit
  // but did NOT advance last-sync. Comparing against the older last-sync
  // base would misread that applied content as unpushed local divergence
  // and wedge every subsequent safe pull on 'local-changes-pending'. The
  // stash's commitHash is the commit ~/.claude's non-exec content actually
  // reflects, so it is the correct divergence base.
  const pending = loadPendingApply();
  if (pending?.pendingLastSync?.commitHash) {
    baseCommit = pending.pendingLastSync.commitHash;
  }
  if (!baseCommit) return delta;

  // settings.json
  // A-04: base-side settings.json holds ${CLAUDE_HOME} placeholders -- transform
  // back before comparing to local, matching the plugin-config check below,
  // or every machine sees a permanent false "local diverged" delta.
  const baseSettingsRaw = readJsonAtRef(baseCommit, 'global/settings.json');
  const baseSettings = baseSettingsRaw ? transformPathsForImport(baseSettingsRaw) : {};
  const localSettingsPath = path.join(CLAUDE_HOME, 'settings.json');
  // C-04: this delta decides whether push()/pull() treat local as diverged --
  // a corrupt local settings.json must fail fast, not silently read as "every
  // field was deleted locally".
  const localSettings = readJsonFile(localSettingsPath, { required: true, fallback: {} });
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
    // C-04: same reasoning as localSettings above -- SOURCE, fail fast.
    const local = readJsonFile(localPath, { required: true, fallback: {} });
    if (JSON.stringify(base) !== JSON.stringify(local)) {
      delta.pluginConfigs.push(file);
    }
  }

  // User-config files. Fix 2b (B-02 review): CONFIRM_REQUIRED_DIRS are
  // skipped entirely — pull's main pass never writes them, so they need no
  // pull-safety delta protection, and the content-based
  // computePendingConfirmation() re-offers any repo/local difference there
  // regardless. Including them would wedge safe pulls whenever a deferred
  // (or user-declined) exec-dir change leaves local ≠ base.
  for (const dir of getSyncDirsForExport()) {
    if (CONFIRM_REQUIRED_DIRS.includes(dir.toLowerCase())) continue;
    const localDir = path.join(CLAUDE_HOME, dir);
    // Keep the dir-level existsSync guard (B-03 opt-in re-pull safety): after
    // addAllowSyncDir('newdir') + re-pull, `newdir` is in the base tree but has
    // never been materialized locally. The FS cannot cheaply tell that apart
    // from "user deleted the whole local dir", so skip both -- unioning base
    // files here would misread the not-yet-materialized dir as a local deletion
    // and wedge the documented opt-in re-pull on 'local-changes-pending'. The
    // residual gap (a whole-local-dir deletion goes undetected) matches
    // pre-existing behaviour and is acceptable; the F#3 bug (a single file
    // deleted from a dir that still exists) is fixed by the union walk below.
    if (!fs.existsSync(localDir)) continue;
    const localFiles = listFilesRecursive(localDir);
    // F#3: also walk the BASE side so a LOCAL DELETION (in base, gone locally) is
    // seen as divergence -- otherwise safe pull silently re-imports/restores it.
    const baseFiles = listFilesAtRef(baseCommit, `user-config/${dir}`);
    for (const file of new Set([...localFiles, ...baseFiles])) {
      const repoRel = `user-config/${dir}/${file}`;
      // C-09: see diffUserConfig() above -- Buffer compare, not utf8.
      const baseBuf = safeGitShowBuffer(baseCommit, repoRel);
      const localPath = path.join(localDir, file);
      const localBuf = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
      const inBase = baseBuf != null, inLocal = localBuf != null;
      if (inBase !== inLocal || (inBase && inLocal && !baseBuf.equals(localBuf))) {
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
  // C-04: last-sync.json is AUXILIARY -- surface a corrupt/missing base as a
  // warning instead of crashing this read-only preview.
  const warnings = [];
  const lastSync = loadLastSync(warnings);
  const remoteHead = gitExecFile(['rev-parse', `origin/${getBranch()}`]);
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

  // Phase 1A: drift between the REMOTE lock (what a future pin-apply would
  // set) and what's installed locally right now. Never let this fail preview.
  let pluginDrift = [];
  try {
    pluginDrift = getPluginLockDrift(`origin/${getBranch()}`);
  } catch (err) {
    warnings.push(`could not compute plugin drift: ${err.message}`);
  }

  return {
    ok: true,
    recommendation,
    base,
    remoteHead,
    remoteHasUpdates,
    firstPull,
    localDelta,
    warnings,
    pluginDrift,
  };
}

// ---------------------------------------------------------------------------
// B-02: two-stage confirmation for executable dirs
// ---------------------------------------------------------------------------

function loadPendingApply() {
  if (!fs.existsSync(PENDING_APPLY_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PENDING_APPLY_PATH, 'utf8')); } catch { return null; }
}

function savePendingApply(data) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(PENDING_APPLY_PATH, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
}

function clearPendingApply() {
  try { fs.rmSync(PENDING_APPLY_PATH, { force: true }); } catch {}
}

// Preview which CONFIRM_REQUIRED_DIRS a pull would change, WITHOUT writing
// anything. Only considers dirs that are importable (present in the repo AND
// in the local allow set — a skipped or repo-absent executable dir is neither
// imported nor offered). Compares the repo working tree (already reset to
// origin/<branch> by pull()) against ~/.claude. Returns
// [{ dir, changes: [...relative paths...] }] for dirs with actual changes;
// [] when nothing executable changed.
function computePendingConfirmation() {
  const importable = new Set(getSyncDirsForImport());
  const pending = [];
  for (const dir of CONFIRM_REQUIRED_DIRS) {
    if (!importable.has(dir)) continue;
    const src = path.join(REPO_DIR, 'user-config', dir);
    const dest = path.join(CLAUDE_HOME, dir);
    const changes = computeDirChanges(src, dest);
    if (changes.length > 0) pending.push({ dir, changes });
  }
  return pending;
}

// Perform a pull. By default (`mode: 'safe'`), refuses to proceed if local
// has diverged from the last-synced base — the user must explicitly pass
// `mode: 'merge'` (3-way merge with remote winning conflicts) or push first.
// On a fresh machine where firstPullPending=true the safe mode is "first
// pull" — overlay remote without trying to interpret missing local fields
// as deletions.
//
// B-02/B-03: pull() NEVER writes CONFIRM_REQUIRED_DIRS (hooks/skills/rules) or
// unknown (non-allow-listed) remote dirs into ~/.claude. Executable-dir
// changes are returned under `pendingConfirmation` and applied only via
// applyPendingDirs() after the user confirms; unknown remote dirs are returned
// under `unknownRemoteDirs` for the skill to prompt add/skip. When anything is
// deferred, last-sync is NOT advanced here — the payload is stashed in
// PENDING_APPLY_PATH and committed by applyPendingDirs().
function pull(options = {}) {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw lockBusyError();
  const mode = options.mode || 'safe';
  try {
    if (!gitFetch(30000)) throw new Error('Failed to fetch from remote. Check your network.');

    const branch = getBranch();
    const remoteRef = `origin/${branch}`;

    // Always start from a clean view of origin/<branch>. This wipes any
    // working tree pollution left over by older versions of pull().
    try { gitExecFile(['reset', '--hard', remoteRef]); } catch {}

    // C-04: last-sync.json is AUXILIARY -- a corrupt/missing base falls back
    // to {} (base=null below), which routes this pull through the safe
    // no-base overlay path (see importOptions branches below) instead of
    // crashing. pullWarnings surfaces that fallback to the caller instead of
    // losing it silently.
    const pullWarnings = [];
    const lastSync = loadLastSync(pullWarnings);
    const remoteHead = gitExecFile(['rev-parse', remoteRef]);
    const base = lastSync.commitHash || null;
    const firstPull = lastSync.firstPullPending === true;

    // B-03: remote dirs this machine hasn't opted into — never imported.
    const unknownRemoteDirs = getUnknownRemoteDirs();
    // Fix 1: repo dirs case-fold-colliding with reserved names — never
    // importable, surfaced so the skill can warn about a spoofing attempt.
    const suspiciousRemoteDirs = getSuspiciousRemoteDirs();

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
          // D-02: a refused pull imports nothing, so no backup is taken (which
          // is why createBackup() now runs past this return). Key kept for API
          // consistency; value is null.
          backupPath: null,
          localDelta,
          base,
          remoteHead,
          // API consistency: every pull() result carries these three fields.
          // pendingConfirmation is [] here because nothing was (re)computed
          // or deferred on this refused pull.
          pendingConfirmation: [],
          unknownRemoteDirs,
          suspiciousRemoteDirs,
          hint: 'Run /sync-push first, or call pull({ mode: "merge" }) to merge with remote winning on conflicts.',
          warnings: pullWarnings,
        };
      }
      importOptions = { baseCommit: base, forceRemote: false };
      modeUsed = localDirty ? 'merge' : 'fast-forward';
    }

    // B-02: preview executable-dir changes BEFORE importing, then import
    // everything EXCEPT those dirs. computePendingConfirmation reads the repo
    // working tree (reset to origin/<branch> above) read-only, so the
    // preview and the exclusion see the same source.
    // D-02: back up ~/.claude only now — past the safe-mode refusal return, so
    // a refused pull (which changes nothing) never burns a backup slot. This
    // point is reached by the first-pull and merge/fast-forward paths, i.e.
    // every pull that actually imports. createBackup() copies ~/.claude, which
    // is independent of the `reset --hard` above (that only touches REPO_DIR).
    const backupPath = createBackup();

    const pendingConfirmation = computePendingConfirmation();

    const result = importAll({ ...importOptions, excludeUserDirs: CONFIRM_REQUIRED_DIRS });
    const missingPlugins = detectMissingPlugins();

    // last-sync payload to record once ~/.claude fully reflects remoteHead.
    const pendingLastSync = { action: 'pull', commitHash: remoteHead, firstPullPending: false };
    if (pendingConfirmation.length > 0) {
      // Executable content is deferred — do NOT advance last-sync yet. Stash
      // the payload so applyPendingDirs()/discardPendingDirs() (even in a later
      // session) can finalize without re-deriving it. createBackup ran above,
      // after the safe-mode refusal check; applyPendingDirs does NOT re-backup.
      savePendingApply({ pendingLastSync, dirs: pendingConfirmation.map(p => p.dir) });
    } else {
      // Nothing deferred: finalize immediately and clear any stale pending
      // state left by an abandoned earlier pull.
      saveLastSync(pendingLastSync);
      clearPendingApply();
    }

    const nothingChanged = !result.settingsResult?.changed
      && (result.pluginChanges || []).length === 0
      && (result.pluginDataChanges || []).length === 0
      && (result.configChanges || []).length === 0
      && pendingConfirmation.length === 0
      && unknownRemoteDirs.length === 0
      && suspiciousRemoteDirs.length === 0;
    // C-04: merge last-sync's own warnings (if any) with importAll's
    // (currently only plugin-data's missing-base-commit note) into one list.
    // Placed after the `...result` spread so it wins over result.warnings.
    const warnings = [...pullWarnings, ...(result.warnings || [])];
    if (nothingChanged) {
      return { pulled: false, reason: 'up-to-date', backupPath, ...result, missingPlugins, mode: modeUsed, pendingConfirmation, unknownRemoteDirs, suspiciousRemoteDirs, warnings };
    }
    return { pulled: true, backupPath, ...result, missingPlugins, mode: modeUsed, pendingConfirmation, unknownRemoteDirs, suspiciousRemoteDirs, warnings };
  } finally {
    releaseLock();
  }
}

// B-02 stage two: apply the executable dirs the user confirmed after reviewing
// pull()'s `pendingConfirmation`. `dirs` is the subset of pending dir names to
// write (e.g. ['hooks']); anything not in the stashed pending set is ignored.
// Writes the confirmed dirs into ~/.claude, then commits the last-sync payload
// stashed by pull() and updates the pending state. Does NOT re-backup — pull()
// already took one. Resets the repo to the confirmed commit first so it applies
// exactly what was reviewed even if something touched the working tree since;
// if that reset fails, the apply ABORTS before writing anything (the
// "applies exactly what was reviewed" guarantee is hard).
//
// Fix 3 (partial apply): dirs NOT applied this call stay pending — the state
// file is rewritten with the remaining dirs (same commitHash) and only deleted
// when none remain. Remaining dirs are re-offered on the next pull, and the
// pending-aware getLocalDelta() keeps them from reading as local divergence.
function applyPendingDirs(dirs) {
  if (!isInitialized()) throw new Error('Not initialized. Run /sync-init first.');
  if (!acquireLock()) throw lockBusyError();
  try {
    const state = loadPendingApply();               // F#5: now under the lock
    if (!state) return { applied: false, reason: 'no-pending' };
    const pendingSet = new Set(state.dirs || []);
    // F#6: an explicit [] means "apply none"; undefined/null means "apply all".
    const requested = Array.isArray(dirs) ? dirs : (state.dirs || []);
    const toApply = requested.filter(d => pendingSet.has(d));
    if (toApply.length === 0) {
      // Nothing to apply -> true no-op: leave pending state and last-sync
      // untouched. "Decline all" should call discardPendingDirs() instead.
      return { applied: true, dirs: [], remainingDirs: state.dirs || [], configChanges: [] };
    }
    const commitHash = state.pendingLastSync?.commitHash;
    if (commitHash) {
      try {
        gitExecFile(['reset', '--hard', commitHash]);
      } catch {
        throw new Error(
          `Cannot restore the sync repo to the reviewed commit ${commitHash}. ` +
          'Aborting without applying anything — run /sync-pull again to re-review.'
        );
      }
    }
    const configChanges = importUserConfig({ onlyDirs: toApply });
    if (state.pendingLastSync) saveLastSync(state.pendingLastSync);
    const applied = new Set(toApply);
    const remainingDirs = (state.dirs || []).filter(d => !applied.has(d));
    if (remainingDirs.length > 0) {
      savePendingApply({ pendingLastSync: state.pendingLastSync, dirs: remainingDirs });
    } else {
      clearPendingApply();
    }
    return { applied: true, dirs: toApply, remainingDirs, configChanges };
  } finally {
    releaseLock();
  }
}

// B-02 stage two (decline): drop ALL pending state WITHOUT applying and WITHOUT
// advancing last-sync. The repo clone still holds the executable content, but
// ~/.claude does not — because last-sync stays put, the next pull re-offers the
// same dirs under `pendingConfirmation`. NOTE for callers: declining means the
// LOCAL version of those dirs wins, so the next /sync-push will overwrite the
// remote's newer version of them — the skill must warn the user about this.
function discardPendingDirs() {
  if (!acquireLock()) throw lockBusyError();
  try {
    const state = loadPendingApply();
    clearPendingApply();
    return { discarded: true, dirs: state ? (state.dirs || []) : [] };
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
  CLAUDE_HOME, SYNC_DIR, REPO_DIR, CONFIG_PATH, LAST_SYNC_PATH, BACKUP_DIR,
  PENDING_APPLY_PATH, CONFIRM_REQUIRED_DIRS,
  // Git helpers
  gitExec, gitExecFile, validateRemoteUrl,
  gitFetch, hasRemoteUpdates, getRemoteUpdateCount, hasLocalChanges,
  // Config
  loadConfig, saveConfig, loadLastSync, saveLastSync, isInitialized, getBranch,
  // C-04
  readJsonFile,
  // F#1 review
  isRepoSymlink,
  // Sync-dir resolution
  getSyncDirsForExport, getSyncDirsForImport, getUnknownRemoteDirs,
  getSuspiciousRemoteDirs, isSuspiciousDirName, detectUnknownDirs,
  addAllowSyncDir, addSkipSyncDir,
  // Lock
  acquireLock, releaseLock,
  // Export
  exportSettings, exportPluginConfigs, exportPluginData, exportUserConfig, exportAll,
  exportPluginLock, pinPluginsEnabled, pinPluginsDecided, setPinPlugins, getPluginLockDrift,
  exportPluginVendorBundles, vendorMarketplaces, setVendorMarketplace,
  transformPathsForExport, transformPathsForImport, copyDirSync, removeStalePaths,
  syncDirReportChanges,
  // Phase 1B
  sanitizeMarketplaceName, preparePinnedClone, runPluginCli, applyPluginLock,
  // Phase 1C
  pinMarketplaceToCommit, migrateMarketplaceToPinned, reverseMigrateMarketplace, setPinnedRef,
  // Import + Backup
  createBackup, listBackups, restoreBackup,
  importSettings, importPluginConfigs, importPluginData, importUserConfig, importAll,
  detectMissingPlugins, detectMissingMarketplaces,
  // Smart Merge
  safeGitShow, safeGitShowBuffer, mergeJsonFields, readJsonAtRef, performSmartMerge,
  // Diff + Status
  diffSettings, diffPluginConfigs, diffUserConfig, diffPluginData,
  listFilesRecursive, listFilesAtRef, listDirsAtRef, getStatus, computeLocalChanges,
  getLocalDelta, isLocalDeltaEmpty, previewPull,
  computeDirChanges, computePendingConfirmation,
  loadPendingApply, savePendingApply, clearPendingApply,
  // Orchestrators
  init, push, pull, applyPendingDirs, discardPendingDirs, uninstall, detectBranch,
  // D-04
  resolvePushConflicts,
  // B-04
  scanForSecrets,
};
