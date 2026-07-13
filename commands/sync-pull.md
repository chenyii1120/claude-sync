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

1a. **Plugin version pinning consent (first pull only).** Check whether the user has already decided:

   ```bash
   node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.pinPluginsDecided());"
   ```

   If `false`, use **AskUserQuestion** to ask:

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

   **If the user chose Disable**, check whether this machine already has any
   claude-sync-managed pinned marketplace, which would otherwise stay frozen at its
   pinned commit forever with pinning off:
   ```bash
   node -e "const fs=require('fs'),p=require('path'),os=require('os'); const d=p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'sync','pinned-marketplaces'); console.log(JSON.stringify(fs.existsSync(d)?fs.readdirSync(d):[]));"
   ```
   If the array is non-empty, tell the user pinning is being turned off and use
   **AskUserQuestion** to ask, for each managed marketplace listed, whether to unpin it
   back to its original github source now (reinstalling at latest) or leave it as is.
   For each the user chooses to unpin:
   ```bash
   node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.reverseMigrateMarketplace(process.argv[1]),null,2));" "<name>"
   ```
   If they leave one in place, tell them its plugins stay frozen at their pinned commit
   until pinning is re-enabled or it's manually unpinned.

   If `pinPluginsDecided()` was already `true`, skip this step silently — do not ask again.

   Note for either choice: in Phase 1A, `/sync-pull` does **not** yet apply the plugin
   lock — this only records the user's preference. If they chose Disable, that's
   respected (nothing will be locked or applied). If they chose Enable, a future phase
   will offer to reproduce the locked versions on pull; for now nothing changes about
   what this pull does.

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

5. **Warn about suspicious remote dirs, then resolve unknown ones** (B-03 opt-in).

   **Suspicious dirs first:** if the result's `suspiciousRemoteDirs` array is
   **non-empty**, the repo contains directories whose names differ from a
   protected directory only by letter case (e.g. `Hooks` vs `hooks`). On
   macOS/Windows such a name aliases the protected directory on disk, so this
   pattern looks like a **spoofing attempt** against the sync repo. These dirs
   were NOT imported, can NEVER be imported, and `addAllowSyncDir` rejects
   them — do NOT offer an add/skip choice for them. Tell the user explicitly:
   "The sync repo contains suspicious directories [names] that mimic protected
   directories. This may indicate the repo was tampered with — review its
   recent history (`git -C ~/.claude/sync/repo log --stat`) and remove these
   directories from the repo (e.g. from the machine that pushed them)."

   **Unknown dirs:** if the result's `unknownRemoteDirs` array is
   **non-empty**, the repo contains directories this machine has not opted
   into — they were **NOT** imported. For each one, list its incoming files so
   the user can decide:

   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     for (const dir of s.getUnknownRemoteDirs()) {
       console.log('=== ' + dir + ' ===');
       for (const f of s.listFilesAtRef('origin/' + s.getBranch(), 'user-config/' + dir)) console.log('  ' + f);
     }
   "
   ```

   Use **AskUserQuestion** to ask, for each unknown dir, whether to **add** (start
   syncing it) or **skip** (never sync it). Apply the choice:

   ```bash
   # add (allow-list): pass the dir name as argv[1], never interpolate it into the JS string.
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); s.addAllowSyncDir(process.argv[1]);" '<dir>'
   # skip (never sync):
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); s.addSkipSyncDir(process.argv[1]);" '<dir>'
   ```

   Unsafe-charset or reserved-collision dir names never appear in
   `unknownRemoteDirs` in the first place — they surface under
   `suspiciousRemoteDirs` instead (step 5, "Suspicious dirs first"). Report
   them to the user as a likely spoofing/injection attempt in the remote and
   do not add them.

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
     dirs **stay pending** (the state file keeps them) and are re-offered on the
     next pull. `discardPendingDirs()` clears ALL pending dirs at once.
   - `applyPendingDirs` advances `last-sync`; `discardPendingDirs` does not.
   - **Warn the user when they decline/discard a dir:** declining means the LOCAL
     version of that dir wins. The next `/sync-push` from this machine will
     **overwrite the remote's newer version** of that dir with the local content.
     Say this explicitly, e.g.: "Note: since you declined the remote `hooks/`
     changes, your local version is kept, and your next /sync-push will overwrite
     the newer remote `hooks/` content."

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

   - **Missing plugins (reinstall first):** Each entry in `missingPlugins` is
     already a full `plugin@marketplace` identifier (e.g.
     `superpowers@claude-plugins-official`). For each one, pass it VERBATIM:
     ```bash
     claude plugin install <missingPlugins entry>
     ```
     Do NOT split it or append a marketplace — it is already complete.
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

10. **Apply pinned plugin versions (sync-pin).** After the pull (and any applies/reinstalls
    above) are complete, check whether the just-pulled lock has drift against what's
    installed locally.

    **Gate:** skip this whole step silently if pinning is disabled:
    ```bash
    node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.pinPluginsEnabled());"
    ```
    If it prints `false`, stop here — do not compute drift, do not mention the lock.

    **Compute drift** against the freshly-pulled commit:
    ```bash
    node -e "
      const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
      console.log(JSON.stringify(s.getPluginLockDrift('HEAD')));
    "
    ```
    Keep only rows whose `action` is `reinstall` or `missing` — these are the ones an
    apply would actually change. If there are none, say nothing further and finish the
    flow.

    **Present the drift** to the user as a table (plugin, current version, locked
    version, action), grouped by marketplace (the substring of `plugin` after the
    last `@`). Explain plainly that applying will reinstall those plugins at the exact
    pinned commit the pushing machine recorded, and that this changes installed plugin
    code — the same caution as the executable-dir confirmation in step 6.

    **Ask which marketplaces to apply** with **AskUserQuestion** — a multiSelect
    Apply/Skip per affected marketplace (a plain Apply/Skip is fine if only one
    marketplace is affected). Marketplaces the user skips are left untouched and are
    re-offered on a later pull.

    **Apply the approved marketplaces:**
    ```bash
    node -e "
      const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
      console.log(JSON.stringify(s.applyPluginLock(JSON.parse(process.argv[1])), null, 2));
    " '{"marketplaces":["<name1>","<name2>"]}'
    ```
    Replace the JSON argv with the actual approved marketplace names. If the user
    approved none, skip this call entirely.

    **Report results** from the returned object:
    - `results[]` entries with `status:'applied'` — confirm the marketplace's plugins
      were reproduced at the pinned `commit`, listing the `reinstalled` ids.
    - If `unreproducible` is non-empty, the pinned commit no longer exists upstream
      (history was rewritten on the machine that pushed it), AND no vendor bundle was
      available to fall back on — the engine already tries the vendor bundle
      automatically before giving up, so a marketplace only lands here when there is
      also no bundle for it. Look up each affected marketplace's pinned commit from the
      drift rows computed above (`lockedCommit`, grouped by marketplace) and warn the
      user by name, then offer two options: (a) update the pin to a newer commit and
      push from a machine that still has it, or (b) keep the currently installed
      version for now — nothing was changed for that marketplace. Also mention that to
      protect this marketplace against future upstream rewrites, they can enable
      vendoring with `/sync-pin vendor <marketplace>` and re-push from a machine that
      still has the commit, so the bundle is stored for next time.
    - `results[]` entries with `status:'invalid-name'|'invalid-url'|'clone-failed'` —
      report that the marketplace could not be prepared (its name or URL failed
      validation, or the clone failed) and was skipped without touching any installs.
