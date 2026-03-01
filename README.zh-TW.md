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

## 指令一覽

| 指令 | 說明 |
|------|------|
| `/sync-init` | 初始化同步 — 建立新 repo 或連接既有 repo |
| `/sync-push` | 將本機設定推送到同步 repo |
| `/sync-pull` | 從同步 repo 拉取設定（會顯示差異並要求確認） |
| `/sync-status` | 顯示同步狀態及待更新項目 |
| `/sync-diff` | 預覽本機與遠端的設定差異 |
| `/sync-restore` | 從備份還原設定 |
| `/sync-uninstall` | 移除同步資料並清理 |

## 同步範圍

| 項目 | 策略 |
|------|------|
| `settings.json` | 完整同步（排除機器專屬的 `statusLine`） |
| `installed_plugins.json` | 完整同步，路徑自動轉換 |
| `known_marketplaces.json` | 完整同步，路徑自動轉換 |
| `~/.claude/commands/` | 完整目錄同步 |
| `~/.claude/rules/` | 完整目錄同步（拉取時需確認） |

## 不會同步的內容

- `statusLine` 設定（包含機器專屬的絕對路徑）
- 插件原始碼（`plugins/cache/`）— 透過 marketplace 重新安裝即可
- 對話記錄、除錯日誌、歷史紀錄

## 安全性

- **每次拉取前自動備份** — 最多保留 5 份備份
- **rules 變更需要確認** — 拉取時會顯示差異並要求明確確認
- **建議使用私有 repo** — 確保你的設定不會公開
- **路徑轉換** — 絕對路徑會被替換為 `${CLAUDE_HOME}` 佔位符

## 運作原理

- **零 npm 依賴** — 僅使用 Node.js 內建模組（`fs`、`path`、`child_process`）
- **支援任意 git remote** — GitHub、GitLab、Bitbucket、自架伺服器皆可
- **SessionStart hook** — 啟動時被動檢查遠端是否有更新
- **Last-write-wins** — 簡單的衝突策略，git 歷史紀錄作為安全網

## 授權條款

MIT
