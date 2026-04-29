---
description: Restore settings from a backup
---

## Context

- Available backups: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.listBackups()))"`

## Your Task

Help the user restore settings from a backup.

1. List available backups with timestamps.
2. If no backups: "No backups available."
3. Ask user which backup to restore.
4. Run restore:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.restoreBackup('BACKUP_NAME_HERE');
     console.log('Restored successfully');
   "
   ```
5. Confirm what was restored (settings, plugin configs, plugin data, commands, rules, agents, skills, hooks).

6. **Auto-reinstall missing plugins** — After restore, check for missing marketplaces and plugins:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const mp = s.detectMissingMarketplaces();
     const pl = s.detectMissingPlugins();
     console.log(JSON.stringify({ missingMarketplaces: mp, missingPlugins: pl }));
   "
   ```

   - **Missing plugins (reinstall first):** For each plugin, run `claude plugin install <plugin>@<marketplace>`. The CLI auto-clones the parent marketplace as needed, so explicit `marketplace add` is unnecessary for any marketplace with at least one plugin to install.
   - **Missing marketplaces with no plugins:** After plugin installs, any marketplace still missing (no enabled plugins from it) can be added with `claude plugin marketplace add <owner>/<repo>` (e.g. `claude plugin marketplace add anthropics/claude-plugins-official`). **Do NOT** use the `github:owner/repo` form — recent CLI rejects it.
   - Report to the user what was reinstalled.
