---
description: Initialize claude-sync — set up cloud sync for your Claude Code settings
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`
- git available: !`which git && echo "yes" || echo "no"`
- gh available: !`which gh 2>/dev/null && echo "yes" || echo "no"`
- gh auth status: !`gh auth status 2>&1 | head -3 || echo "not authenticated"`

## Your Task

Help the user initialize claude-sync. Follow these steps:

1. **Check if already initialized.** If yes, tell the user and suggest `/sync-uninstall` first.

2. **Check prerequisites.** `git` is required. `gh` is optional (for auto-creating GitHub repo).

3. **Ask the user**: Do they want to:
   - **(A) Create a new private GitHub repo** (requires `gh` CLI authenticated) — run:
     ```
     gh repo create claude-config-sync --private --description "Claude Code settings sync"
     ```
     Then get the repo URL:
     ```
     gh repo view claude-config-sync --json url -q .url
     ```
     Use this URL in step 4. Do NOT use `--clone` — `init()` handles cloning internally.
   - **(B) Connect to an existing git repo** — ask for the remote URL.

4. **Run init.** Use the sync-engine:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const result = s.init('REMOTE_URL_HERE');
     console.log(JSON.stringify(result, null, 2));
   "
   ```

5. **Report results.** Tell the user:
   - If the repo was empty (`hasContent: false`): "Settings exported and pushed."
   - If the repo had data (`hasContent: true`): "Connected to existing sync repo." Then **immediately ask the user if they want to pull now.** If yes, run `/sync-pull` flow (show diff, confirm, pull, reinstall missing plugins). This avoids the user forgetting to pull and working with default settings.

5a. **Ask about plugin version pinning (unless already decided).** Init is the natural first-time moment for this — but the `hasContent: true` path in step 5 may have already run the `/sync-pull` flow, which asks this same question and records the answer. So check first:

   ```bash
   node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.pinPluginsDecided());"
   ```

   If `true`, skip this step silently (do not ask again). If `false`, use **AskUserQuestion**:

   > 是否要鎖定已啟用插件的版本（pinPlugins）？啟用後，`/sync-push` 會把每個已啟用插件目前安裝的 git commit 記錄進 `plugins.lock.json`，讓其他機器可以重現相同版本，而不是隨 marketplace 最新版飄移。
   >
   > - **啟用（預設）/ Enable (default)** — 記錄插件版本，供其他機器重現。
   > - **不啟用 / Disable** — 不記錄、不套用插件鎖定；插件安裝該 marketplace 的最新版本。

   Persist the answer:
   ```bash
   # Enable:
   node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js').setPinPlugins(true);"
   # Disable:
   node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js').setPinPlugins(false);"
   ```

   Tell the user they can change this later by editing `pinPlugins` in `~/.claude/sync/config.json`.

6. **Detect unknown sync dirs.** The default sync set covers `commands/`, `rules/`, `agents/`, `skills/`, `hooks/`. Anything else under `~/.claude/` (e.g. `homunculus/`, custom MCP scripts referenced by hooks) needs explicit user opt-in. Run:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.detectUnknownDirs()));
   "
   ```

   For each directory in the result, ask the user:

   > 偵測到 `~/.claude/<dir>/` 不在已知同步清單中。
   > 同步嗎？(a) 加入同步 / (s) 永久跳過 / (l) 之後再決定

   Persist the answer (pass the dir name as argv[1], never interpolate it into the JS string):
   ```bash
   # add → allow list
   node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js').addAllowSyncDir(process.argv[1])" '<dir>'
   # skip → skip list (won't ask again)
   node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js').addSkipSyncDir(process.argv[1])" '<dir>'
   # later → no change; will be re-prompted next /sync-init or /sync-push
   ```

   **Special case:** if the user's settings.json has hook commands referencing `$HOME/.claude/<dir>/`, strongly suggest adding that dir — otherwise the hooks will fail on other machines after a sync.

7. **Ask about auto-push.** Ask the user:

   > 是否啟用自動推送（autoPush）？啟用後，每次 session 結束時會自動推送你的設定變更到遠端。

   - If yes: set `autoPush: true` in config:
     ```bash
     node -e "
       const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
       const c = s.loadConfig();
       c.autoPush = true;
       s.saveConfig(c);
       console.log('autoPush enabled');
     "
     ```
   - If no: leave it as default (`autoPush: false`). Tell the user they can enable it later by running:
     ```
     node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); const c = s.loadConfig(); c.autoPush = true; s.saveConfig(c);"
     ```

8. **Chezmoi check.** If `chezmoi managed 2>/dev/null | grep -q .claude`, warn about potential conflicts.

IMPORTANT: Replace `REMOTE_URL_HERE` with the actual URL before running.
