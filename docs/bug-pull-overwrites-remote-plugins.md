# Critical Bug: pull() smart merge 丟失遠端 plugin 記錄

## 嚴重程度：Critical

## 問題描述

`pull()` 在 merge 前先 `exportAll()` + `commit` 本地狀態，原意是讓 smart merge 能看到雙方完整狀態做正確的 3-way merge。但實際結果是遠端的 `installed_plugins.json` 被本地版本覆蓋，遠端多出的 plugin 記錄全部丟失。

## 重現步驟

1. 機器 A 有 23 個 plugin，push 到 remote
2. 機器 B 有 17 個 plugin，執行 pull
3. 預期：merge 後機器 B 得到 23 個 plugin（或至少是兩邊的聯集）
4. 實際：repo 被覆蓋成 17 個 plugin，遠端獨有的 6 個 plugin 記錄消失

## 根因分析

`mergeJsonFields()` 以 **top-level key** 為粒度比較。`installed_plugins.json` 的結構是：

```json
{
  "version": 2,
  "plugins": { ... }  ← 整個 object 是一個 top-level key
}
```

`plugins` 這個 key 在 base、local、remote 三方都不同（因為不同機器有不同的 plugin）。`mergeJsonFields` 看到 local 和 remote 都改了 `plugins` key → 判定為衝突 → preference 是 `'remote'` 應該取遠端。

**但問題可能在：**
1. pull 前的 `exportAll()` + `commit` 改變了 merge-base，導致 base 已經等於 remote（因為 fetch 後 merge-base 指向的是上次 push 的 commit），local 反而變成「剛 export 的本地狀態」
2. 或者 merge 的 git 操作（`-X theirs`）在 `performSmartMerge` 之前已經用 git 自己的 merge 把檔案搞亂了
3. 或者 `commit --amend` 的時機導致 smart merge 結果被覆蓋

需要在 debug 時逐步追蹤：
- merge-base 指向哪個 commit
- safeGitShow 拿到的 base/local/remote 各是什麼
- mergeJsonFields 回傳的 result 和 conflicts 是什麼
- git merge 後、JSON overwrite 前，檔案內容是什麼

## 設計意圖

pull 前先 export + commit 的目的是：讓 smart merge 能正確比較「本地實際狀態」vs「遠端狀態」，而不是比較「上次 push 的 repo 狀態」vs「遠端狀態」。

這個意圖是正確的，但實作上可能因為 merge-base 的計算、git merge 的時序、或 `installed_plugins.json` 的結構（top-level key 粒度太粗）導致結果不如預期。

## 可能的修法方向

1. **對 `installed_plugins.json` 做 deep merge**：不只比較 top-level key，而是深入到 `plugins` 底下的每個 plugin key（如 `superpowers@claude-plugins-official`）分別比較
2. **改變 pull 的 export+commit 策略**：不要在 fetch 之後、merge 之前 commit，或改用 stash
3. **加 debug logging**：在 `performSmartMerge` 裡加上每個檔案的 base/local/remote 和 merge result 的 log，方便追蹤

## 影響範圍

所有透過 pull 同步的 JSON 檔案都可能受影響，但 `installed_plugins.json` 最明顯，因為不同機器的 plugin 清單天然不同。`settings.json` 和 `known_marketplaces.json` 也可能有類似問題。

## 發現日期

2026-03-21
