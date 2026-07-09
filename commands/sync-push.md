---
description: Push local Claude Code settings to your sync repo
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Push the user's local Claude Code settings to their sync repo.

1. **Check initialized.** If not, tell user to run `/sync-init` first.

2. **Detect unknown sync dirs.** Before pushing, check whether the user has new directories under `~/.claude/` that aren't yet in the allow/skip list:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.detectUnknownDirs()));
   "
   ```

   For each unknown dir, ask the user `(a)dd to sync / (s)kip permanently / (l)ater` and persist via `addAllowSyncDir(<name>)` or `addSkipSyncDir(<name>)`. (See sync-init.md for the prompt template.) Skip this step silently if the result is empty.

3. **Run push:**
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

4. **Report results:**
   - If `pushed: true` and no `mergeConflicts` (or empty): "Settings pushed successfully."
   - If `pushed: false, reason: 'no-changes'`: "No changes to push. Already up to date."
   - If error: Show the error message and suggest troubleshooting.

5. **Handle merge conflicts (if any):**
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

   If user wants to change some values, build a JSON object with one entry per
   field the user chose to change: key = the conflict's `key` exactly as it
   appeared in `mergeConflicts` (including dot-paths for nested fields, e.g.
   `env.API_KEY`), value = the chosen value (typically the remote value from
   the table, but the user may type something else). Pass that object as a
   single JSON argv to `resolvePushConflicts`, which applies it to the repo's
   settings.json (setting dot-paths correctly), commits, pushes, and advances
   last-sync so the next status/preview doesn't falsely report "remote has
   updates":
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.resolvePushConflicts(JSON.parse(process.argv[1]))));
   " '{"theme":"light","env.API_KEY":"key-xyz"}'
   ```
   Replace the JSON argv with the actual fields/values the user chose. If the
   result is `{"pushed":false,"reason":"no-changes"}`, tell the user their
   choices already matched what was pushed — nothing more to do.
