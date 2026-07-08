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

  // A-05: judge divergence from the actual commit counts, not just a hash
  // mismatch -- HEAD != origin/main is also true when local is ahead
  // (unpushed commits) with nothing new on the remote, which must NOT be
  // reported as "遠端有 0 個更新".
  const behindCount = execSync('git rev-list HEAD..origin/main --count', { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();
  const aheadCount = execSync('git rev-list origin/main..HEAD --count', { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();

  const lines = [];
  if (Number(behindCount) > 0) {
    lines.push(`[claude-sync] 遠端有 ${behindCount} 個更新。執行 /sync-pull 來同步。`);
  }
  if (Number(aheadCount) > 0) {
    lines.push('[claude-sync] 本地有未推送的 commit，執行 /sync-push 來同步。');
  }
  if (lines.length > 0) {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: lines.join('\n'),
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
} catch {
  // Silent failure — never block Claude Code startup
  process.exit(0);
}
