# Critical Bug: pull() smart merge 丟失遠端 plugin 記錄

## 狀態：已修復 (bec42fc)

## 嚴重程度：Critical

## 問題描述

`pull()` 在 merge 前先 `exportAll()` + `commit` 本地狀態，原意是讓 smart merge 能看到雙方完整狀態做正確的 3-way merge。但實際結果是遠端的 `installed_plugins.json` 被本地版本覆蓋，遠端多出的 plugin 記錄全部丟失。

## 重現步驟

1. 機器 A 有 23 個 plugin，push 到 remote
2. 機器 B 有 17 個 plugin，執行 pull
3. 預期：merge 後機器 B 得到兩邊的聯集（25 個 plugin）
4. ~~實際：repo 被覆蓋成 17 個 plugin，遠端獨有的 6 個 plugin 記錄消失~~
5. 修復後：正確合併為兩邊的聯集

## 根因

`mergeJsonFields()` 以 **top-level key** 為粒度比較。`installed_plugins.json` 的 `plugins` 是一整個 nested object，兩台機器有不同的 plugin 清單，整個 `plugins` key 被當成衝突二選一，而不是合併子 key。

## 修復方式

在 `mergeJsonFields()` 中加入遞迴邏輯：當兩邊都修改了同一個 key，且值都是 plain object 時，遞迴 merge 子 key 而非二選一。

這讓 `installed_plugins.json` 的每個 plugin entry、`known_marketplaces.json` 的每個 marketplace entry、以及 `settings.json` 的巢狀物件（如 `permissions`、`hooks`）都能正確做欄位層級合併。

## 測試覆蓋

- Case 6: 兩邊有不同 plugins → 聯集合併，0 衝突
- Case 7: 同一個 plugin 兩邊都改 → 正確報告衝突，key path 用 dot notation
- Case 8: known_marketplaces 聯集合併
- Case 10: 模擬真實場景 17 vs 23 plugins → 合併為 25

## 發現日期

2026-03-21
