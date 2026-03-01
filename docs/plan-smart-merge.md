# 計畫：JSON 欄位層級智能合併

## 背景

目前 push/pull 的衝突解決是粗暴的 last-write-wins：

| 情境 | 目前行為 | 問題 |
|------|---------|------|
| push 被拒絕 (line 452) | `merge -X ours` — 本地全贏 | 遠端的非衝突欄位變更被靜默丟棄 |
| pull 合併失敗 (line 474-475) | `reset --hard origin/main` — 遠端全贏 | 本地的非衝突欄位變更被靜默丟棄 |

**期望行為：** JSON 欄位層級的 3-way merge + 衝突時由 Claude 呈現給使用者選擇。

---

## 設計

### 合併策略

| base → local | base → remote | 結果 |
|-------------|--------------|------|
| 沒變 | 沒變 | 保留 base |
| 改了 | 沒變 | 取 local |
| 沒變 | 改了 | 取 remote |
| 都改了，值相同 | | 取任一 |
| 都改了，值不同 | | **衝突** → 預設依操作方向，回傳給 caller |
| 一邊刪除，另一邊沒變 | | 刪除 |
| 一邊刪除，另一邊改了 | | **衝突** |
| 都新增，值不同 | | **衝突** |

合併粒度：**top-level key**。`settings.json` 中的 `env`、`permissions` 等巢狀物件視為整體比較。

### 衝突互動流程

```
push()/pull() 完成合併（衝突用預設偏好：push=local, pull=remote）
       │
       ├─ 沒有衝突 → 直接回報成功
       │
       └─ 有衝突 → 回傳 mergeConflicts 陣列
              │
              ├─ 互動環境（/sync-push, /sync-pull）
              │     → Claude 讀到 mergeConflicts
              │     → 用自然語言呈現每個衝突：
              │       「theme 在兩邊都被修改了：
              │        本地：dark / 遠端：light
              │        目前保留了本地版本，要改用遠端嗎？」
              │     → 使用者選擇
              │     → 若要覆蓋：Claude 改 repo JSON → commit → push
              │
              └─ 非互動環境（SessionEnd hook）
                    → 靜默使用預設偏好
                    → stderr 輸出衝突摘要
```

---

## 要修改的檔案

### `lib/sync-engine.js` — 核心邏輯

**1. 新增 `safeGitShow(ref, filePath)` (~6 行)**

放在 git helpers 區段（line ~47 後）。從 git ref 讀取檔案內容，不存在回傳 `null`。

**2. 新增 `mergeJsonFields(base, local, remote, preference)` (~40 行)**

放在 Diff + Status 區段前（line ~330 前）。回傳 `{ result, conflicts }`。

```js
function mergeJsonFields(base, local, remote, preference) {
  const result = {};
  const conflicts = [];
  const allKeys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(local || {}),
    ...Object.keys(remote || {}),
  ]);
  for (const key of allKeys) {
    const inBase = base != null && key in base;
    const inLocal = local != null && key in local;
    const inRemote = remote != null && key in remote;
    const baseVal = inBase ? JSON.stringify(base[key]) : undefined;
    const localVal = inLocal ? JSON.stringify(local[key]) : undefined;
    const remoteVal = inRemote ? JSON.stringify(remote[key]) : undefined;
    const localChanged = localVal !== baseVal;
    const remoteChanged = remoteVal !== baseVal;

    if (!localChanged && !remoteChanged) {
      if (inBase) result[key] = base[key];
    } else if (localChanged && !remoteChanged) {
      if (inLocal) result[key] = local[key];
    } else if (!localChanged && remoteChanged) {
      if (inRemote) result[key] = remote[key];
    } else {
      // Both changed
      if (localVal === remoteVal) {
        if (inLocal) result[key] = local[key];
      } else {
        conflicts.push({
          key,
          localValue: inLocal ? local[key] : undefined,
          remoteValue: inRemote ? remote[key] : undefined,
          localDeleted: !inLocal,
          remoteDeleted: !inRemote,
        });
        const winner = preference === 'local'
          ? (inLocal ? local[key] : undefined)
          : (inRemote ? remote[key] : undefined);
        const winnerExists = preference === 'local' ? inLocal : inRemote;
        if (winnerExists) result[key] = winner;
      }
    }
  }
  return { result, conflicts };
}
```

**3. 新增常數 `MERGE_JSON_FILES`**

```js
const MERGE_JSON_FILES = [
  'global/settings.json',
  'global/installed_plugins.json',
  'global/known_marketplaces.json',
];
```

**4. 修改 `push()` 的 catch 區塊 (line 448-454)**

```js
try {
  gitExec('push origin main');
} catch {
  gitExec('fetch origin main');

  // 計算欄位層級合併
  const base = gitExec('merge-base HEAD origin/main');
  const allConflicts = [];
  const mergedFiles = {};
  for (const file of MERGE_JSON_FILES) {
    const b = safeGitShow(base, file);
    const l = safeGitShow('HEAD', file);
    const r = safeGitShow('origin/main', file);
    if (b != null && l != null && r != null) {
      const m = mergeJsonFields(JSON.parse(b), JSON.parse(l), JSON.parse(r), 'local');
      mergedFiles[file] = m.result;
      allConflicts.push(...m.conflicts);
    }
  }

  // Git merge 處理非 JSON 檔
  try {
    gitExec('merge origin/main --no-edit');
  } catch {
    gitExec('merge --abort');
    gitExec('merge origin/main --no-edit -X ours');
  }

  // 用欄位合併結果覆寫 JSON 檔
  let needsFixup = false;
  for (const [file, merged] of Object.entries(mergedFiles)) {
    const filePath = path.join(REPO_DIR, file);
    const content = JSON.stringify(merged, null, 2);
    if (fs.readFileSync(filePath, 'utf8') !== content) {
      fs.writeFileSync(filePath, content);
      needsFixup = true;
    }
  }
  if (needsFixup) {
    gitExec('add -A');
    gitExec('commit --amend --no-edit');
  }

  gitExec('push origin main');
  // allConflicts 加入回傳值（見下方）
}
```

回傳值改為：`{ pushed: true, mergeConflicts: allConflicts }`（無衝突時 `mergeConflicts` 為空陣列或 undefined）。

**5. 修改 `pull()` 的 merge 區塊 (line 471-476)**

同樣模式，但 preference 改為 `'remote'`，fallback 用 `-X theirs`。

回傳值加入 `mergeConflicts`。

**6. 更新 module.exports**

加入 `mergeJsonFields`, `safeGitShow`。

### `commands/sync-push.md` — 衝突互動

目前步驟 3 只有簡單的成功/失敗報告。改為完整的衝突處理流程：

```markdown
3. **Report results:**
   - If `pushed: true` and no `mergeConflicts` (or empty): "Settings pushed successfully."
   - If `pushed: false, reason: 'no-changes'`: "No changes to push. Already up to date."
   - If error: Show the error message and suggest troubleshooting.

4. **Handle merge conflicts (if any):**
   If the result contains `mergeConflicts` (non-empty array), the push already completed
   with local values as default. Present each conflict to the user:

   For each conflict in the array, show:
   - The field name (key)
   - The local value (what was kept)
   - The remote value (what was discarded)
   - Whether either side deleted the field

   Example presentation:
   > 推送完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 本地（已保留） | 遠端（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "dark" | "light" |
   > | env.API_KEY | "key-abc" | "key-xyz" |
   >
   > 要改用遠端的值嗎？可以選擇全部改用遠端、或指定個別欄位。

   If user wants to change some values:
   ```bash
   node -e "
     const s = require('${CLAUDE_PLUGIN_ROOT}/lib/sync-engine.js');
     // Read current repo settings, apply user's chosen values, write back
     const fp = require('path').join(s.REPO_DIR, 'global', 'settings.json');
     const data = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
     data.FIELD_NAME = CHOSEN_VALUE;  // repeat for each field user wants to change
     require('fs').writeFileSync(fp, JSON.stringify(data, null, 2));
     s.gitExec('add -A');
     s.gitExec('commit -m "resolve merge conflicts"');
     s.gitExec('push origin main');
     console.log('done');
   "
   ```
   Replace FIELD_NAME and CHOSEN_VALUE with the actual field and value the user chose.
```

### `commands/sync-pull.md` — 衝突互動

在現有步驟 5 之後加入衝突處理，邏輯同上但方向相反（預設保留遠端值）：

```markdown
8. **Handle merge conflicts (if any):**
   If the result contains `mergeConflicts` (non-empty array), the pull already completed
   with remote values as default. Present each conflict to the user:

   > 拉取完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 遠端（已保留） | 本地（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "light" | "dark" |
   >
   > 要改用本地的值嗎？

   If user wants to keep local values for some fields:
   - Modify the local ~/.claude/settings.json with chosen values
   - Tell the user: "Settings updated. Run /sync-push to push your choices to remote."
```

### `hooks/session-end-check.js` — 靜默衝突摘要

autoPush 路徑，若 push() 回傳有 mergeConflicts，輸出摘要到 stderr：

```js
if (result.pushed) {
  if (result.mergeConflicts && result.mergeConflicts.length > 0) {
    const keys = result.mergeConflicts.map(c => c.key).join(', ');
    process.stderr.write(`[claude-sync] ⚠️ 自動推送完成，但有 ${result.mergeConflicts.length} 個欄位衝突（已保留本地版本）：${keys}\n`);
  } else {
    process.stderr.write('[claude-sync] ✅ 已自動推送變更到遠端。\n');
  }
}
```

### `README.md` + `README.zh-TW.md` — 文件

**衝突解決區段**從 "last-write-wins" 完整改寫為三層：

```markdown
## ⚡ 衝突解決

使用 **JSON 欄位層級的 3-way merge**：

- 📊 **非衝突欄位** — 自動合併。機器 A 改了 theme、機器 B 改了 language，兩個都保留。

- ⚠️ **衝突欄位（互動模式）** — 當你透過 /sync-push 或 /sync-pull 操作時，
  Claude 會用自然語言呈現每個衝突的欄位，顯示本地和遠端的值，讓你選擇要保留哪一個。

- 🤖 **衝突欄位（自動模式）** — SessionEnd 自動推送時，衝突欄位依操作方向決定：
  push 保留本地、pull 保留遠端。衝突欄位名稱會輸出到 stderr。
```

加入衝突互動流程圖（push 為例）：

```markdown
### 衝突解決流程（以 push 為例）

> `/sync-push` 執行後，如果遠端也有變更：

1. 📊 Claude 自動合併非衝突欄位（例如你改了 theme，遠端改了 language → 兩者都保留）

2. ⚠️ 若有衝突欄位，Claude 會呈現：
   > 推送完成，但合併時發現以下欄位在兩邊都被修改：
   >
   > | 欄位 | 本地（已保留） | 遠端（已捨棄） |
   > |------|-------------|-------------|
   > | theme | "dark" | "light" |
   >
   > 要改用遠端的值嗎？可以選擇全部改用遠端、或指定個別欄位。

3. ✅ 你選擇後，Claude 會套用你的決定並重新推送。

> `/sync-pull` 的流程相同，但方向相反（預設保留遠端值）。
>
> **SessionEnd 自動推送** 時無法互動，衝突欄位自動保留本地版本，並在 stderr 輸出衝突摘要。
```

（README.zh-TW.md 寫對應的繁體中文版本）

### `SETUP_GUIDE.md`

更新 "Important Notes for Agents" 加入衝突處理指引：
- pull()/push() 可能回傳 mergeConflicts
- Agent 應讀取 conflicts 並呈現給使用者
- 使用者選擇後再套用

---

## 驗證

### 1. mergeJsonFields 單元測試

```bash
node -e "
  const s = require('./lib/sync-engine.js');

  // Case 1: 不同欄位 → 自動合併，0 衝突
  const r1 = s.mergeJsonFields({a:1,b:2,c:3}, {a:1,b:9,c:3}, {a:1,b:2,c:7}, 'local');
  console.assert(r1.result.b === 9 && r1.result.c === 7 && r1.conflicts.length === 0);

  // Case 2: 同欄位衝突 → conflicts 陣列有值 + local wins
  const r2 = s.mergeJsonFields({x:1}, {x:2}, {x:3}, 'local');
  console.assert(r2.result.x === 2 && r2.conflicts.length === 1);
  console.assert(r2.conflicts[0].key === 'x');
  console.assert(r2.conflicts[0].localValue === 2);
  console.assert(r2.conflicts[0].remoteValue === 3);

  // Case 3: 同欄位衝突 → remote wins
  const r3 = s.mergeJsonFields({x:1}, {x:2}, {x:3}, 'remote');
  console.assert(r3.result.x === 3 && r3.conflicts.length === 1);

  // Case 4: 雙方新增不同欄位 → 自動合併
  const r4 = s.mergeJsonFields({}, {a:1}, {b:2}, 'local');
  console.assert(r4.result.a === 1 && r4.result.b === 2 && r4.conflicts.length === 0);

  // Case 5: 一邊刪除，另一邊沒變 → 刪除
  const r5 = s.mergeJsonFields({a:1,b:2}, {b:2}, {a:1,b:2}, 'local');
  console.assert(!('a' in r5.result) && r5.conflicts.length === 0);

  console.log('All mergeJsonFields tests passed');
"
```

### 2. 衝突互動 E2E 流程（手動模擬）

模擬 push 遇到遠端衝突的完整流程：

```
步驟 1: 初始化 → 兩邊都有 settings = { theme: "default", lang: "en" }
步驟 2: 遠端（模擬另一台機器）改 theme → "light"
步驟 3: 本地改 theme → "dark"、lang → "zh-TW"
步驟 4: 使用者執行 /sync-push
步驟 5: push() 偵測到衝突，回傳：
         {
           pushed: true,
           mergeConflicts: [{
             key: "theme",
             localValue: "dark",
             remoteValue: "light"
           }]
         }
         注意 lang 不衝突（只有本地改了），自動合併。
步驟 6: Claude 讀到 mergeConflicts，呈現：
         「推送完成，但 theme 在兩邊都被修改了：
          - 本地（已保留）：dark
          - 遠端（已捨棄）：light
          要改用遠端的值嗎？」
步驟 7a: 使用者選「保留本地」 → 不需要額外操作，已經是 dark
步驟 7b: 使用者選「改用遠端」 → Claude 修改 repo 中的值為 light，commit + push
步驟 8: 最終 repo 狀態：{ theme: <使用者選的>, lang: "zh-TW" }
```

### 3. SessionEnd hook 衝突摘要

```
步驟 1: config.autoPush = true
步驟 2: 製造與上面相同的衝突場景
步驟 3: 執行 session-end-check.js
步驟 4: 預期 stderr 輸出：
         [claude-sync] ⚠️ 自動推送完成，但有 1 個欄位衝突（已保留本地版本）：theme
```
