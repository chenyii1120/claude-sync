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
   - Show what changed (settings fields, plugin configs, plugin data, commands, rules, agents, skills, hooks)
   - Show backup location: "Backup saved to [path]"
   - If `pulled: false`: "Already up to date."

6. **For `rules/`, `skills/`, and `hooks/` changes**: Show full diff and ask user to explicitly confirm before applying. These directories may contain executable code (JS, shell scripts) — applying untrusted changes is a security risk.

7. **Auto-reinstall missing plugins** — After pull completes successfully, check for missing marketplaces and plugins:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const mp = s.detectMissingMarketplaces();
     const pl = s.detectMissingPlugins();
     console.log(JSON.stringify({ missingMarketplaces: mp, missingPlugins: pl }));
   "
   ```

   - **Missing plugins (reinstall first):** For each plugin, run:
     ```bash
     claude plugin install <plugin>@<marketplace>
     ```
     `claude plugin install` will automatically clone the parent marketplace if it's not yet on disk, so you do **not** need to run `marketplace add` separately for marketplaces that have at least one plugin to install.
   - **Missing marketplaces with no plugins to install:** After plugin installs, re-run the detect step. For any marketplace still missing (i.e., declared but no enabled plugins from it), run:
     ```bash
     claude plugin marketplace add <owner>/<repo>
     ```
     Example: `claude plugin marketplace add anthropics/claude-plugins-official`. **Do NOT** prefix with `github:` — recent CLI versions reject that format.
   - If `marketplace add` reports "already on disk — declared in user settings" but the install location still doesn't exist, it means the CLI short-circuited because the marketplace is already declared in `settings.json`. Tell the user: this marketplace has no enabled plugins, so it'll be cloned lazily next time something needs it; this is harmless.
   - Report to the user what was reinstalled.
   - If any reinstallation fails, report the error but do not roll back the pull.

8. **Handle merge conflicts (if any):**
   If the result contains `mergeConflicts` (non-empty array), the pull already completed
   with remote values as default. Present each conflict to the user:

   > 拉取完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 遠端（已保留） | 本地（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "light" | "dark" |
   >
   > 要改用本地的值嗎？

   If user wants to keep local values for some fields:
   - Modify the local ~/.claude/settings.json with chosen values
   - Tell the user: "Settings updated. Run /sync-push to push your choices to remote."
