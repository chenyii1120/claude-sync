# Design: sync-pin — Plugin 版本鎖定（Lockfile + Path-Source Pinned Marketplaces）

> Status: DRAFT（待核可）
> Date: 2026-07-14
> Branch: feat/sync-pin-design
> 前置驗證：已實測確認 `claude plugin install` 對 **path-source（Directory）marketplace** 不會 fetch、
> 完全依照 checked-out commit 宣告的版本安裝（隔離測試：repo 內有 0.0.2 的 HEAD，
> checkout 在 0.0.1 的 commit → 實際裝到 0.0.1，且 install 後 HEAD 未被移動）。

## 1. 目標與非目標

### 目標
- **完整復刻**：機器 A `/sync-push` 時記錄「每個 plugin 實際用的版本」，機器 B `/sync-pull` 後
  得到**一模一樣的 plugin 版本**，不受上游 marketplace HEAD 漂移影響。
- 與現有 claude-sync 設定同步**共存**：lockfile 是加層，不改變 settings/user-config 的同步語意。
- 向後相容：沒有 lockfile 的 repo、或未啟用 pin 的機器，行為與今日完全相同。

### 非目標
- 不做全機備份 / 不 vendor plugin 實體檔案進 sync repo（Phase 2 才考慮針對高風險上游的 vendor fallback）。
- 不同步 auth token、credentials、session 資料等非宣告式狀態。
- 不處理 `skills-dir`（`~/.claude/skills/` 本地 plugin）——它已由 user-config mirror sync 覆蓋。

## 2. 核心機制（已驗證的事實）

1. plugin 的安裝版本 = **marketplace repo 當下 checkout 的 `marketplace.json` 宣告的版本**。
2. `claude plugin install` **沒有**任何版本/ref 參數；`marketplace add` 也沒有 branch/tag 參數。
3. **github-source** marketplace 跟隨 default branch HEAD → 無法 pin。
4. **path-source**（本機目錄）marketplace：install 不 fetch、不動 HEAD → **checkout 到哪個 commit，
   就裝那個 commit 宣告的版本**。這是唯一可靠的 pin 槓桿。

因此：**pin = 「claude-sync 管理的本機完整 clone，checkout 在鎖定 commit，註冊為 path-source marketplace」**。

## 3. Lockfile 格式

新增檔案：sync repo 的 `global/plugins.lock.json`（跟著現有 push/pull 一起進版控）。

```json
{
  "version": 1,
  "generatedAt": "2026-07-14T00:00:00Z",
  "generatedBy": "machine-a",
  "marketplaces": {
    "everything-claude-code": {
      "url": "https://github.com/affaan-m/everything-claude-code.git",
      "pinnedCommit": "e4e94a7e70f124caea5847fff5a644c988da7b90",
      "refHint": "v1.4.1"
    }
  },
  "plugins": {
    "ecc@everything-claude-code": {
      "marketplace": "everything-claude-code",
      "version": "1.4.1"
    }
  }
}
```

- `pinnedCommit` 是**唯一的真相來源**；`refHint` / `version` 僅供人類閱讀與 drift 報告。
- 只記錄「當下已啟用（enabledPlugins）」的 plugin；未啟用者不進 lock。
- 舊版 claude-sync 看到這個檔案會直接忽略（它只是 `global/` 下多一個 JSON），天然向後相容。

## 4. 本機受管 clone 目錄

```
~/.claude/sync/pinned-marketplaces/<marketplace-name>/   ← 完整 clone（非 shallow）
```

- 由 claude-sync 全權管理：clone、fetch、checkout（detached HEAD at pinnedCommit）。
- 以 `claude plugin marketplace add <此路徑>` 註冊 → CLI 視為 Directory（path-source）。
- **絕不**對這些 marketplace 執行 `claude plugin marketplace update`（那是唯一會把 checkout 帶走的操作）。
- 用完整 clone 而非 shallow/partial：pin 的重點是「離線可重現」，不能讓 checkout 依賴網路補 blob。
- 路徑在 `~/.claude/sync/` 下，現有 `transformPathsForExport/Import` 的 `$HOME` 轉換自然覆蓋，
  跨機器路徑差異不是問題。

## 5. Push 流程變更

新增 engine 函式 `exportPluginLock()`，在 `exportAll()` 內、`exportPluginConfigs()` 之後呼叫：

1. 讀 `settings.json` 的 `enabledPlugins` → 得出要鎖的 plugin 集合。
   **全自動、零手動列舉**：所有啟用中的 plugin 一律入鎖，語意同 `package-lock.json` 的整包快照。
2. 每個 plugin 的 commit 來源（優先序）：
   a. `installed_plugins.json` 該 plugin 條目的 **`gitCommitSha`**（CLI 在安裝當下記錄的
      marketplace commit——這是「實際裝進去的版本」，即使 marketplace clone 後來被 update 也不受影響）；
   b. 退而求其次：該 marketplace 本機 clone 的 `git rev-parse HEAD`
      （優先 `pinned-marketplaces/<name>`，否則 `known_marketplaces.json` 的 `installLocation`）。
3. 將 commit 寫入 lockfile。
4. 兩個來源都取不到 → 該 plugin 記入 `unlockable` 清單，
   push 結果回報警告，**不阻擋 push**（該 plugin 維持今日的「裝 HEAD」行為）。

語意：**push 的機器說了算**。你在體驗好的那台 push，鎖到的就是那台的體驗；
github-source 跟著 HEAD 走的機器 push 時，鎖到的就是它當下的 HEAD——這正是「復刻當下體驗」的定義。

## 6. Pull 流程變更（取代現有第 8 步的一部分）

新增 engine 函式 `previewPluginLock()` 與 `applyPluginLock()`：

### previewPluginLock()（唯讀，給 sync-pull.md 顯示計畫用）
產出 drift 報告：

| plugin | 目前版本 | 鎖定版本 | 動作 |
|---|---|---|---|
| ecc@everything-claude-code | 2.0.0 | 1.4.1 | reinstall @ e4e94a7 |

### applyPluginLock()（使用者確認後執行）
對 lockfile 中每個 marketplace：
1. `pinned-marketplaces/<name>` 不存在 → `git clone <url>`（完整 clone，URL 先過 `validateRemoteUrl`）。
2. `git cat-file -e <pinnedCommit>` 失敗 → `git fetch origin`；再失敗 →
   標記 **unreproducible**（上游歷史被改寫），回報並跳過，**不動現有安裝**。
3. `git checkout --detach <pinnedCommit>`。
4. 該 marketplace 尚未註冊、或註冊的 source 不是這個路徑 → 遷移（見 §7）。
5. 對每個 lock 內 plugin：實際安裝版本 ≠ 鎖定版本 → `claude plugin uninstall` + `claude plugin install`
   （V-3 驗證後若 install 可直接原地換版，則省略 uninstall）。

### 確認語意（沿用 B-02 精神）
改變 plugin 版本 = 改變可執行程式碼，**一律先顯示 drift 表、經 AskUserQuestion 確認才 apply**。
使用者可逐 marketplace 選擇 apply / skip；skip 者下次 pull 再議，不推進任何狀態。

## 7. 遷移：github-source → path-source（一次性，每台機器）

新增 `migrateMarketplaceToPinned(name)`：

1. 從 `known_marketplaces.json` 取得 `url` 與現有 `installLocation` 的 HEAD commit。
2. clone 到 `pinned-marketplaces/<name>`，checkout 該 commit。
3. `claude plugin marketplace remove <name>` → `claude plugin marketplace add <pinned path>`。
   **關鍵**：新 marketplace 名稱必須與舊名相同（名稱來自 marketplace.json 的 `name` 欄位，
   同一 repo 內容 → 同名），這樣 `plugin@marketplace` 的 id 不變，enabledPlugins 不需改寫。
4. 重裝該 marketplace 下所有已啟用 plugin。

⚠️ 此步驟依賴 V-1、V-2（見 §10）的驗證結果，實作前必須先實測。

## 8. 版本升級的正確姿勢

不再用 `claude plugin update`（會漂到 HEAD 且繞過 lock）。升級流程：

1. 在任一台機器：`git -C pinned-marketplaces/<name> fetch` → `checkout <新 tag/commit>` → 重裝 plugin。
2. 實際用過、確認體驗 OK。
3. `/sync-push` → lockfile 記入新 SHA → 其他機器下次 pull 依 §6 跟上。

提供新 command `/sync-pin` 輔助（薄封裝）：
- `/sync-pin status` — 顯示 lock vs 實際的 drift 表。
- `/sync-pin set <marketplace> <ref>` — fetch + 解析 ref 為 SHA + checkout + 重裝 + 提示 push。

## 9. 護欄與邊界

- **drift 偵測**：`getStatus()` / `previewPull()` 增列 lock drift（pinned clone 的 HEAD ≠ lock、
  或安裝版本 ≠ lock）。本機主動改版視為「local change」，走現有 push-first / merge 決策流。
- **unreproducible pin**（上游 force-push 清史）：回報明確錯誤與該 SHA，提示三選一：
  改 pin 新 commit / 維持現狀 / （Phase 2）vendor fallback。
- **`installed_plugins.json` / `known_marketplaces.json`**：維持現有同步（operational metadata），
  但版本真相以 lockfile 為準；文件註明兩者衝突時 lockfile 贏。
- **安全**：clone URL 必過既有 `validateRemoteUrl`；lockfile 進 smart-merge 的 JSON 欄位合併
  （`MERGE_JSON_FILES` 加入 `global/plugins.lock.json`），衝突時遵循現有 merge 語意（遠端贏 + 備份）。
- **預設開啟（opt-out）**：`config.json` 的 `pinPlugins` **預設為 `true`**。
  設為 `false` 的機器：push 不寫 lock、pull 忽略 lock（並提示「remote 有 lockfile，
  可在 config 開啟 pinPlugins 以啟用」）。
- **知情同意**：
  - `/sync-init` 流程中以 AskUserQuestion 詢問「要啟用 plugin 版本鎖定嗎？（預設：是）」，
    把答案寫入 config，讓使用者第一天就知道這個行為存在。
  - 既有安裝（config 內尚無 `pinPlugins` 欄位）在**首次 push** 時同樣詢問一次並寫入 config，
    之後不再打擾。
  - README 必須有專節說明：預設鎖定、行為是什麼、以及不想鎖定時改
    `config.json` 的 `pinPlugins: false` 即可（見 §11 Phase 1A 交付項）。

## 10. 實作前必驗證清單（V-*）

| # | 問題 | 若答案不利的影響 |
|---|---|---|
| V-1 | `marketplace remove` 會不會 uninstall/disable 其下 plugins？ | 遷移順序需改為先記錄狀態、移除後重建 |
| V-2 | 同名 marketplace remove 後以 path 重新 add，既有 `plugin@marketplace` id 是否無縫？ | 需改寫 enabledPlugins，遷移複雜度上升 |
| V-3 | 已安裝不同版本時 `plugin install` 會原地換版還是需先 uninstall？ | 決定 §6 步驟 5 的實作 |
| V-4 | enable/disable 狀態在 reinstall 後是否保留？ | 需在 reinstall 前後快照/回填 enabledPlugins |

## 11. 分階段實作（每階段獨立完成 + 測試後才進下一階段）

- **Phase 1A — 記錄（無行為變更）**：`exportPluginLock()` + push 時寫 lockfile
  （`pinPlugins` 預設 `true`，見 §9）；`/sync-status` 顯示 drift 表。
  交付項含知情同意與文件：
  - `/sync-init` 與首次 push 的 AskUserQuestion 詢問（答案寫入 config）。
  - README.md 與 README.zh-TW.md 新增「Plugin 版本鎖定」專節：預設開啟、
    行為說明、不想鎖定改 `config.json` 的 `pinPlugins: false`。
  純新增，零風險。單元測試：lockfile 產出、path transform、缺 clone 的 unlockable 警告、
  `pinPlugins: false` 時不寫 lock。
- **Phase 1B — 套用**：V-1〜V-4 實測 → `previewPluginLock()` / `applyPluginLock()` +
  sync-pull.md 的確認流程。測試：checkout/fetch/unreproducible 各分支、確認流程的 apply/skip。
- **Phase 1C — 遷移**：`migrateMarketplaceToPinned()` + `/sync-pin` command。
  在本機用 ECC（pin 到 v1.4.1 = `e4e94a7`）做端到端驗收——這同時直接解決使用者的原始需求。
- **Phase 2（選配）— vendor fallback**：對標記 `vendor: true` 的 marketplace 在 sync repo 存
  `git bundle`（單檔、不炸 repo 歷史、不含巢狀 .git），unreproducible 時從 bundle 還原。

## 12. 已否決的替代方案（記錄決策脈絡）

| 方案 | 否決原因 |
|---|---|
| 全檔備份 `~/.claude`（含 cache）進 sync repo | 秘密外洩、repo 爆肥、巢狀 .git、絕對路徑、與 plugin manager 打架、merge 無解 |
| 靠 github-source + 希望 install 不更新 | CLI 無 ref 參數，marketplace update / 任何刷新都會漂到 HEAD |
| 只 pin `installed_plugins.json` 裡的版本字串 | 那只是 metadata，重裝時 CLI 仍照 marketplace 當下狀態安裝 |
