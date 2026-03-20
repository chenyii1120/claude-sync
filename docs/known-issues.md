# 已知問題清單

## 1. [已修復] pull() 覆蓋遠端 plugin 記錄
- **修復**: bec42fc — mergeJsonFields 加入遞迴 merge
- **狀態**: 已修復

## 2. [Bug] diff 函式比較對象錯誤
- **嚴重程度**: High
- **問題**: `diffSettings()` 和 `diffPluginConfigs()` 比較的是 local `~/.claude/` vs 本地 repo HEAD，而不是 vs `origin/main`
- **影響**: pull 前的 diff 預覽看不到遠端的新變更，給使用者錯誤的「沒什麼差異」印象
- **修法**: diff 函式應該在 fetch 後比較 local 和 `origin/main` 的內容（用 `safeGitShow('origin/main', file)` 讀取遠端版本）

## 3. [Bug] pull 前的 export+commit 可能汙染 merge-base
- **嚴重程度**: High
- **問題**: `pull()` 在 fetch 前先 `exportAll()` + `commit`，這個 commit 改變了 HEAD，影響 `merge-base` 的計算
- **場景**:
  - 上次 push 後本地 settings 有變更
  - pull 前 export+commit 產生新的 local commit
  - merge-base 可能指向錯誤的祖先
  - smart merge 的 base/local/remote 三方比較可能不正確
- **修法**: 考慮用 `safeGitShow` 直接指定 ref 來讀取三方內容，而非依賴 merge-base：
  - base = 上次 push 的 commit（可從 last-sync.json 記錄）
  - local = 剛 export+commit 的 HEAD
  - remote = origin/main
  - 或者：先 fetch，再 export+commit，確保 merge-base 計算正確

## 4. [Bug] CC plugin install 強制 SSH（CC 的 bug，非我們的）
- **嚴重程度**: High（影響所有沒有 SSH key 的使用者）
- **問題**: CC 的 `plugin install` 無視 source 裡的 HTTPS URL，強制用 SSH clone
- **相關 issues**: anthropics/claude-code#29722, #31930, #26588, #28012
- **Workaround**: `git config --global url."https://github.com/".insteadOf "git@github.com:"`
- **我們的處置**: README 已加 troubleshooting 提示

## 5. [Limitation] marketplace.json source "./" 依賴 SSH
- **嚴重程度**: Medium
- **問題**: `"source": "./"` 是正確的（避免遞迴 cache），但 CC 處理 `"./"` 時仍嘗試 SSH clone 而非本地複製
- **關聯**: 這是 #4 的延伸，根因相同
- **Workaround**: 同 #4

## 6. [Missing] plugin 更新後 marketplace cache 不同步
- **嚴重程度**: Medium
- **問題**: `claude plugin update` 只更新 plugin cache，不更新 marketplace cache。如果 marketplace.json 結構變了（如 source 格式改變），使用者必須手動 `marketplace remove` + `add`
- **影響**: 使用者以為 update 就夠了，但實際上 marketplace 還是舊版
- **建議**: README 的更新指引中說明這一點

## 7. [Enhancement] settings.json 的 diff 應用 deep merge 邏輯
- **嚴重程度**: Low
- **問題**: `diffSettings()` 只做 top-level key 比較，但 `mergeJsonFields` 現在支援 recursive merge。diff 預覽的粒度和實際 merge 粒度不一致
- **例子**: `permissions` 物件在 diff 裡顯示為整個物件不同，但 merge 時會遞迴比較子 key
- **修法**: diff 也用 recursive 比較顯示，或至少標註「會自動合併子欄位」
