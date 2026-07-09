'use strict';

// Does the actual session-end work: autoPush (or a best-effort local-changes
// check) via the sync engine. Spawned as a child process by
// hooks/session-end-check.js, which enforces a hard wall-clock timeout on
// this file so a slow/unreachable network can never block Claude Code
// shutdown. This file itself sets no timers -- the launcher owns that.

const path = require('path');
const os = require('os');
const fs = require('fs');

// F#8: match the launcher's (session-end-check.js) CLAUDE_SYNC_HOME-aware
// base so this preflight guard checks the same REPO_DIR/CONFIG_PATH the
// engine itself will use -- otherwise, under CLAUDE_SYNC_HOME, this guard
// checks the wrong path and exits before ever reaching the engine, silently
// skipping auto-push.
const CLAUDE_HOME = process.env.CLAUDE_SYNC_HOME || path.join(os.homedir(), '.claude');
const CONFIG_PATH = path.join(CLAUDE_HOME, 'sync', 'config.json');
const REPO_DIR = path.join(CLAUDE_HOME, 'sync', 'repo');

try {
  if (!fs.existsSync(REPO_DIR) || !fs.existsSync(CONFIG_PATH)) process.exit(0);

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const syncEngine = require(path.join(pluginRoot, 'lib', 'sync-engine.js'));
  const config = syncEngine.loadConfig() || {};

  if (config.autoPush) {
    // Auto-push: push() handles export + lock + commit + push internally
    try {
      const result = syncEngine.push();
      if (result.pushed) {
        if (result.mergeWarnings && result.mergeWarnings.length > 0) {
          const files = result.mergeWarnings.map(w => w.file).join(', ');
          process.stderr.write(`[claude-sync] ⚠️ ${files} 無法解析為 JSON，已跳過欄位層級合併。\n`);
        }
        if (result.mergeConflicts && result.mergeConflicts.length > 0) {
          const keys = result.mergeConflicts.map(c => c.key).join(', ');
          process.stderr.write(`[claude-sync] ⚠️ 自動推送完成，但有 ${result.mergeConflicts.length} 個欄位衝突（已保留本地版本）：${keys}\n`);
        } else {
          process.stderr.write('[claude-sync] ✅ 已自動推送變更到遠端。\n');
        }
      }
    } catch (e) {
      process.stderr.write(`[claude-sync] ⚠️ 自動推送失敗：${e.message}\n`);
    }
  } else {
    // Best-effort local-change check (read-only, under lock, scoped clean).
    try {
      const probe = syncEngine.computeLocalChanges();
      if (probe.localChanges) {
        process.stderr.write('[claude-sync] 📌 本地有未推送的變更。執行 /sync-push 來同步。\n');
      }
    } catch {}
  }
} catch {
  process.exit(0);
}
