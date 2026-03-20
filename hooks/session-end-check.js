'use strict';

const path = require('path');
const fs = require('fs');

setTimeout(() => process.exit(0), 10000).unref(); // 10s safety timeout

const CONFIG_PATH = path.join(process.env.HOME, '.claude', 'sync', 'config.json');
const REPO_DIR = path.join(process.env.HOME, '.claude', 'sync', 'repo');

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
          process.stderr.write(`[claude-sync] \u26a0\ufe0f ${files} \u7121\u6cd5\u89e3\u6790\u70ba JSON\uff0c\u5df2\u8df3\u904e\u6b04\u4f4d\u5c64\u7d1a\u5408\u4f75\u3002\n`);
        }
        if (result.mergeConflicts && result.mergeConflicts.length > 0) {
          const keys = result.mergeConflicts.map(c => c.key).join(', ');
          process.stderr.write(`[claude-sync] \u26a0\ufe0f \u81ea\u52d5\u63a8\u9001\u5b8c\u6210\uff0c\u4f46\u6709 ${result.mergeConflicts.length} \u500b\u6b04\u4f4d\u885d\u7a81\uff08\u5df2\u4fdd\u7559\u672c\u5730\u7248\u672c\uff09\uff1a${keys}\n`);
        } else {
          process.stderr.write('[claude-sync] \u2705 \u5df2\u81ea\u52d5\u63a8\u9001\u8b8a\u66f4\u5230\u9060\u7aef\u3002\n');
        }
      }
    } catch (e) {
      process.stderr.write(`[claude-sync] \u26a0\ufe0f \u81ea\u52d5\u63a8\u9001\u5931\u6557\uff1a${e.message}\n`);
    }
  } else {
    // Best-effort check: export to see if there are local changes, then revert
    try {
      syncEngine.exportAll();
      const hasChanges = syncEngine.hasLocalChanges();
      try { syncEngine.gitExec('checkout -- .'); } catch {}
      if (hasChanges) {
        process.stderr.write('[claude-sync] \ud83d\udccc \u672c\u5730\u6709\u672a\u63a8\u9001\u7684\u8b8a\u66f4\u3002\u57f7\u884c /sync-push \u4f86\u540c\u6b65\u3002\n');
      }
    } catch {}
  }
} catch {
  process.exit(0);
}
