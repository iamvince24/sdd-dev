# Pilotfish 對照

讀取日：2026-09-26。對象是 [Pilotfish](https://github.com/Nanako0129/pilotfish) 當時的預設分支，plugin manifest 版本 1.4.2。這份備忘不把對方的設定格式抄進 `models.json`。

## 它有什麼

Pilotfish 是 Claude Code 的多模型編排政策。主工作階段負責計畫、核准、整合與最後判斷；搜尋、重複修改、測試與文件交給較小的角色。安裝有兩條：Plugin beta（macOS／Linux，用 SessionStart hook 帶入政策），以及舊的全域安裝（設定、`agents/*.md`、政策檔）。

角色寫在 agent 檔的 frontmatter：`model` 用別名、`effort`、工具允許或禁止清單。設定片段是主模型加 fallback 清單。政策還有互動形狀：目標清楚且範圍小就直接做，方向清楚但影響大就先探再計畫，結果或驗收還不清楚就一起把問題問清楚。風險而不是檔案數決定要不要獨立審查。它自己也寫明，平台較高優先的指令可以壓掉自動委派，所以委派不是保證。

角色大致是：scout、Explore、plan-verifier、mech-executor、executor、security-reviewer、security-executor、verifier。審查判決用 READY／REVISE，結果核對用 CONFIRMED／REFUTED／INCONCLUSIVE。verifier 要新的上下文，只讀和重跑，不改檔、不修、不再派。

## r5 的 `models.json` 要什麼

`models.json` 維持選填物件。開 run 時把當下內容抄進 `manifest.models`，之後不改這份歷史。鍵是角色，值是模型 id。空值表示用該平台當下的模型。流程碼和角色指令不出現模型名稱字串。Pilotfish 不進依賴。

## 不採用

- 不採用它的設定片段形狀，也不把模型別名寫進角色檔 frontmatter。模型只放在 `models.json`。
- 不採用 effort、工具允許清單、或把某個模型家族綁死在某個角色。
- 不採用 SessionStart hook 當強制點。r5 的 hook 只呼叫 `sdd check`，並拿指令去比 `manifest.grants[]`。
- 不採用它的角色切分。r5 的六個角色是 scout、planner、plan-reviewer、executor、security-reviewer、verifier。沒有 Explore、mech-executor、security-executor，也不把 plan-verifier 當成另一套判決格式。
- 不採用 CONFIRMED／REFUTED／INCONCLUSIVE 取代驗收狀態。驗收狀態仍是 `pass`、`fail`、`not_run`、`blocked`。計畫與結果審查仍是 `READY`、`REVISE`、`BLOCKED`。
- 不採用互動形狀或「便宜角色吸收大量工作」當選路政策。路線仍是 `direct`、`selected_advisors`、`full_pipeline`，加上 `fast_lane`、`cross_check`、`no_delegation`、`plan_only`。
- 不採用只服務 Claude Code 的 plugin manifest、全域設定路徑，或「主工作階段一定是某個模型」的預設。三個平台共用同一份來源，包裝不同。
