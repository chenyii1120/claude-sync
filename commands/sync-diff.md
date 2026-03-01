---
description: Preview differences between local and remote settings
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Show JSON-level diff between local and remote settings.

1. Check initialized. If not, suggest `/sync-init`.

2. Fetch and diff:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.gitFetch(10000);
     const settings = s.diffSettings();
     const plugins = s.diffPluginConfigs();
     console.log(JSON.stringify({ settings, plugins }, null, 2));
   "
   ```

3. Display diffs in readable format. For each changed field show:
   - Field name
   - Local value
   - Remote value

4. If no differences: "Local and remote are in sync."
