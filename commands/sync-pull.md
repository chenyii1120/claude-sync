---
description: Pull settings from your sync repo to this machine
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`

## Your Task

Pull settings from the user's sync repo and apply them locally. Executable dirs
(`hooks/`, `skills/`, `rules/`) and dirs this machine hasn't opted into are
**never applied automatically** — they require explicit user confirmation. Follow
these steps exactly and in order.

1. **Check initialized.** If not, tell the user to run `/sync-init` first and stop.

2. **Preview the pull** to determine the safest mode:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.previewPull(), null, 2));
   "
   ```

   The `recommendation` field tells you which path to take:

   | recommendation | what it means | what you do |
   |---|---|---|
   | `up-to-date` | Local and remote both match the last-sync base. | Still run pull() once (step 4) — a deferred `pendingConfirmation` or `unknownRemoteDirs` from a prior run may still need resolving. If pull() returns `pulled:false, reason:'up-to-date'` with empty `pendingConfirmation` and `unknownRemoteDirs`, tell the user "Already up to date." and stop. |
   | `first-pull` | The user just ran `/sync-init` against an existing repo and `~/.claude` hasn't been hydrated yet. Local "missing" fields must NOT be treated as deletions. | Skip the diff. Run pull with `mode:'safe'` (the engine auto-detects first-pull). |
   | `safe-pull` | Remote has new changes; local hasn't diverged from base. | Show the remote diff (step 3). Confirm with the user, then run pull with `mode:'safe'`. |
   | `push-first` | Local has unpushed changes; remote has not advanced. | Tell the user "Your local has unpushed changes. Run `/sync-push` to push them, then `/sync-pull` again." Stop. |
   | `merge-with-conflicts` | Both sides have advanced relative to base. | Show both `localDelta` (unpushed local) AND the remote diff (step 3). Warn: "Pull will overwrite local-side conflicts with remote values; backup is automatic." Ask the user to confirm `mode:'merge'` (or run `/sync-push` first). |

3. **Show the diff** (for `safe-pull` and `merge-with-conflicts`):

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify({ settings: s.diffSettings(), plugins: s.diffPluginConfigs() }, null, 2));
   "
   ```

4. **Run the pull** with the mode chosen above. Capture the full JSON result — you
   need `pendingConfirmation`, `unknownRemoteDirs`, and the change lists from it.

   ```bash
   # safe-pull / first-pull / up-to-date:
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.pull(), null, 2));
   "

   # merge-with-conflicts (only when the user confirmed merge):
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.pull({ mode: 'merge' }), null, 2));
   "
   ```

   If the result is `{ pulled: false, reason: 'local-changes-pending' }`, the engine
   refused because local has unpushed work. Report the `localDelta` to the user and
   stop (they should `/sync-push` first, or re-confirm merge mode).

5. **Resolve unknown remote dirs** (B-03 opt-in). If the result's
   `unknownRemoteDirs` array is **non-empty**, the repo contains directories this
   machine has not opted into — they were **NOT** imported. For each one, list its
   incoming files so the user can decide:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     for (const dir of s.getUnknownRemoteDirs()) {
       console.log('=== ' + dir + ' ===');
       for (const f of s.listFilesAtRef('origin/main', 'user-config/' + dir)) console.log('  ' + f);
     }
   "
   ```

   Use **AskUserQuestion** to ask, for each unknown dir, whether to **add** (start
   syncing it) or **skip** (never sync it). Apply the choice:

   ```bash
   # add (allow-list):
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); s.addAllowSyncDir('<dir>');"
   # skip (never sync):
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); s.addSkipSyncDir('<dir>');"
   ```

   If you allow-listed **at least one** dir, **re-run the pull** (step 4, same mode)
   so the newly allowed dirs import. Use that fresh result for step 6. If you only
   skipped dirs, no re-run is needed.

6. **Confirm executable dirs** (B-02 two-stage). If the current result's
   `pendingConfirmation` array is **non-empty**, `rules/`/`skills/`/`hooks/` changes
   were **deferred** — they are NOT yet in `~/.claude`, and `last-sync` has NOT
   advanced. You MUST resolve them now (apply or discard) so the pending state does
   not linger. Show the full diff of every pending file:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     const fs = require('fs'); const path = require('path');
     for (const { dir, changes } of s.computePendingConfirmation()) {
       for (const file of changes) {
         const repoPath = path.join(s.REPO_DIR, 'user-config', dir, file);
         const localPath = path.join(s.CLAUDE_HOME, dir, file);
         const remote = fs.existsSync(repoPath) ? fs.readFileSync(repoPath, 'utf8') : null;
         const local = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : null;
         console.log('\\n===== ' + dir + '/' + file + ' =====');
         console.log('--- LOCAL (current, will be replaced) ---');
         console.log(local === null ? '(absent)' : local);
         console.log('--- REMOTE (incoming) ---');
         console.log(remote === null ? '(deleted on remote)' : remote);
       }
     }
   "
   ```

   Warn the user these dirs may contain **executable code** (JS hooks, shell
   scripts, agent instructions) and applying untrusted changes is a security risk.
   Use **AskUserQuestion** to have the user pick, per dir, **apply** or **discard**.
   Then run exactly one of:

   ```bash
   # apply ONLY the dirs the user confirmed (space-separated -> JSON array):
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.applyPendingDirs(['<dir1>', '<dir2>']), null, 2));
   "

   # OR discard everything pending (nothing is written; last-sync stays put and
   # the same changes will be re-offered on the next pull):
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.discardPendingDirs(), null, 2));
   "
   ```

   - Pass to `applyPendingDirs([...])` only the dirs the user approved. If the user
     approves some and declines others, list only the approved ones — the declined
     dirs are dropped (they'll re-offer next pull).
   - `applyPendingDirs` advances `last-sync`; `discardPendingDirs` does not.

7. **Report results:**
   - Show what changed: settings fields, plugin configs, plugin data, `commands/`,
     `agents/`, plus any `rules/`/`skills/`/`hooks/` you applied in step 6.
   - Show the backup location: "Backup saved to [path]" (from the pull result's `backupPath`).
   - If pull returned `pulled:false, reason:'up-to-date'` and nothing was pending or
     unknown: "Already up to date."
   - If `mode:'first-pull'` was used, mention "Initial hydration completed; future pulls will use 3-way merge."
   - If you discarded pending executable dirs, tell the user they were NOT applied and will be offered again next pull.

8. **Auto-reinstall missing plugins** — After the pull (and any applies) complete,
   check for missing marketplaces and plugins:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify({ missingMarketplaces: s.detectMissingMarketplaces(), missingPlugins: s.detectMissingPlugins() }));
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

9. **Handle merge conflicts (if any):**
   If the pull result contains `mergeConflicts` (non-empty array), the pull already
   completed with remote values as default. Present each conflict to the user:

   > 拉取完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 遠端（已保留） | 本地（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "light" | "dark" |
   >
   > 要改用本地的值嗎？

   If the user wants to keep local values for some fields:
   - Modify the local `~/.claude/settings.json` with the chosen values.
   - Tell the user: "Settings updated. Run /sync-push to push your choices to remote."
