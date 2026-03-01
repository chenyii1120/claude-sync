---
description: Pull settings from your sync repo to this machine
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Pull settings from the user's sync repo and apply them locally.

1. **Check initialized.** If not, tell user to run `/sync-init` first.

2. **Show diff first** by running:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     s.gitFetch(10000);
     const diffs = s.diffSettings();
     const pluginDiffs = s.diffPluginConfigs();
     console.log(JSON.stringify({ settings: diffs, plugins: pluginDiffs }, null, 2));
   "
   ```

3. **Show the diff to the user** in a readable format. For each changed field, show local vs remote value.

4. **Ask for confirmation** before applying. If user confirms, run pull:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     try {
       const result = s.pull();
       console.log(JSON.stringify(result, null, 2));
     } catch (e) {
       console.error('ERROR:', e.message);
     }
   "
   ```

5. **Report results:**
   - Show what changed (settings fields, plugin configs, commands, rules)
   - Show backup location: "Backup saved to [path]"
   - If `missingPlugins` is non-empty: "The following plugins are in your sync list but not installed on this machine: [list]. Run `claude plugin update` to install them."
   - If `pulled: false`: "Already up to date."

6. **For rules/ changes**: Show full diff and ask user to explicitly confirm before applying. This is a security measure.
