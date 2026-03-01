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
