---
description: Show claude-sync status
---

## Context

- Sync status: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.getStatus(), null, 2))"`

## Your Task

Display the sync status to the user in a clear format:

- **Initialized**: yes/no
- **Repo URL**: the git remote
- **Last sync**: timestamp or "never"
- **Remote updates**: number available, or "fetch failed (offline?)"
- **Local changes**: yes/no (settings differ from last push)

If not initialized, suggest running `/sync-init`.
