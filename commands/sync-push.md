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
   - If `pushed: false, reason: 'secrets-detected'`: go to step 6a — nothing was pushed yet.
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

6a. **Secrets detected — PRE-push gate (`pushed: false, reason: 'secrets-detected'`).**
   Nothing has been pushed yet — the scan now runs *before* commit/push, so this
   is a gate, not a post-hoc warning. Present the flagged `secretWarnings` paths:

   > 推送已暫停：偵測到 `settings.json` 裡以下欄位疑似包含機敏資訊（例如 API 金鑰），
   > 目前**尚未推送任何內容**到遠端：
   >
   > - `env.OPENAI_API_KEY`（名稱疑似機敏關鍵字 / 數值格式疑似 token）

   Then use **AskUserQuestion** to ask how to proceed, offering:
   - **推送（接受風險）** — 例如遠端是私有 repo，可接受此風險：re-invoke the engine with
     explicit confirmation:
     ```bash
     node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.push({ confirmSecrets: true })));"
     ```
     Then report the result as in step 4 (it will now be `pushed: true`).
   - **取消** — do nothing further. Suggest the user remove or rotate the key in
     `~/.claude/settings.json` first, then re-run `/sync-push` — since nothing was
     pushed, there is no exposure to clean up yet.

7. **Informational secret note on success (non-blocking).** If a `pushed: true`
   result also carries a non-empty `secretWarnings` array (e.g. the user just chose
   "push anyway" in step 6a, or confirmed via a prior call), let the user know as an
   FYI — the push already completed:

   > 推送完成。提醒：`settings.json` 裡以下欄位疑似包含機敏資訊，已依你的確認一併推送：
   >
   > - `env.OPENAI_API_KEY`
   >
   > 如果不希望這個值留在同步的 repo 裡：之後可以到 `~/.claude/settings.json` 移除或更換
   > （rotate）該金鑰，再重新執行 `/sync-push`。

   If `secretWarnings` is missing or empty, skip this step silently.
