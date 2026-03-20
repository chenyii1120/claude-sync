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

## 注意事項

- `${CLAUDE_PLUGIN_ROOT}` 在 commands 中的值會從 repo root 變成 `plugin/`，所有 `require()` 路徑應該不受影響
- hooks/hooks.json 裡的相對路徑要確認是否正確
- 需要在沒有 SSH key 的機器上測試（joebot）確認 SSH 問題也一併解決
