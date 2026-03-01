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
5. Confirm what was restored.
