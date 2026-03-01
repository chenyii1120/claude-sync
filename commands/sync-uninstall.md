---
description: Remove claude-sync and clean up all local data
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`
- Config: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); const c = s.loadConfig(); console.log(JSON.stringify(c))"`

## Your Task

Help the user cleanly remove claude-sync.

1. Warn the user: "This will remove all local sync data (config, repo clone, backups)."
2. Ask for confirmation.
3. Run uninstall:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const result = s.uninstall();
     console.log(JSON.stringify(result));
   "
   ```
4. If repoUrl was returned, tell user: "Your remote repo at [URL] still exists. If you no longer need it, delete it manually on GitHub (or run `gh repo delete [repo] --yes`)."
5. Tell user: "Local sync data removed. Your current settings are unchanged. To fully remove the plugin, disable it in Claude Code plugin settings."
