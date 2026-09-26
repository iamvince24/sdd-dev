---
route: direct
---

<!-- sdd-rule -->
這份指令只適用 manifest.route 為 direct 的 run。route 不是 direct 就停。ag 與 agentflow 是 full_pipeline 的別名，不是這條路線。

先讀 `.sdd-dev/runs/<run_id>/manifest.json`、它的 sources、以及 workspace。先查文件、程式，或在該 run 的 `scratch/` 做小實驗，再問使用者。假設被推翻就重查，不要沿用被推翻的假設。阻塞只停受影響範圍。不要把同一上下文的自評標成獨立審查。不要在流程產物裡寫模型名稱。

產物只透過 sdd 命令寫入。不要手改 `spec/revisions/`、`approvals/`、已寫入的 evidence，也不要手改 manifest。

破壞性操作先執行 `sdd grant check --op <op> --scope <scope>`。沒有命中就停下來問。op 只有 reset_hard、force_push、history_rewrite、delete_outside_roots、prod_write、external_data_write、dependency_install、lockfile_change、network。計畫核准不是這些授權。秘密值不寫進紀錄；證據用 `sdd evidence write --ac <id>`，工具會遮掉辨識到的憑證形狀。

使用者指定的 fast_lane、cross_check、no_delegation、plan_only 在 `sdd run start` 用 `--fast-lane`、`--cross-check`、`--no-delegation`、`--plan-only` 寫進 manifest。沒帶的旗標是 false。不要手改 manifest 來翻旗標。

步驟：

1. 影響範圍看功能、共用介面、資料與使用者，不看檔案數。需求不明、難回復、碰到對外介面、資料遷移、安全邊界，或沒有足夠的驗證方法時，停下來建議改路線。不要自己升路，也不要開始改產品碼。選路不擴大實作授權。

2. 寫簡短 Execution Spec，用這些章節標記：sources、clarifications、scope、exclusions、constraints、interfaces、assumptions、deviations、requirements、acceptance。每條需求至少一條驗收，含 given、when、then、kind（normal、error、boundary）、pass。與原始需求的每條差異寫在 deviations，並引用已回答的 Q-n。然後執行：

   sdd spec write --file <path>
   sdd check --stage spec

   檢查失敗就改完再寫一次。direct 不另強制規格核准，除非使用者要求先停。使用者要求時，停在核准前，不要改已核准的 revision。

3. 準備簡短計畫：任務、擁有的路徑、每條驗收的驗證方法，以及需求到驗收到任務到證據的對應。寫入用 `sdd plan write`，角色輸入用 `sdd context`。不要手改 `plan/revisions/`、`approvals/` 或 manifest。

4. 旗標為 true，或使用者已口頭指定時：

   fast_lane 可以縮短篇幅、合併重複紀錄。不可以拿掉範圍、驗收、追溯與必要驗證。

   plan_only 在計畫寫完後停下等使用者，不改產品碼。使用者核准計畫後才繼續。stopped 只表示使用者中止。

   cross_check 在完成前要有另一個唯讀審查看實際成果與證據。審查用 `sdd review write --kind result`。同一上下文不能把自己標成獨立審查。

   no_delegation 不派第二個 agent。需要獨立審查時留給人，或請使用者解除這個限制。它與 cross_check 同時成立時，同樣不派第二個 agent。

5. 有證據才執行 `sdd evidence write --ac <id>`，需要重跑時用 `sdd verify`。沒有簡短 spec、沒有驗收對上任務、沒有證據，就不能執行 `sdd run done`。cross_check 成立時還要有 result review。不要自己把 manifest.status 改成 done。

6. 確認需求階段的實驗只寫該 run 的 `scratch/`。產品碼只在使用者已授權實作、且落在計畫宣告的路徑時才改。
<!-- /sdd-rule -->
