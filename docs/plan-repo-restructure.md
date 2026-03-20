# 計畫：Plugin 子目錄重構（解決遞迴 cache 問題）

## 背景

marketplace 和 plugin 共用同一個 repo root，導致：
1. CC 安裝 plugin 時 clone repo 到 cache
2. cache 裡也有 `marketplace.json`
3. CC 載入 cache 時又觸發 clone → 無限遞迴 → `ENAMETOOLONG`

官方 marketplace 的做法：plugin 放在子目錄（如 `./plugins/foo`），子目錄裡只有 `plugin.json` 沒有 `marketplace.json`，所以不遞迴。

## 目標結構

```
claude-sync/                          ← marketplace repo root
├── .claude-plugin/
│   └── marketplace.json              ← source: "./plugin"
├── plugin/                           ← plugin 子目錄
│   ├── .claude-plugin/
│   │   └── plugin.json               ← 只有 plugin.json
│   ├── lib/
│   │   └── sync-engine.js
│   ├── commands/
│   │   ├── sync-init.md
│   │   ├── sync-push.md
│   │   ├── sync-pull.md
│   │   ├── sync-status.md
│   │   ├── sync-diff.md
│   │   ├── sync-restore.md
│   │   └── sync-uninstall.md
│   └── hooks/
│       ├── hooks.json
│       ├── session-start-check.js
│       └── session-end-check.js
├── README.md                         ← 留在 root
├── README.zh-TW.md
├── SETUP_GUIDE.md
└── docs/
```

## 步驟

### 1. 建立 plugin/ 子目錄

```bash
mkdir -p plugin/.claude-plugin
```

### 2. 移動 plugin 檔案到 plugin/

```bash
# 移動核心檔案
mv lib/ plugin/
mv commands/ plugin/
mv hooks/ plugin/

# 複製 plugin.json（不要移動 marketplace.json）
cp .claude-plugin/plugin.json plugin/.claude-plugin/plugin.json
```

### 3. 更新 marketplace.json

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "claude-sync",
  "description": "A marketplace for claude-sync plugin",
  "owner": {
    "name": "chenyii1120",
    "email": "chenyii1120@gmail.com"
  },
  "plugins": [
    {
      "name": "claude-sync",
      "description": "Sync your Claude Code settings, plugins, and commands across machines using any git remote",
      "source": "./plugin",
      "category": "productivity",
      "homepage": "https://github.com/chenyii1120/claude-sync"
    }
  ]
}
```

### 4. 從 root 移除 plugin.json

Root 的 `.claude-plugin/` 只保留 `marketplace.json`，移除 `plugin.json`。

### 5. 更新文件中的路徑引用

- `SETUP_GUIDE.md` 中的 `require('PLUGIN_ROOT/lib/sync-engine.js')` 路徑不變（PLUGIN_ROOT 會指向 plugin/ 子目錄）
- `README.md` / `README.zh-TW.md` 的架構圖需要更新
- commands/*.md 中的 `${CLAUDE_PLUGIN_ROOT}` 由 CC 注入，應該會自動指向 plugin/ 子目錄

### 6. 驗證

1. 移除現有安裝：
   ```bash
   claude plugin uninstall claude-sync
   claude plugin marketplace remove claude-sync
   ```

2. 重新安裝：
   ```bash
   claude plugin marketplace add chenyii1120/claude-sync
   claude plugin install claude-sync
   ```

3. 確認沒有 ENAMETOOLONG 錯誤
4. 確認 `/sync-init`、`/sync-push`、`/sync-pull` 都能正常運作
5. 確認 `~/.claude/plugins/cache/claude-sync/` 下沒有遞迴目錄

### 7. 也支援直接安裝（不走 marketplace）

確認以下方式也能用：
```bash
claude plugin install https://github.com/chenyii1120/claude-sync.git
```

這會 clone 整個 repo，CC 應該會找到 `plugin/` 下的 plugin.json。需要驗證。

## 前置驗證（步驟 0）

在動工之前，先確認以下假設：

### 0a. `CLAUDE_PLUGIN_ROOT` 對子目錄 plugin 指向哪裡？

檢查已安裝的官方 marketplace plugin（如 superpowers），看 CC 把 `CLAUDE_PLUGIN_ROOT` 設成什麼：

```bash
# 看 superpowers 的安裝路徑
cat ~/.claude/plugins/installed_plugins.json | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.plugins['superpowers@claude-plugins-official']?.[0]?.installPath);
"
```

如果指向 `cache/claude-plugins-official/superpowers/x.x.x/`（子目錄），那我們的 `CLAUDE_PLUGIN_ROOT` 會指向 `cache/claude-sync/claude-sync/0.1.0/plugin/` — commands 裡的 `require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js')` 就能正常運作。

如果指向 repo root，計畫需要調整。

### 0b. `claude plugin install <url>` 是否支援子目錄結構？

```bash
# 在臨時目錄測試
claude plugin install https://github.com/chenyii1120/claude-sync.git
```

確認 CC 是否能從 clone 的 repo 中找到 `plugin/.claude-plugin/plugin.json`。如果不行，README 的安裝說明需要改成只支援 marketplace 方式。

### 0c. hooks.json 路徑基準

確認 hooks.json 裡的 script 路徑（如 `./session-start-check.js`）是相對於 hooks.json 所在目錄，還是相對於 plugin root。查看官方 plugin 的 hooks.json 格式。

## 注意事項

- 另一台機器（joe）的 cache 裡還是舊結構，重構後需要 `claude plugin update` 或重裝
- 開發用的 `claude plugin install /local/path` 要改成 `claude plugin install /local/path/plugin`
- README 的安裝說明如果 `install <url>` 不支援子目錄，就只保留 marketplace 方式
- 需要在沒有 SSH key 的機器上測試（joebot）確認 SSH 問題也一併解決
