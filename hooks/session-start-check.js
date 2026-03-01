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
