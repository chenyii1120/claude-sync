# claude-sync 問題清單與修正計畫

> 審查日期：2026-07-07
> 審查範圍：`lib/sync-engine.js`、`hooks/`、`commands/`、`.claude-plugin/`、`docs/known-issues.md`
> 用途：交給實作 agent 逐項修正。每個問題附「修正計畫」與「驗證方式」，實作時**一次只處理一個編號**，修完跑驗證再進下一個。
>
> 與 `docs/known-issues.md` 的關係：該檔的 #2（diff 比較對象錯誤）在本文件擴充為 C-01；#4/#5/#6 是 Claude Code 本身的 bug/限制，不在本文件範圍；#3 描述的行為已不存在，見 E-01。

## 嚴重度總覽

| 編號 | 嚴重度 | 類型 | 標題 | 主要檔案 |
|------|--------|------|------|----------|
| A-01 | Critical | 正確性 | 本地刪除的 user-config 檔案不會同步，且會在 pull 後復活 | lib/sync-engine.js |
| A-02 | High | 正確性 | pull 永遠不會回報 up-to-date（import 無條件回報 changes） | lib/sync-engine.js |
| A-03 | High | 資料遺失 | safe pull 的 delta 檢查排除 plugin-data，但 import 會鏡像刪除本地較新的 plugin 資料 | lib/sync-engine.js |
| A-04 | High | 正確性 | settings.json 未做路徑轉換，絕對路徑在其他機器上失效 | lib/sync-engine.js |
| A-05 | Medium | 正確性 | 本地 ahead 時誤報「遠端有 0 個更新」 | lib/sync-engine.js, hooks/session-start-check.js |
| A-06 | Medium | 正確性 | 刪除 CLAUDE.md / settings.json 鍵值的行為不對稱、不傳播 | lib/sync-engine.js |
| B-01 | High | 安全 | git 指令以字串組合執行，存在命令注入（remoteUrl、hostname、git identity） | lib/sync-engine.js |
| B-02 | High | 安全 | pull 會在使用者確認前就套用 hooks/skills 等可執行內容；skill 流程順序矛盾 | lib/sync-engine.js, commands/sync-pull.md |
| B-03 | Medium | 安全 | 遠端新增的目錄會自動匯入本地，無本地 opt-in | lib/sync-engine.js |
| B-04 | Medium | 安全 | settings.json 的 env 可能含 secrets，push 前無警告 | lib/sync-engine.js, commands/sync-push.md |
| C-01 | High | 正確性 | 四個 diff 函式比較的是本地 clone HEAD，不是 origin/main | lib/sync-engine.js |
| C-02 | Medium | 穩健性 | init() 失敗不清理，殘留 REPO_DIR 導致重試永遠失敗；分支名 hardcode main | lib/sync-engine.js |
| C-03 | Medium | 穩健性 | lock 無 stale 偵測，crash 後永久卡死 | lib/sync-engine.js |
| C-04 | Medium | 穩健性 | 多處 JSON.parse 無防護，壞掉的 JSON 讓所有指令 crash | lib/sync-engine.js |
| C-05 | Medium | 穩健性 | session-end hook 的 10 秒 safety timeout 完全無效 | hooks/session-end-check.js |
| C-06 | Medium | 穩健性 | getStatus() 無鎖操作 repo 並執行 `clean -fd`，與並行 push 有競態 | lib/sync-engine.js |
| C-07 | Low | 穩健性 | performSmartMerge 的 `merge --abort` 在沒有 merge 進行時會拋錯 | lib/sync-engine.js |
| C-08 | Low | 相容性 | 使用 `process.env.HOME`，Windows 上為 undefined | lib/sync-engine.js, hooks/*.js |
| C-09 | Low | 穩健性 | copyDirSync 不處理 symlink 與二進位檔比較用 utf8 | lib/sync-engine.js |
| D-01 | Medium | UX | .DS_Store 等垃圾檔被同步進 repo，導致永遠顯示「有未推送變更」 | lib/sync-engine.js |
| D-02 | Low | UX | 每次 pull（含被拒絕、up-to-date）都建立備份，會把重要備份擠出 5 份輪替 | lib/sync-engine.js |
| D-03 | Medium | 一致性 | detectMissingPlugins 回傳值缺 marketplace 資訊，skill 卻要求 `<plugin>@<marketplace>` | lib/sync-engine.js, commands/sync-pull.md |
| D-04 | Low | 一致性 | sync-push.md 衝突解決片段直接 commit+push，但不更新 last-sync.json | commands/sync-push.md |
| D-05 | Low | 清理 | MAPPING_PATH 宣告後從未使用 | lib/sync-engine.js |
| E-01 | Low | 文件 | known-issues.md #3 描述的 pull 行為已不存在（doc rot） | docs/known-issues.md |
| F-01 | High | 測試 | 專案完全沒有測試與 package.json | 全專案 |

---

## A. 正確性 / 資料遺失

### A-01 [Critical] 本地刪除的 user-config 檔案不會同步，且會在 pull 後復活

**位置**：`lib/sync-engine.js:266-287`（`exportUserConfig`）

**問題**：`exportUserConfig()` 只對「整個目錄」做 stale sweep（移除不在 active set 的目錄），但對每個同步目錄內部只呼叫 `copyDirSync()`（純覆蓋新增，不刪除）。對比：`exportPluginData()` 有呼叫 `removeStalePaths()`，`exportUserConfig()` 沒有。

**後果鏈**：
1. 使用者刪除本地 `~/.claude/rules/foo.md`。
2. `/sync-push`：export 不會從 repo 刪掉 `user-config/rules/foo.md`，`hasLocalChanges()` 看不到變更 → 回報 "no-changes"，刪除永遠推不出去。
3. 下次 `/sync-pull`：`importUserConfig()` 的 `removeStalePaths(src, dest)` 是鏡像匯入 → repo 裡還有 `foo.md`，於是**把使用者剛刪掉的檔案copy回來**。刪除的檔案復活。

**修正計畫**：
1. 在 `exportUserConfig()` 的 `for (const dir of dirs)` 迴圈內，`copyDirSync()` 之前對每個目錄加上 `removeStalePaths(path.join(CLAUDE_HOME, dir), path.join(configDir, dir))`。
2. 注意本地目錄不存在的情況：若 `~/.claude/<dir>` 整個不存在，應把 repo 端的 `user-config/<dir>` 移除（或至少定義清楚語意——建議：目錄在 allow list 但本地不存在 → 視為空目錄，清空 repo 端）。
3. 同理處理 `CLAUDE.md`：本地 `~/.claude/CLAUDE.md` 不存在時，刪除 repo 的 `user-config/CLAUDE.md`（見 A-06，可一起做）。

**驗證方式**：
- 手動情境測試（或寫成自動化測試，見 F-01）：init → push 一個含 2 個檔案的 rules/ → 刪除其中 1 個 → push → 檢查 repo 內該檔已消失 → pull → 確認檔案沒有復活。

---

### A-02 [High] pull 永遠不會回報 up-to-date

**位置**：`lib/sync-engine.js:498-516`（`importPluginData`）、`518-537`（`importUserConfig`）、`1097-1101`（`pull()` 的 `nothingChanged` 判斷）

**問題**：`importPluginData()` 與 `importUserConfig()` 對每個 entry 無條件 `changes.push(...)`，不管內容是否真的有差異。`importUserConfig()` 的 `CLAUDE.md` 也是無條件 push。因此只要 repo 裡有 plugin-data 或任何 user-config 目錄（正常安裝一定有），`pull()` 的 `nothingChanged` 永遠是 false，每次 pull 都回報 `pulled: true` 並列出一堆其實沒變的「changes」。

**修正計畫**：
1. 寫一個共用的「有差異才複製」helper：`syncDirReportChanges(src, dest)`，回傳實際新增/覆蓋/刪除的檔案清單（比較檔案內容，用 Buffer 比較避免二進位問題，見 C-09）。
2. `importPluginData()`、`importUserConfig()` 改用該 helper，`changes` 只收實際變動的路徑。
3. `importUserConfig()` 的 CLAUDE.md：先比較內容，相同就不複製、不回報。
4. `pull()` 的 `nothingChanged` 邏輯不用改，資料正確後它自然成立。

**驗證方式**：
- 情境測試：pull 一次 → 不做任何變更 → 再 pull → 預期 `{ pulled: false, reason: 'up-to-date' }`。

---

### A-03 [High] safe pull 會無聲刪除本地較新的 plugin 資料

**位置**：`lib/sync-engine.js:947-995`（`getLocalDelta`，註解明言排除 plugin-data）、`498-516`（`importPluginData` 的 `removeStalePaths` 鏡像刪除）

**問題**：`pull()` safe mode 靠 `getLocalDelta()` 判斷本地是否有未推送變更，但 delta 檢查刻意排除 plugin-data。而 `importPluginData()` 是鏡像匯入（`removeStalePaths(srcDir, pluginsDir, ...)`）。結果：plugin 在上次 push 之後於本地新寫入的資料檔（例如 blocklist、學習資料），safe pull 會判定「本地乾淨」然後直接鏡像刪除，無任何提示。備份雖然存在，但使用者不會知道要去還原。

**修正計畫**（三選一，建議方案 1）：
1. **改為非鏡像匯入 + 3-way 概念**：`importPluginData()` 的刪除範圍限定在「base（last-sync commit）有、remote 沒有」的檔案（表示遠端明確刪除），其餘本地多出來的檔案保留。需要用 `gitExec('ls-tree -r --name-only <base> global/plugin-data')` 取得 base 檔案清單。
2. 或：把 plugin-data 納入 `getLocalDelta()` 檢查（接受註解所說的 false positive 代價），讓 safe mode 會擋下來。
3. 或：`importPluginData()` 移除 `removeStalePaths`，改為純覆蓋（刪除永不傳播，最保守但最簡單）。
2/3 擇一時要在 README 說明語意。

**驗證方式**：
- 情境測試：push → 在 `~/.claude/plugins/` 下新增一個非 exclude 的檔案 → 從另一端推一個無關變更 → pull → 確認新增檔案仍存在。

---

### A-04 [High] settings.json 未做路徑轉換，絕對路徑在其他機器上失效

**位置**：`lib/sync-engine.js:184-195`（`exportSettings`）、`420-460`（`importSettings`）

**問題**：`transformPathsForExport/Import`（把 `$HOME/.claude` 換成 `${CLAUDE_HOME}` 占位符）只套用在 plugin config 上。`settings.json` 的 hooks command、mcp 相關設定常含 `/Users/joe/.claude/...` 之類的絕對路徑，同步到 username 不同的機器後全部失效。`commands/sync-init.md` 第 6 步甚至已經意識到 hooks 引用 `$HOME/.claude/<dir>` 的問題，但引擎端沒有對應處理。

**修正計畫**：
1. `exportSettings()` 寫檔前套 `transformPathsForExport(filtered)`。
2. `importSettings()` 讀 `repoSettings` 後套 `transformPathsForImport(remote)`；`readJsonAtRef` 讀回來的 base 也要套（與 `importPluginConfigs` 現行做法一致）。
3. `diffSettings()`、`getLocalDelta()` 中所有讀 repo/base 側 settings 的地方同步套用，否則會出現永遠 diff 不掉的假差異。
4. **遷移相容**：已存在的 repo 中 `global/settings.json` 是未轉換的舊格式。import 時對「內容剛好等於本機 CLAUDE_HOME」的字串轉換是無害的；但另一台機器上殘留的他機絕對路徑無法自動辨識。可接受：修正後第一次 push 會整批正規化。在 README 註記一句即可。

**驗證方式**：
- 情境測試：settings.json 放一個含 `~/.claude` 絕對路徑的 hook command → push → 檢查 repo 檔案內是 `${CLAUDE_HOME}` → pull 回來還原成本機路徑。

---

### A-05 [Medium] 本地 ahead 時誤報「遠端有 0 個更新」

**位置**：`lib/sync-engine.js:58-66`（`hasRemoteUpdates`/`getRemoteUpdateCount`）、`hooks/session-start-check.js:25-34`

**問題**：兩處都用「`HEAD` hash ≠ `origin/main` hash」判斷遠端有更新。當本地有已 commit 未 push 的變更（例如 push 到一半網路斷掉）時，hash 不同但 `rev-list HEAD..origin/main --count` 是 0，session-start hook 會顯示「遠端有 0 個更新。執行 /sync-pull 來同步」——訊息錯誤且誤導使用者去 pull。

**修正計畫**：
1. `session-start-check.js`：直接以 `rev-list HEAD..origin/main --count` 的數字判斷，`count > 0` 才輸出通知。可另加：`rev-list origin/main..HEAD --count > 0` 時提示「本地有未推送的 commit，執行 /sync-push」。
2. `hasRemoteUpdates()` 改為 `getRemoteUpdateCount() > 0`；`getStatus()` 邏輯不變。

**驗證方式**：
- 情境測試：在 sync repo 手動做一個本地 commit 不 push → 跑 session-start-check.js → 不應出現「遠端有更新」訊息。

---

### A-06 [Medium] 刪除行為不對稱：CLAUDE.md 與 settings.json 的檔案級刪除不傳播

**位置**：`lib/sync-engine.js:282-287`（CLAUDE.md export）、`184-195`（settings export）

**問題**：
- 本地刪除 `~/.claude/CLAUDE.md` 後，repo 的 `user-config/CLAUDE.md` 永遠留著，pull 又會把它復活（同 A-01 模式）。
- 本地 `settings.json` 整個檔案刪除時，`exportSettings()` 直接 return，repo 端保留舊檔，pull 復活。

**修正計畫**（建議與 A-01 同一個 PR 處理）：
1. `exportUserConfig()`：本地 CLAUDE.md 不存在時 `fs.rmSync(path.join(configDir, 'CLAUDE.md'), { force: true })`。
2. `exportSettings()`：本地 settings.json 不存在時刪除 repo 的 `global/settings.json`（或寫入 `{}`，擇一並保持 import 端語意一致）。
3. import 端對應：repo 端沒有 CLAUDE.md 時是否刪本地？依 3-way 原則——base 有、remote 沒有 → 刪；base 沒有 → 不動。若嫌複雜，第一版可以只修 export 端並在文件註明「檔案級刪除以 push 端為準」。

**驗證方式**：情境測試同 A-01，改用 CLAUDE.md。

---

## B. 安全

### B-01 [High] git 指令字串組合，存在命令注入

**位置**：`lib/sync-engine.js:44-47`（`gitExec`）、`891-894`（`init` 的 clone）、`877-889`（`ensureGitIdentity`）、`922-924`（commit message 含 hostname）

**問題**：
- `init(remoteUrl)`：`` execSync(`git clone "${remoteUrl}" "${REPO_DIR}"`) ``。remoteUrl 來自使用者輸入（sync-init skill 直接代入），含 `"`、`$()`、反引號即可注入 shell；以 `-` 開頭可被當成 git 選項（`--upload-pack=...` 可執行任意指令）；`ext::` 協定 URL 會讓 git 自己執行任意指令。
- `ensureGitIdentity()`：把全域 git user.name/email 插進 shell 字串。
- `` gitExec(`commit -m "sync from ${hostname} ..."`) ``：hostname 含特殊字元會壞。

**修正計畫**：
1. 新增 `gitExecFile(args: string[], opts)`，內部用 `child_process.execFileSync('git', args, opts)`（不經 shell）。逐步把所有 `gitExec`/`execSync` 呼叫點換成陣列參數形式。呼叫點固定字串的（如 `['rev-parse', 'HEAD']`）機械替換即可。
2. `init()`：clone 改 `execFileSync('git', ['clone', '--', remoteUrl, REPO_DIR], ...)`（`--` 阻擋 option injection）。
3. 對 remoteUrl 做 allow-list 驗證：只接受 `https://`、`ssh://`、`git@host:path` 形式；拒絕 `ext::` 等其他協定（`file://`/本地路徑可允許但要明確判斷）。驗證失敗丟出清楚的錯誤訊息。
4. commit message、user.name/email 一律走 execFileSync 參數，不再插值進 shell 字串。
5. `safeGitShow` 的 `ref`/`filePath` 也是插值（ref 來自內部、filePath 來自目錄掃描，風險低但一併改）。

**驗證方式**：
- 單元測試：`init('https://x/y"; touch /tmp/pwned; "')` 應被拒絕或安全處理；`init('--upload-pack=touch /tmp/pwned')` 應被拒絕。
- 全部指令替換後跑一次完整 init/push/pull 情境測試確認無 regression。

---

### B-02 [High] pull 在使用者確認前就套用可執行內容；skill 流程順序矛盾

**位置**：`commands/sync-pull.md` 步驟 4 vs 步驟 6；`lib/sync-engine.js`（`importAll` 一次性套用）

**問題**：sync-pull.md 步驟 6 說「rules/、skills/、hooks/ 的變更要先顯示完整 diff、使用者明確確認後才套用（可能含可執行程式碼）」，但步驟 4 的 `pull()` 是一次把所有東西（含 hooks/skills）套進 `~/.claude`。等到步驟 6 時早已套用完畢，確認流程形同虛設。遠端 repo 被入侵時，惡意 hook 會在下個 session 自動執行。

**修正計畫**：
1. 引擎端新增選擇性匯入能力：`pull({ mode, exclude: ['hooks', 'skills', ...] })` 或兩段式 API——`pullPreview()` 回傳將變更的檔案清單與 diff（可重用 C-01 修好的 diff 函式），`pullApply({ dirs })` 按目錄套用。建議實作：`importUserConfig(options)` 增加 `only`/`exclude` 參數，`pull()` 透傳。
2. 更新 `commands/sync-pull.md` 流程：先 pull 排除 hooks/skills/rules → 顯示這三類的 diff → 使用者確認後再跑第二次 `pull({ only: [...] })`（或單一 `applyUserConfigDirs(['hooks'])` helper）。
3. 兩次呼叫之間 last-sync commitHash 的更新時機要小心：全部套用完才寫入新的 commitHash，否則使用者拒絕第二段時 base 記錄會超前。建議 pull() 增加 `deferLastSync` 選項或由第二段 API 負責寫入。

**驗證方式**：
- 情境測試：遠端加一個新 hook 檔 → pull → 確認 hooks 未落地、diff 有列出 → 執行 apply → 落地。

---

### B-03 [Medium] 遠端新增的目錄會自動匯入本地，無本地 opt-in

**位置**：`lib/sync-engine.js:123-132`（`getSyncDirsForImport`）

**問題**：import 端的目錄集合是「repo 裡有什麼就匯什麼」（註解說是刻意設計，讓另一台機器新增的目錄自動流入）。這代表任何能寫入 sync repo 的人（或被入侵的 repo）可以塞任意目錄名（只要不在 SYSTEM_EXCLUDE_DIRS），內容直接落地到 `~/.claude/<dir>`。與 push 端的 allow/skip 詢問機制不對稱。

**修正計畫**：
1. `getSyncDirsForImport()` 改為與 export 同一個 allow 集合（`DEFAULT_USER_CONFIG_DIRS` + `config.allowSyncDirs` − skip − system exclude），repo 中多出來的目錄回傳為 `unknownRemoteDirs` 清單而不匯入。
2. `pull()` 結果加上 `unknownRemoteDirs` 欄位；`commands/sync-pull.md` 加一步：對每個 unknown remote dir 詢問使用者 add/skip（重用 `addAllowSyncDir`/`addSkipSyncDir`），確認後再匯入該目錄。
3. 原「自動流入」行為的註解與 README 說明同步更新。

**驗證方式**：情境測試：repo 端手動加 `user-config/evil/x.sh` → pull → `~/.claude/evil/` 不存在、結果含 `unknownRemoteDirs: ['evil']`。

---

### B-04 [Medium] settings.json 可能含 secrets，push 前無警告

**位置**：`lib/sync-engine.js:184-195`（`exportSettings`）、`commands/sync-push.md`

**問題**：settings.json 的 `env` 欄位常放 API keys。claude-sync 會把它原封不動推到 git remote（GitHub）。私有 repo 仍是外洩面（token 換手、repo 誤設公開）。目前完全沒有警告或過濾機制。

**修正計畫**：
1. 引擎加 `scanForSecrets(settingsObj)` helper：對 `env` 下的 key 名稱做 pattern 檢查（`/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i`）與 value 形態檢查（`sk-`、`ghp_` 等常見前綴），回傳疑似清單。
2. `push()` 結果加上 `secretWarnings` 欄位（不阻擋，只回報）。
3. `commands/sync-push.md` 加一步：`secretWarnings` 非空時警告使用者，並提供選項——(a) 照推（私有 repo 自負風險）、(b) 把該 key 加入排除清單後重推。
4. （可選、較大）把 `SETTINGS_BLACKLIST` 從 hardcode 常數改為 config 可擴充：`config.settingsExcludeKeys`，支援 `env.OPENAI_API_KEY` 這種點路徑。B-04 先做 1-3 即可，4 開獨立任務。

**驗證方式**：單元測試 `scanForSecrets`；情境測試 push 時有告警輸出。

---

## C. 穩健性 / 相容性

### C-01 [High] 四個 diff 函式比較對象是本地 clone HEAD，不是 origin/main

**位置**：`lib/sync-engine.js:724-843`（`diffSettings`、`diffPluginConfigs`、`diffUserConfig`、`diffPluginData`）

**問題**：known-issues.md #2 已記錄 `diffSettings`/`diffPluginConfigs`，實際上 `diffUserConfig` 和 `diffPluginData` 也一樣——它們讀的是 `REPO_DIR` 工作樹（= 上次 pull/push 後的 HEAD），不是 fetch 下來的 `origin/main`。`/sync-diff` 雖然先 `gitFetch`，但 fetch 不會動工作樹，所以「遠端側」顯示的是舊資料，pull 前的預覽會漏掉遠端新變更。

**修正計畫**：
1. 四個 diff 函式的「remote 側」改為讀 `origin/main`：
   - JSON 檔用現成的 `safeGitShow('origin/main', <path>)` + `JSON.parse`。
   - 目錄樹用 `gitExec('ls-tree -r --name-only origin/main -- user-config/<dir>')` 列檔案、`safeGitShow` 讀內容。寫一個共用 helper `listFilesAtRef(ref, prefix)` 取代 remote 側的 `listFilesRecursive(repoDir)`。
2. 函式簽名可加 `ref = 'origin/main'` 參數，預設 origin/main、必要時可傳 `'HEAD'` 保留舊行為給內部呼叫。
3. 呼叫端（commands/sync-diff.md、sync-pull.md）不需要改流程，但確認 diff 前都有 `gitFetch`。
4. 順帶處理 known-issues #7：`diffSettings` 對 object 值做遞迴比較，輸出粒度與 `mergeJsonFields` 對齊（列出子 key 差異）。此項可拆為獨立小任務。

**驗證方式**：情境測試：兩個 clone，A 推一個 settings 變更 → B fetch 後跑 diff（不 pull）→ diff 應顯示該變更。

---

### C-02 [Medium] init() 失敗不清理；分支名 hardcode main

**位置**：`lib/sync-engine.js:891-912`（`init`）

**問題**：
1. `init()` 中 clone 成功後任何一步失敗（例如空 repo + 使用者 git `init.defaultBranch=master` → `push origin main` 失敗），`saveConfig` 還沒執行，但 `REPO_DIR` 已存在。`isInitialized()` 回 false，使用者重跑 `/sync-init` 時 `git clone` 因目標目錄已存在而失敗，卡死，需要手動 `rm -rf ~/.claude/sync`。
2. 整個引擎 hardcode `main`（fetch/push/rev-parse origin/main 共 10+ 處）。遠端預設分支是 `master` 的既有 repo 完全不能用。

**修正計畫**：
1. `init()` 用 try/catch 包住 clone 之後的所有步驟，失敗時 `fs.rmSync(REPO_DIR, { recursive: true, force: true })` 再 rethrow。
2. clone 前若 `REPO_DIR` 已存在但 `CONFIG_PATH` 不存在（上次失敗殘留），先清掉再 clone。
3. 分支偵測：clone 後用 `git symbolic-ref refs/remotes/origin/HEAD --short`（fallback：空 repo 時取 `git config init.defaultBranch` || 'main'）取得分支名，存入 config（`config.branch`）。引擎所有 `origin/main`、`push origin main`、`fetch origin main` 改讀 config；提供 `getBranch()` helper，config 無值時預設 'main'（向後相容既有安裝）。
4. 空 repo 情境：commit 前 `git checkout -B <branch>` 確保分支名一致。
5. `hooks/session-start-check.js` 內 hardcode 的 origin/main 也要改（可簡單讀 config.json 的 branch 欄位）。

**驗證方式**：
- 情境測試：對空 repo 且 `git config --global init.defaultBranch master` 的環境 init → 成功；中途弄失敗（斷網）→ 重跑 init → 成功不卡死。
- 既有 config（無 branch 欄位）→ 一切照舊。

---

### C-03 [Medium] lock 無 stale 偵測

**位置**：`lib/sync-engine.js:167-178`

**問題**：`acquireLock()` 用 mkdir 原子性，但行程 crash（或被 kill）後 lock 目錄殘留，之後所有 push/pull 永遠回「Another sync operation is in progress」，只能手動刪 `~/.claude/sync/.sync.lock`。

**修正計畫**：
1. lock 目錄內寫一個 `meta.json`：`{ pid, startedAt }`。
2. `acquireLock()` 失敗時讀 meta：
   - `process.kill(pid, 0)` 拋 ESRCH（行程不存在）→ 視為 stale，刪除後重試一次。
   - 行程存在但 `startedAt` 超過門檻（如 10 分鐘）→ 一樣視為 stale（sync 操作不該跑這麼久）。
3. 錯誤訊息加上 lock 路徑與手動解法提示。

**驗證方式**：單元測試：手動建 lock + 假 meta（不存在的 pid）→ acquireLock 應成功；正常並行時第二個呼叫應失敗。

---

### C-04 [Medium] JSON.parse 無防護

**位置**：`lib/sync-engine.js` 多處：`loadConfig`(86-89)、`loadLastSync`(96-99)、`exportSettings`(187)、`exportPluginConfigs`(214)、`importSettings`(425,428)、`importPluginConfigs`(469,473)、`diffSettings`(728-729)、`diffPluginConfigs`(746,748)、`getLocalDelta`(959,974)、`detectMissingPlugins`(557)、`detectMissingMarketplaces`(574)

**問題**：任何一個 JSON 檔（本地 settings.json、config.json、repo 內檔案）語法壞掉，所有指令直接 throw SyntaxError，錯誤訊息對使用者不可讀；hooks 雖有 catch 但會靜默失效。

**修正計畫**：
1. 加共用 helper：`readJsonFile(filePath, { fallback, required })`——parse 失敗時：`required: true` 丟出含檔案路徑的友善錯誤（「settings.json 格式錯誤：<path>，請修復後重試」）；否則回 fallback 並可選擇收集 warning。
2. 逐一替換上列呼叫點。原則：**來源側**（要讀來合併/推送的本地檔）壞掉必須 fail fast 並指名檔案，絕不能拿 `{}` 去 merge（否則會把「壞檔」當成「全刪除」推播出去）；**輔助側**（last-sync.json、config.json）壞掉可以 fallback，但要在結果中回報 warning。
3. `loadLastSync` 壞掉時 fallback `{}` 等同遺失 base → pull 會走無 base 的 overlay 路徑，行為安全，可接受，但回報 warning。

**驗證方式**：單元測試：各檔案塞非法 JSON，確認錯誤訊息含路徑、merge 不會把空物件當基準推送。

---

### C-05 [Medium] session-end hook 的 10 秒 safety timeout 無效

**位置**：`hooks/session-end-check.js:6`

**問題**：`setTimeout(...).unref()` 有兩個問題疊加：(1) `execSync` 阻塞 event loop，timer 到期也不會執行；(2) `.unref()` 讓 timer 不阻止行程退出，等於這個 timer 永遠不會發揮「強制退出」作用。實際效果：autoPush 路徑的 `push()` 內含 fetch（預設 30s timeout）、smart merge、push，一路阻塞可達分鐘級，Claude Code 關閉時被 hook 卡住。

**修正計畫**：
1. 刪掉無效的 setTimeout。
2. 正確的整體限時做法：hook 入口把實際工作 spawn 成子行程（`child_process.spawnSync(process.execPath, [workerScript], { timeout: 10000 })`），逾時就放棄並輸出提示「自動推送逾時，請手動 /sync-push」。或最低成本方案：收緊內部各 git 呼叫的 timeout（fetch 5s、push 10s），並確認 hooks.json 是否支援 `timeout` 欄位、支援則一併設定。
3. 無論採哪個方案，把「安全逾時」的真實行為寫進註解取代現在的錯誤註解。

**驗證方式**：模擬不可達 remote 跑 hook，量測整體耗時 ≤ 10-15s。

---

### C-06 [Medium] getStatus() 無鎖操作 repo 並執行 `clean -fd`

**位置**：`lib/sync-engine.js:845-871`

**問題**：`getStatus()` 為了偵測 localChanges 會 `exportAll()` 弄髒 repo 工作樹，再 `checkout -- .` + `clean -fd` 還原。兩個問題：
1. 沒拿 lock。與並行的 push()（例如 session-end autoPush 與使用者手動 /sync-status 同時）競態：push 的 `add -A` + commit 可能把 status 的中間狀態 commit 進去，或 status 的 clean 把 push 剛 export 的檔案刪掉。
2. `clean -fd` 無差別刪 untracked——若工作樹裡有前次失敗操作留下的狀態（進行中的 merge 產物），會被破壞。

**修正計畫**：
1. `getStatus()` 改為**唯讀**實作：不要 export 到工作樹。做法：`exportAll()` 改寫成可注入輸出目錄（`exportAll(targetDir)`，預設 REPO_DIR），status 用 `fs.mkdtempSync` 臨時目錄 export，然後用 `git -C REPO_DIR diff --no-index` 或直接複用 diff 函式（C-01 修好後）判斷有無差異，用完刪臨時目錄。
2. 若嫌改動大，退而求其次：getStatus 取 lock（拿不到就回傳 `busy: true` 跳過 localChanges 檢查），並把 `clean -fd` 限縮為 `clean -fd -- global user-config`。
3. `hooks/session-end-check.js` 非 autoPush 路徑（exportAll + checkout）有同樣問題，且 `checkout -- .` 不會移除 export 產生的 untracked 新檔（垃圾留在工作樹，之後可能被 pull 的 import 讀到）——同一個修法（臨時目錄比較）一併套用。

**驗證方式**：情境測試：status 前後 `git status --porcelain` 輸出一致（工作樹不被汙染）；並行 status+push 壓力測試不產生壞 commit。

---

### C-07 [Low] performSmartMerge 的 merge --abort 可能拋錯

**位置**：`lib/sync-engine.js:631-637`

**問題**：`git merge origin/main` 失敗的原因不一定是衝突（例如 untracked 檔案會被覆蓋、repo 狀態異常）。這時沒有 merge in progress，`gitExec('merge --abort')` 自己會拋錯，蓋掉原始錯誤且讓 push() 以難以理解的錯誤失敗。

**修正計畫**：
1. `merge --abort` 包 try/catch 忽略失敗。
2. fallback merge（`-X ours`）再失敗時，丟出包含 git stderr 原文的錯誤，提示使用者 repo 狀態需要人工處理。
3. （配合 C-06 修掉 untracked 汙染來源後，此路徑觸發率會大幅下降。）

**驗證方式**：單元測試：mock gitExec 讓第一次 merge 失敗且 abort 失敗，確認最終錯誤訊息可讀、lock 有釋放。

---

### C-08 [Low] `process.env.HOME` 在 Windows 上為 undefined

**位置**：`lib/sync-engine.js:7`、`hooks/session-start-check.js:7-8`、`hooks/session-end-check.js:8-9`

**問題**：Windows 沒有 `HOME`（是 `USERPROFILE`），`path.join(undefined, '.claude')` 直接 throw。

**修正計畫**：三個檔案統一改 `require('os').homedir()`。grep 檢查有無其他 `process.env.HOME` 引用。若專案短期不打算支援 Windows，至少在 README 標注 macOS/Linux only。

**驗證方式**：grep 確認無殘留 `process.env.HOME`；單元測試在刪除 HOME env 的環境下 require 模組不 throw。

---

### C-09 [Low] copyDirSync 不處理 symlink；檔案比較用 utf8 讀二進位

**位置**：`lib/sync-engine.js:252-264`（copyDirSync）、`774-843`（diff 讀檔）、`984-991`（getLocalDelta 讀檔）

**問題**：
1. symlink：`entry.isDirectory()` 對指向目錄的 symlink 回 false → 走 `copyFileSync`（跟隨連結複製目標內容）。指向大目錄或外部敏感檔的 symlink 會產生意外行為；斷掉的 symlink 直接 throw 中斷整個 export/import。
2. 內容比較全部 `readFileSync(p, 'utf8')`：二進位檔（skills 內的圖片等）經 utf8 解碼後，不同檔案可能比出相同結果（invalid sequence 都變 U+FFFD）。

**修正計畫**：
1. `copyDirSync`/`removeStalePaths`/`listFilesRecursive` 用 `entry.isSymbolicLink()` 判斷：預設**跳過並收集 warning**（同步 symlink 幾乎必然是錯的）。
2. 所有內容比較改 `fs.readFileSync(p)`（Buffer）+ `buf1.equals(buf2)`；與 git 側比較時新增 `safeGitShowBuffer`（execSync 回傳本來就是 Buffer，不要 toString），避免影響現有字串呼叫點。
3. `getLocalDelta` 的 `baseContent !== localContent` 同步改 Buffer 比較。

**驗證方式**：單元測試：含 symlink 的目錄 export 不 throw 且產生 warning；兩個不同的二進位檔 diff 判定為 modified。

---

## D. UX / 一致性

### D-01 [Medium] .DS_Store 等垃圾檔被同步進 repo

**位置**：`lib/sync-engine.js:252-264`（copyDirSync 無過濾）、對照 `756-772`（listFilesRecursive 有跳過 .DS_Store）

**問題**：`copyDirSync` 不過濾任何檔名，macOS 的 `.DS_Store` 會被 export 進 repo 並 commit。後果：(1) 開過 Finder 就有「變更」，session-end hook 一直提示「本地有未推送的變更」；(2) diff 函式跳過 .DS_Store 但 export 不跳，兩邊行為不一致。

**修正計畫**：
1. 定義模組級 `IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.localized'])`。
2. `copyDirSync`、`removeStalePaths`、`listFilesRecursive` 統一套用（listFilesRecursive 現有的 .DS_Store 判斷改引用常數）。
3. init() 時在 repo 寫入 `.gitignore`（.DS_Store 等）；既有 repo 的殘留檔在 A-01 修好後由下次 export 的 stale sweep 自然清除。

**驗證方式**：情境測試：同步目錄放 .DS_Store → push → repo 內無該檔、hasLocalChanges 為 false。

---

### D-02 [Low] 備份輪替可能把重要備份擠掉

**位置**：`lib/sync-engine.js:300-344`（createBackup 保留 5 份）、`1054`（pull 一進來就備份）

**問題**：pull 無論結果（up-to-date、safe-mode 拒絕、真的 pull）都先 createBackup。連續幾次 no-op pull 就能把「災難前」的有用備份擠出 5 份輪替。

**修正計畫**：
1. safe-mode 拒絕路徑（`local-changes-pending`）不備份（把 createBackup 移到該分支判斷之後）；保留份數提高到 10。
2. （可選）備份目錄加 `manifest.json` 記錄觸發原因，/sync-restore 列表時顯示，幫使用者挑對備份。
3. A-02 修好後，可進一步在 import 前用 diff 判斷是否真的會有變更，無變更就跳過備份。

**驗證方式**：情境測試：連續 3 次被拒絕的 pull → 備份數不增加。

---

### D-03 [Medium] detectMissingPlugins 輸出與 skill 要求的安裝格式不匹配

**位置**：`lib/sync-engine.js:554-569`、`commands/sync-pull.md` 步驟 7、`commands/sync-restore.md` 步驟 6

**問題**：skill 指示執行 `claude plugin install <plugin>@<marketplace>`，但 `detectMissingPlugins()` 只回傳 plugin 名稱陣列，沒有 marketplace。若 `installed_plugins.json` 的 key 本身就是 `plugin@marketplace` 格式則剛好可用，否則執行的 agent 只能猜。目前程式碼無法自證，需先驗證資料格式。

**修正計畫**：
1. 先實測：讀一份真實的 `~/.claude/plugins/installed_plugins.json` 確認 key 格式與 value 結構。
2. 若 key 不含 marketplace：從 value（version entry 或 installPath 可反推）解析出 marketplace，回傳改為 `[{ name, marketplace, installPath }]`。
3. 同步更新兩個 skill 檔的說明，明確告訴 agent 回傳物件的欄位怎麼組安裝指令。

**驗證方式**：情境測試：刪掉一個已安裝 plugin 的 install 目錄 → detectMissingPlugins 回傳含 marketplace 的結構 → 依結果組出的 install 指令可成功執行。

---

### D-04 [Low] sync-push.md 衝突解決片段不更新 last-sync.json

**位置**：`commands/sync-push.md` 步驟 5 的程式碼片段

**問題**：使用者選擇改用遠端值時，片段直接改 repo 檔案、commit、push，但沒有 `saveLastSync`。last-sync.json 的 commitHash 停在前一個 commit，下次 previewPull 會誤判「遠端有更新」，多跑一輪不必要的 merge 流程（結果安全但混淆）。

**修正計畫**：
1. 引擎新增 `resolvePushConflicts(fields)` 函式：寫 repo settings → commit → push → `saveLastSync({ action: 'push', commitHash: <new HEAD>, firstPullPending: false })`，並沿用 lock。
2. sync-push.md 的內嵌多行 node -e 片段改為呼叫這個函式（skill 內嵌長 JS 片段容易被實作 agent 抄壞，收進引擎最穩）。

**驗證方式**：情境測試：製造 push 衝突 → 選遠端值 → 檢查 last-sync.json 的 commitHash === repo HEAD === origin HEAD。

---

### D-05 [Low] MAPPING_PATH 死碼

**位置**：`lib/sync-engine.js:11`、`1123`

**修正計畫**：刪除常數宣告與 exports 中的 `MAPPING_PATH`。grep 確認 commands/、hooks/、docs/ 無引用。

**驗證方式**：grep 無殘留；`node -e "require('./lib/sync-engine.js')"` 正常載入。

---

## E. 文件

### E-01 [Low] known-issues.md #3 已過時（doc rot）

**位置**：`docs/known-issues.md` #3

**問題**：#3 描述「pull() 在 fetch 前先 exportAll() + commit」，但現行 `pull()`（`ecacbcb` 之後）已改為 `reset --hard origin/main` + 以 last-sync commitHash 為 base 的 3-way import，沒有 export+commit 步驟。過時描述會誤導後續維護者。

**修正計畫**：
1. 將 #3 標為 `[已修復] ecacbcb — pull 改用 last-sync base 3-way merge`，仿照 #1 的格式。
2. 在 known-issues.md 頂部加一行指向本文件（docs/issues-and-fix-plan.md），避免兩份清單分歧。

**驗證方式**：人工檢視。

---

## F. 測試基礎建設

### F-01 [High] 專案沒有任何測試、沒有 package.json

**位置**：全專案

**問題**：這是一個會**改寫使用者 `~/.claude`（含 settings、hooks）並刪除檔案**的工具，卻沒有任何自動化測試。上面每一項修正都需要回歸保護，否則修 A 壞 B 的機率很高。核心邏輯（mergeJsonFields、removeStalePaths、getLocalDelta、pull 狀態機）都是純函數或可注入路徑，非常好測。

**修正計畫**（建議最先做，作為其他修正的地基）：
1. 加 `package.json`（`"private": true`，不影響 plugin 發佈結構）；測試框架用 Node 內建 `node:test` + `node:assert`（零依賴，plugin 環境最乾淨）。
2. **關鍵前置重構**：`sync-engine.js` 頂部的 `CLAUDE_HOME`/`SYNC_DIR`/`REPO_DIR` 等常數改為可覆寫（讀 `process.env.CLAUDE_SYNC_HOME ?? path.join(os.homedir(), '.claude')`）。這讓所有測試能在 tmpdir 裡跑完整 init/push/pull，不碰真實 `~/.claude`。（與 C-08 的 os.homedir() 修正一起做。）
3. 測試分層：
   - 單元：`mergeJsonFields`（含遞迴、刪除、衝突偏好）、`transformPathsFor*`、`removeStalePaths`、`listFilesRecursive`、`scanForSecrets`（B-04 後）。
   - 整合：用 `git init --bare` 的本地 bare repo 當 remote，跑完整情境——init 空 repo、init 既有 repo + first pull、push/pull 往返、safe pull 拒絕、merge mode、備份/還原、A-01/A-02/A-03 的回歸情境。
   - hooks：以子行程執行兩個 hook 腳本，驗證輸出格式與靜默失敗行為。
4. `npm test` script +（可選）GitHub Actions workflow。
5. 覆蓋目標：sync-engine.js 行覆蓋 ≥ 80%。

**驗證方式**：`npm test` 全綠；改壞 mergeJsonFields 任一分支會有測試失敗（抽查突變）。

---

## 建議實作順序

依賴關係與風險排序，供派工參考：

1. **F-01**（測試地基；至少先完成 path 注入重構 + bare-repo 整合測試骨架）
2. **A-01 + A-06**（同一主題：刪除傳播；最高風險的資料正確性問題）
3. **A-02**（讓 pull 回報可信，後續所有驗證都依賴它）
4. **B-01**（安全，改動機械化、範圍明確）
5. **C-01**（diff 正確性，是 B-02 的前置）
6. **B-02 + B-03**（pull 安全流程重設計，會動 API 與 skill 檔）
7. **A-03、A-04、A-05**
8. **C-02 ~ C-09**（穩健性批次，彼此獨立可並行派工）
9. **D-01 ~ D-05、B-04、E-01**（收尾批次）

每項完成的定義：修正合入 + 對應回歸測試 + 受影響的 commands/*.md 與 README 段落同步更新。
