---
description: Show plugin pin drift, or re-pin a marketplace to a specific ref
---

## Context

- Sync initialized: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.isInitialized())"`
- Pinning enabled: !`node -e "const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(s.pinPluginsEnabled())"`

## Your Task

`/sync-pin` has three sub-flows depending on the argument the user gave: `status` (default, no
argument), `set <marketplace> <ref>`, and `vendor <marketplace> [off]`.

1. **Check initialized.** If not, tell the user to run `/sync-init` first and stop.

### `/sync-pin status` (or no argument)

2. **Show the drift table.** Run:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     console.log(JSON.stringify(s.getPluginLockDrift('HEAD')));
   "
   ```
   Render the rows as a table: plugin / current version (and commit, if present) / locked
   version (and commit) / action. If the result is an empty array, tell the user:

   > All pinned plugins are in sync.

   Otherwise, briefly explain what each `action` means: `in-sync` (nothing to do),
   `reinstall` (installed version differs from the locked one — `/sync-pull` will offer
   to fix this), `missing` (locked but not installed), `unlocked` (installed but not in
   the lock — will not be pinned until the next `/sync-push`). Do not apply anything here
   — this is a read-only report. Point the user at `/sync-pull` to apply drift, or
   `/sync-pin set <marketplace> <ref>` to change a pin.

### `/sync-pin set <marketplace> <ref>`

3. **Confirm the target.** `<ref>` can be a tag, branch, or commit sha in the
   marketplace's origin repo. Ask the user to confirm if either argument is missing or
   ambiguous.

4. **Run the re-pin:**
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.setPinnedRef(process.argv[1], process.argv[2]), null, 2));" "<marketplace>" "<ref>"
   ```

5. **Report the result:**
   - `status: 'applied'` — tell the user `<marketplace>` is now pinned to `<ref>`
     (commit `commit` from the result) **on this machine only**. Remind them to run
     **`/sync-push`** so the new pin is recorded in `plugins.lock.json` and picked up by
     other machines on their next `/sync-pull`.
   - `status: 'invalid-name'` — the marketplace name isn't safe to use; nothing was
     changed.
   - `status: 'no-url'` — no origin URL is known for this marketplace (not in the
     lockfile or in `known_marketplaces.json`); nothing was changed.
   - `status: 'invalid-url'` — the recorded origin URL failed validation; nothing was
     changed.
   - `status: 'clone-failed'` — cloning the origin repo failed (see `error`); nothing
     was changed.
   - `status: 'bad-ref'` — `<ref>` does not exist in the origin repo; nothing was
     changed. Suggest the user double check the tag/branch/sha spelling.
   - `status: 'unreproducible'` — the resolved commit could not be checked out; nothing
     was changed.
   - Any other status: report it plainly and note nothing was changed.

### `/sync-pin vendor <marketplace> [off]`

6. **No marketplace given** — just show the current vendor list. Run:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.vendorMarketplaces()));"
   ```
   Render the list, or tell the user no marketplace is currently vendored if it's empty.

7. **`/sync-pin vendor <marketplace>`** (no `off`) — enable vendoring:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.setVendorMarketplace(process.argv[1], true)));" "<marketplace>"
   ```
   Tell the user `<marketplace>` will now be vendored: on the next `/sync-push`, a `git bundle`
   of its pinned commit is stored in the sync repo, so the exact version can still be restored
   on other machines even if the upstream repo later force-pushes or deletes that commit.
   Remind them to run **`/sync-push`** to actually create and store the bundle.

8. **`/sync-pin vendor <marketplace> off`** — disable vendoring:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js'); console.log(JSON.stringify(s.setVendorMarketplace(process.argv[1], false)));" "<marketplace>"
   ```
   Tell the user `<marketplace>` will no longer be vendored. Any existing bundle for it is
   pruned on the next `/sync-push` once it's no longer pinned/vendored.
