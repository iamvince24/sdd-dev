# README 改寫設計

## 目標

將 README 改為首次使用 sdd-dev 的開發者可直接依循的入口文件，同時保留命令查閱與必要的流程教學。

## 讀者與範圍

- 主要讀者：第一次在 Git 專案導入 sdd-dev 的開發者。
- 次要讀者：需要快速查找命令參數的既有使用者。
- 不改變 CLI、流程規格或平台能力；文件只能描述現有程式碼與既有規劃已定義的行為。

## 文件結構

1. 專案介紹與適用情境。
2. 前置需求與安裝方式：說明目前不發布至 npm，使用者需取得 sdd-dev checkout，並以 `node <工具路徑>/bin/sdd.js` 作為不依賴 PATH 的明確呼叫方式。
3. 可複製執行的快速開始：以暫存 Git repo 為例，全程使用 `node <工具路徑>/bin/sdd.js`，包含建立來源 Spec、`init --mode repo-local --tracking ignore --yes`、`workspace add`、`run start` 的完整必要參數。
4. 路線教學：說明 `direct`、`full_pipeline` 與 `selected_advisors` 的用途；`full_pipeline` 須列出 Spec 核准、計畫審查、Plan 核准與結果審查等停止點，`selected_advisors` 明定只諮詢、不授權實作。
5. 常用維護命令：限定為 `doctor`、`workspace refresh`、`run baseline`、`run resume`、`run export`、`update`、`mode switch` 與 `uninstall`。
6. 完整命令參考：依 `bin/sdd.js` usage 分群，保留所有指令、必要與可選參數、`ag`／`agentflow` 路線別名及 exit code。
7. 平台能力限制：連到 `docs/platforms.md`，說明未實測即為能力缺口、Codex 沒有 hook，以及 `workspace-write` 不能阻擋所有破壞性操作或連網。
8. 隱私檢查、開發方式與 License。

## 正確性與驗證

- 安裝條件、指令名稱、選項與結束碼以 `package.json`、`bin/sdd.js` 與現有 README 為準。
- 在暫存 Git repo 逐步以 `node <工具路徑>/bin/sdd.js` 實跑 README 的快速開始，確認安裝、workspace 登錄與建立 run 均可完成。
- 逐條比對完整命令參考與 `node bin/sdd.js` usage，確認內部連結有效。
- 不修改現有命令行為；執行 `npm test`、`npm run privacy-check` 與 `git diff --check`。
