# claude-sync

[English](./README.md)

透過任意 git remote 在多台機器之間同步你的 Claude Code 設定、插件和自訂指令。

不需要額外依賴、不需要架 server，只需要一個私有 git repo。

## 安裝

```bash
# 1. 添加 marketplace
claude plugin marketplace add github:chenyii1120/claude-sync

# 2. 安裝插件
claude plugin install claude-sync

# 或從原始碼直接安裝（開發用）
claude plugin install /path/to/claude-sync
```

## 快速開始

**第一台機器：**
```
/sync-init          # 建立或連接一個 git repo
/sync-push          # 推送你的設定
```

**其他機器：**
```
/sync-init <url>    # 連接到同一個 repo
/sync-pull          # 從遠端拉取設定
```

## 指令說明

### `/sync-init`

首次設定。根據你的環境有兩種路徑：

**路徑 A — 建立新的 GitHub repo（預設，需要 `gh` CLI 且已認證）：**

1. 檢查前置條件：`git`（必要）、`gh`（可選）
2. 執行 `gh repo create claude-config-sync --private` 建立私有 repo
3. Clone 到 `~/.claude/sync/repo/`
4. 將你目前的本地設定匯出到 repo
5. Commit 並 push
6. 儲存同步設定到 `~/.claude/sync/config.json`

**路徑 B — 連接既有 repo（支援任意 git remote）：**

1. 你提供一個 remote URL（GitHub、GitLab、Bitbucket、自架伺服器等皆可）
2. Clone 到 `~/.claude/sync/repo/`
3. 如果 repo 已有同步資料（即存在 `global/` 目錄），會跳過初始匯出 — 你的遠端設定會被保留，可用 `/sync-pull` 拉取
4. 如果 repo 是空的，則匯出本地設定並 push

**第二台機器偵測：** 當你在新機器上執行 `/sync-init` 指向一個已有資料的 repo 時，會自動辨識並連接而不會覆蓋。執行 `/sync-pull` 即可匯入設定。

### `/sync-push`

將你的本地設定匯出到同步 repo 並推送到遠端。

1. 讀取 `~/.claude/settings.json`，過濾掉黑名單欄位（`statusLine`），寫入 `repo/global/settings.json`
2. 讀取 `~/.claude/plugins/installed_plugins.json` 和 `known_marketplaces.json`，將絕對路徑轉換為 `${CLAUDE_HOME}` 佔位符，寫入 `repo/global/`
3. 複製 `~/.claude/commands/` 和 `~/.claude/rules/` 到 `repo/user-config/`
4. 執行 `git add -A && git commit && git push`
5. 如果 push 被拒絕（遠端有更新的 commit），自動 fetch、以本地優先策略合併（`-X ours`），然後重試

### `/sync-pull`

從遠端拉取設定並套用到本機。

1. **自動備份** — 將目前的 `settings.json`、`installed_plugins.json` 和 `known_marketplaces.json` 快照到 `~/.claude/sync-backups/`（最多保留 5 份，自動清除最舊的）
2. **Fetch + merge** — 若發生合併衝突，退回到 `reset --hard origin/main`（遠端優先）
3. **匯入設定** — 將遠端設定合併到本地 `settings.json`。黑名單欄位（如 `statusLine`）會從本地保留，永遠不會被覆蓋
4. **匯入插件設定** — 將 `${CLAUDE_HOME}` 佔位符轉換回本地絕對路徑，寫入 `~/.claude/plugins/`
5. **匯入 commands/rules** — 從 repo 複製到 `~/.claude/commands/` 和 `~/.claude/rules/`。rules 的變更會先顯示給使用者確認後才套用（安全措施）
6. **偵測缺少的插件** — 匯入後檢查 `installed_plugins.json` 中的 `installPath` 是否指向不存在的目錄。如果有，會回報哪些插件需要透過 `claude plugin update` 重新安裝

### `/sync-status`

顯示目前的同步狀態：

- 是否已初始化
- 遠端 repo URL
- 上次同步時間戳
- 可用的遠端更新數量（以 5 秒 timeout 執行 `git fetch`）
- 本地設定是否有自上次 push 以來的變更

### `/sync-diff`

預覽本地與遠端之間的 JSON 層級差異，不會套用任何變更。對每個有差異的欄位，顯示本地值和遠端值。也會顯示插件設定的檔案層級差異。

### `/sync-restore`

列出可用的備份（最多 5 份，由新到舊排序），讓你選擇要還原哪一份。從選定的備份還原 `settings.json` 和插件設定檔。

### `/sync-uninstall`

移除所有本地同步資料：

1. 刪除 `~/.claude/sync/`（設定、repo clone、lockfile）
2. 刪除 `~/.claude/sync-backups/`
3. 告知你遠端 repo URL，方便你手動刪除（例如 `gh repo delete <repo> --yes`）
4. 你目前的設定不會受影響 — 只會移除同步用的 metadata

## 架構

### 運作原理

插件由三個層次組成：

```
┌─────────────────────────────────────────────────┐
│  Slash Commands (commands/*.md)                  │
│  Claude 在你輸入 /sync-init、/sync-push 等       │
│  指令時讀取這些檔案作為執行指引                      │
├─────────────────────────────────────────────────┤
│  Sync Engine (lib/sync-engine.js, ~450 行)       │
│  純 Node.js，零 npm 依賴。所有邏輯在這裡：         │
│  匯出、匯入、差異比對、備份、git 操作               │
├─────────────────────────────────────────────────┤
│  Git (系統)                                      │
│  所有遠端操作透過系統 git，                        │
│  經由 child_process.execSync 執行                 │
└─────────────────────────────────────────────────┘
```

### 插件檔案結構

```
claude-sync/
├── .claude-plugin/
│   └── plugin.json              # 插件 metadata（名稱、版本、作者）
├── hooks/
│   ├── hooks.json               # Hook 註冊（SessionStart）
│   └── session-start-check.js   # 輕量更新檢查器（~38 行）
├── commands/
│   ├── sync-init.md             # /sync-init
│   ├── sync-push.md             # /sync-push
│   ├── sync-pull.md             # /sync-pull
│   ├── sync-status.md           # /sync-status
│   ├── sync-diff.md             # /sync-diff
│   ├── sync-restore.md          # /sync-restore
│   └── sync-uninstall.md        # /sync-uninstall
└── lib/
    └── sync-engine.js           # 核心同步邏輯（~450 行）
```

### 同步 Repo 結構

當你 push 時，你的私有同步 repo 會長這樣：

```
（你的私有 git repo）
├── global/
│   ├── settings.json            # 你的設定（排除 statusLine）
│   ├── installed_plugins.json   # 插件清單，路徑使用 ${CLAUDE_HOME}
│   └── known_marketplaces.json  # Marketplace 清單，路徑使用 ${CLAUDE_HOME}
└── user-config/
    ├── commands/                # 你的全域自訂 slash commands
    └── rules/                   # 你的全域 rules
```

### 本地狀態（不會推送到遠端）

```
~/.claude/sync/
├── config.json                  # 同步 repo URL、設定
├── last-sync.json               # 上次同步的時間戳和操作類型
├── .sync.lock                   # Lockfile（目錄型，防止並行同步）
└── repo/                        # 你的同步 repo 的本地 git clone

~/.claude/sync-backups/          # 每次 pull 前的自動備份（最多 5 份）
└── backup-2026-03-01T12-00-00-000Z/
    ├── settings.json
    ├── installed_plugins.json
    └── known_marketplaces.json
```

## Hooks

本插件註冊了一個 **SessionStart** hook。

### 什麼是 SessionStart？

Claude Code 在每次新對話工作階段開始時觸發 `SessionStart` — 當你在終端機執行 `claude` 且工作階段初始化時。它在你的**第一個 prompt 被處理之前**執行。

### Hook 的行為

`hooks/session-start-check.js` 在每次工作階段開始時自動執行：

1. 檢查 sync 是否已初始化（`~/.claude/sync/repo/` 和 `config.json` 是否存在）。如果沒有，靜默退出。
2. 以 **5 秒 timeout** 執行 `git fetch origin main`。如果網路不可用或太慢，靜默退出 — 永遠不會阻塞你的工作階段。
3. 比較 `git rev-parse HEAD`（本地）和 `git rev-parse origin/main`（遠端）。
4. 如果遠端有更新，用 `git rev-list HEAD..origin/main --count` 計算落後幾個 commit。
5. 輸出通知：`[claude-sync] 遠端有 N 個更新。執行 /sync-pull 來同步。`
6. 遇到**任何**錯誤（網路故障、git 錯誤等），靜默退出，回傳碼為 0。

**核心原則：hook 是唯讀且被動的。** 它永遠不會修改你的本地設定。只會通知。由你決定何時 pull。

### 工作階段生命週期

```
工作階段開始
  │
  ├─ SessionStart hooks 觸發（claude-sync 在這裡檢查遠端更新）
  │
  ├─ 使用者的第一個 prompt
  │
  ├─ ... 對話進行中 ...
  │
  ├─ 使用者輸入 /sync-push 或 /sync-pull（手動、按需觸發）
  │
  └─ 工作階段結束
```

## 同步範圍

### 會同步的內容

| 來源 | 在 repo 中的位置 | 策略 |
|------|----------------|------|
| `~/.claude/settings.json` | `global/settings.json` | 黑名單過濾：所有欄位皆同步，**除了** `statusLine` |
| `~/.claude/plugins/installed_plugins.json` | `global/installed_plugins.json` | 絕對路徑（`/Users/you/.claude/...`）替換為 `${CLAUDE_HOME}` 佔位符 |
| `~/.claude/plugins/known_marketplaces.json` | `global/known_marketplaces.json` | 同上路徑轉換 |
| `~/.claude/commands/` | `user-config/commands/` | 完整遞迴目錄複製 |
| `~/.claude/rules/` | `user-config/rules/` | 完整遞迴目錄複製 |

### 不會同步的內容

| 項目 | 原因 |
|------|------|
| settings 的 `statusLine` 欄位 | 包含機器專屬的絕對路徑（例如 `/opt/homebrew/bin/node`），搬到另一台機器會壞掉 |
| `plugins/cache/` | 插件原始碼；透過 marketplace 安裝時自動重建 |
| `plugins/marketplaces/` | Marketplace repo 的 git clone；執行 `marketplace add` 時重建 |
| `plugins/blocklist.json` | 機器專屬偏好 |
| `projects/*/*.jsonl` | 對話記錄；檔案大且含敏感資訊 |
| `debug/`、`cache/`、`history.jsonl` | 機器專屬的暫存資料 |
| `session-env/`、`tasks/`、`teams/`、`todos/` | 工作階段專屬的執行時狀態 |
| 專案層級的 `CLAUDE.md` | 已存在於你的專案 git repo 中 |

### 路徑轉換

插件設定檔包含的絕對路徑在不同機器上會不同。同步引擎會自動處理：

**Push**（本地 → repo）：
```
/Users/alice/.claude/plugins/cache/superpowers/4.3.1
→ ${CLAUDE_HOME}/plugins/cache/superpowers/4.3.1
```

**Pull**（repo → 本地）：
```
${CLAUDE_HOME}/plugins/cache/superpowers/4.3.1
→ /Users/bob/.claude/plugins/cache/superpowers/4.3.1
```

## 衝突解決

使用 **last-write-wins** 策略：

- **Push 衝突**（遠端有更新的 commit）：Fetch 遠端，以 `-X ours` 合併（你的本地變更優先），然後推送合併結果。
- **Pull 衝突**（合併失敗）：中止合併，重設為遠端 HEAD（`reset --hard origin/main`）。你的本地設定會被遠端覆蓋，但 pull 之前已經建立了備份。
- **並行同步防護**：檔案系統型 lockfile（`~/.claude/sync/.sync.lock`）防止兩個同步操作同時執行。使用原子性的 `mkdir` — 如果目錄已存在，取得鎖定會失敗。

所有 git 歷史都會保留。如果出了問題，你隨時可以從 git 歷史或 `~/.claude/sync-backups/` 的自動備份中恢復。

## 錯誤處理

| 情境 | 行為 |
|------|------|
| 沒有網路（hook） | 靜默退出，絕不阻塞工作階段啟動 |
| 沒有網路（指令） | 清楚的錯誤訊息：「Failed to fetch from remote. Check your network.」 |
| 未安裝 `gh` CLI | 跳過自動建立 repo，要求手動輸入 URL |
| 未安裝 `git` | 阻止初始化，顯示清楚的錯誤訊息 |
| Push 被拒絕 | 自動 fetch + merge + 重試 |
| 合併衝突 | Last-write-wins + 備份安全網 |
| 並行同步 | Lockfile 防止同時操作 |
| Pull 後有缺少的插件 | 回報哪些插件需要 `claude plugin update` |
| 沒有全域 git identity | 自動在同步 repo 中設定（繼承全域設定或使用預設值） |

## 技術棧

- **執行環境：** 僅 Node.js 內建模組（`fs`、`path`、`child_process`、`os`）— 零 npm 依賴
- **版本控制：** 系統 `git`，透過 `child_process.execSync` 呼叫，可設定 timeout
- **插件系統：** Claude Code 原生插件格式（`.claude-plugin/plugin.json`、`hooks/hooks.json`、`commands/*.md`）
- **後端：** 任意 git remote（GitHub、GitLab、Bitbucket、Gitea、自架伺服器、bare repo 等）

## 給 Claude Code Agent 的指引

參閱 [SETUP_GUIDE.md](./SETUP_GUIDE.md) — 這是一份供 Claude Code agent 代替使用者安裝和設定 claude-sync 時使用的參考文件。內容包含前置條件檢查、逐步設定說明、同步引擎的匯出函式參考，以及重要的行為注意事項（例如：拉取前必須顯示差異、rules 變更需要確認）。

## 免責聲明

- 這是一個**社群插件**，並非 Anthropic 官方產品，與 Anthropic 沒有任何關聯、背書或支援關係。
- 本插件會讀寫 `~/.claude/` 底下的檔案。雖然內建備份機制，但**使用風險自負**。拉取前請先用 `/sync-diff` 確認變更內容。
- 你的 `settings.json` 可能包含敏感資料（例如帶有 API key 或 token 的環境變數）。本插件會將這些資料推送到 git remote。**請務必使用私有 repo**，並檢查同步的內容。
- 衝突解決採用簡單的 last-write-wins 策略。在少數情況下，某台機器的設定可能會覆蓋另一台的變更。Git 歷史紀錄會保留作為安全網。
- 若 Anthropic 未來推出原生的設定同步功能，本插件可能不再需要。

## 授權條款

MIT
