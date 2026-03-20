---
description: Preview differences between local and remote settings
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Show diff between local and remote settings, plugin configs, user config, and plugin data.

1. Check initialized. If not, suggest `/sync-init`.

2. Fetch and diff:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.gitFetch(10000);
     const settings = s.diffSettings();
     const plugins = s.diffPluginConfigs();
     const userConfig = s.diffUserConfig();
     const pluginData = s.diffPluginData();
     console.log(JSON.stringify({ settings, plugins, userConfig, pluginData }, null, 2));
   "
   ```

3. Display diffs in readable format:

   **Settings diffs** — For each changed field, show field name, local value, remote value.

   **Plugin config diffs** — Show which plugin config files differ.

   **User config diffs** (commands, rules, agents, skills, hooks) — For each entry, show:
   - Directory and file path
   - Status: `modified`, `local-only` (exists locally but not in remote), or `remote-only` (exists in remote but not locally)

   **Plugin data diffs** — For each entry, show file path and status.

4. If no differences in any category: "Local and remote are in sync."
