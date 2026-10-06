# Cursor 退役與遷移

自 2026-10-06 起，sdd-dev 的平台整合只支援 Claude Code 與 Codex。工具已移除 Cursor hook adapter、安裝入口、instructions 產生器與能力矩陣中的 Cursor 項目；[平台探測](platforms.md)保留舊觀察，僅供查考。新版沒有 `--platform cursor` 的解除安裝入口，舊產物須依下方步驟檢查。

## 新 run 與既有 run

建立新 run 時，CLI 的 `--platform cursor` 與環境變數 `SDD_PLATFORM=cursor` 都會回傳用法錯誤（exit code `3`），在建立 workspace 或 run 檔案前停止。即使 CLI 明確指定 `--platform codex`，若環境變數仍是 `cursor`，也會被拒絕。改用 `--platform claude-code` 或 `--platform codex`；如有設定環境變數，先將它改成相同的支援平台或移除。

既有 manifest 記錄為 `platform: "cursor"` 的 run 仍是歷史資料。`sdd run export <run_id> --out <path>` 可匯出；`run next`、`run resume`、`run baseline`、`run route`、`check`、`metrics` 等需要處理或寫入舊 run 的命令會停止（exit code `1`）。若要繼續同一項工作，請在支援的平台建立**新 run**，以原需求文件作為來源；工具不會替既有 run 改平台或搬移舊核准與驗證紀錄。匯出檔含 run 資料，請自行選擇安全的保存位置。

## 更新或解除安裝前，檢查舊產物

新版的 `init`、`update`（含預覽與 `--apply`）、`mode switch`、`uninstall`（含 `--purge`）會先檢查目標 repo。發現下列 SDD Cursor 產物時，命令會回傳阻擋錯誤（exit code `1`），列出找到的路徑，且不會先更動安裝資料：

| 位置 | 判定條件 | 處理方式 |
| --- | --- | --- |
| `.cursor/hooks.json` | hook 的 `command` 以 `SDD_HOOK=1 ` 開頭，且含 `/integrations/cursor/hook.js` | 先保存目前檔案，只移除符合條件的 SDD hook 項目；保留其他 hook 和設定。 |
| `.cursor/rules/sdd-*.mdc` | `sdd-` 後接英數字、底線或連字號，副檔名是 `.mdc`，內容有 `<!-- sdd-rule` 標記 | 檢查規則與檔內其他內容；只移除 SDD 所產生的內容。若沒有其他使用者內容，才移除該檔。 |
| `.sdd-dev/instructions/cursor.json` | 檔案存在 | 核對紀錄指向的規則及現有內容，確認 SDD 區塊已處理後再移除紀錄。 |
| `.sdd-dev/hook/cursor-hooks.backup.json` | 檔案存在 | 對照目前 hooks 與備份，確認使用者新增的項目已保留後再移除備份。 |

建議依序處理：

1. 在目標 repo 保存上述現有檔案的副本，檢查是否有安裝後新增或修改的使用者內容。
2. 編輯 `.cursor/hooks.json`，只移除符合表中條件的 SDD hook 項目，維持有效 JSON；保留其他 hook。檢查 `.cursor/rules/` 中符合條件的檔案，移除 SDD 規則與僅屬於該規則的前置資料，保留使用者自行增加的內容。
3. 比對 `.sdd-dev/instructions/cursor.json` 與 `.sdd-dev/hook/cursor-hooks.backup.json`，確認相關 SDD 內容已清理、使用者內容仍在，再移除這兩份舊紀錄。
4. 重新執行原本被阻擋的 `init`、`update`、`mode switch` 或 `uninstall`，確認它不再列出 Cursor 產物。

不要刪除整個 `.cursor/`，也不要直接用舊備份覆蓋目前檔案。舊版 `sdd uninstall` 不會清掉 Cursor hook；舊規則還原流程可能覆蓋安裝後的修改，不能代替上述檢查。這些路徑若有損毀的 JSON、非預期檔案或符號連結，工具也可能因無法安全檢查而停止；這表示需要先修復或確認該目標，**不表示整個 `.cursor/` 都是 SDD 產物**。只含使用者自己 hook 或規則的 `.cursor/` 不會因此被當成舊 SDD 安裝。

`repo-local` 模式請在替換目標 repo 的工具副本前清理。`shared-sibling` 模式請先檢查共用該 checkout 的各 repo，再對工具 checkout 執行 `git pull`；新版 `sdd update` 會在變更相關 repo 的安裝資料前檢查所有受影響 repo，但無法阻止外部的 `git pull`。清理後再從新版工具執行更新。
