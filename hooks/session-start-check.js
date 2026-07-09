'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_HOME = process.env.CLAUDE_SYNC_HOME || path.join(os.homedir(), '.claude');
const SYNC_REPO = path.join(CLAUDE_HOME, 'sync', 'repo');
const CONFIG_PATH = path.join(CLAUDE_HOME, 'sync', 'config.json');

// C-02: config.branch may be absent (installs from before branch detection)
// or, in principle, corrupted -- validate against a conservative charset
// before splicing it into a fixed-string execSync command below. This value
// comes from OUR OWN config.json (not user input), but the check keeps the
// string-concat here safe and simple rather than sharp.
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

try {
  // Exit silently if not initialized
  if (!fs.existsSync(SYNC_REPO) || !fs.existsSync(CONFIG_PATH)) process.exit(0);

  let branch = 'main';
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (config && typeof config.branch === 'string' && BRANCH_RE.test(config.branch)) {
      branch = config.branch;
    }
  } catch {}

  // Fetch with 5s timeout
  execSync(`git fetch origin ${branch}`, {
    cwd: SYNC_REPO,
    timeout: 5000,
    stdio: 'pipe',
  });

  // A-05: judge divergence from the actual commit counts, not just a hash
  // mismatch -- HEAD != origin/<branch> is also true when local is ahead
  // (unpushed commits) with nothing new on the remote, which must NOT be
  // reported as "遠端有 0 個更新".
  const behindCount = execSync(`git rev-list HEAD..origin/${branch} --count`, { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();
  const aheadCount = execSync(`git rev-list origin/${branch}..HEAD --count`, { cwd: SYNC_REPO, stdio: 'pipe' }).toString().trim();

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
