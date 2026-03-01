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
     gh repo create claude-config-sync --private --clone --description "Claude Code settings sync"
     ```
     Then move the clone to `~/.claude/sync/repo/`.
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
   - If the repo was empty: "Settings exported and pushed."
   - If the repo had data: "Connected to existing sync repo. Run `/sync-pull` to import settings."
   - Remind: "Run `/sync-push` after changing settings. Run `/sync-pull` on other machines."

6. **Chezmoi check.** If `chezmoi managed 2>/dev/null | grep -q .claude`, warn about potential conflicts.

IMPORTANT: Replace `REMOTE_URL_HERE` with the actual URL before running.
