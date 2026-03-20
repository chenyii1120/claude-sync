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
   - If `pushed: true` and no `mergeConflicts` (or empty): "Settings pushed successfully."
   - If `pushed: false, reason: 'no-changes'`: "No changes to push. Already up to date."
   - If error: Show the error message and suggest troubleshooting.

4. **Handle merge conflicts (if any):**
   If the result contains `mergeConflicts` (non-empty array), the push already completed
   with local values as default. Present each conflict to the user:

   For each conflict in the array, show:
   - The field name (key)
   - The local value (what was kept)
   - The remote value (what was discarded)
   - Whether either side deleted the field

   Example presentation:
   > 推送完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 本地（已保留） | 遠端（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "dark" | "light" |
   > | env.API_KEY | "key-abc" | "key-xyz" |
   >
   > 要改用遠端的值嗎？可以選擇全部改用遠端、或指定個別欄位。

   If user wants to change some values:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     // Read current repo settings, apply user's chosen values, write back
     const fp = require('path').join(s.REPO_DIR, 'global', 'settings.json');
     const data = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
     data.FIELD_NAME = CHOSEN_VALUE;  // repeat for each field user wants to change
     require('fs').writeFileSync(fp, JSON.stringify(data, null, 2));
     s.gitExec('add -A');
     s.gitExec('commit -m \"resolve merge conflicts\"');
     s.gitExec('push origin main');
     console.log('done');
   "
   ```
   Replace FIELD_NAME and CHOSEN_VALUE with the actual field and value the user chose.
