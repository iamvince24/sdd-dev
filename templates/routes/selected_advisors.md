---
route: selected_advisors
---

<!-- sdd-rule -->
這份指令只適用 manifest.route 為 selected_advisors 的 run。ag 與 agentflow 是 full_pipeline 的別名，不是這條路線。route 不是 selected_advisors 就停。

沒有實作授權。`manifest.implementation_authorized` 維持 false。不要改產品碼，不要執行 `sdd commit`，不要把任務標成 `in_progress`。產品碼相對 baseline 出現新的 diff 就停；baseline 本來就有的修改不算。用 `sdd check --stage dev` 看越界。核准是使用者的動作。不要執行 `sdd spec approve`、`sdd plan approve`、`sdd approval revoke` 或 `sdd review carry`。

先執行 `sdd context --role <role>`，只打開清單裡的路徑。產物只用 sdd 命令寫。不要手改核准檔、凍結 revision、evidence 或 manifest。開 run 時帶 `--platform`，值用這份指令對應的平台 id。沒帶、也沒有 `SDD_PLATFORM`，平台就是 unknown。

先查文件、codebase，或在該 run 的 `scratch/` 做小實驗，再問使用者。假設被推翻就重查。阻塞只停受影響範圍。不要把自己評成獨立。不要跑沒有 `sdd grant check` 命中的破壞性操作。不要在流程產物裡寫模型名稱。

局部阻塞用 `sdd block add --id <B-n> --affects <R-n,AC-n,T-n> --condition <text>`，解除用 `sdd block resolve <B-n> --evidence <path|sha>`。問題用 `sdd problem add --impact <text> --handling <text> --reason <text>`；會擋住下游時加上 `--blocks-downstream --affects <T-n,...>`。解除問題用 `sdd problem resolve <P-n> --result <text> --evidence <path|sha>`，沒有證據就不能解除。使用者中止用 `sdd run stop --reason <text>`。status 是 stopped 之後，`sdd run done` 會失敗。直接的 `git commit` 會被擋下，改走 `sdd commit`。刪掉寫入範圍外的檔需要 `delete_outside_roots` grant。核准類命令沒有 grant 可以放行。安裝平台 hook 用 `sdd hook install --platform <平台 id>`，解除用 `sdd hook uninstall --platform <平台 id>`。

修飾詞：

- `fast_lane` 只減篇幅。不減該問的問題、不減證據、不把諮詢變成實作授權。
- `plan_only` 在這裡沒有開發階段。計畫或諮詢結論寫完就停，等使用者。
- `no_delegation` 不允許 agent 審查寫 `independent: true`。
- `cross_check` 要有 result review。它不授權改產品碼。
- `no_delegation` 加上 `cross_check` 時，result review 維持 `pending_human`。

諮詢結論寫回 clarify 或 spec 時用 `sdd spec write` 與 `sdd check --stage spec`。需要實作就停下來建議改路線，建議可先 `sdd route suggest --risk <feature>`。不要自己升到 full_pipeline，也不要開始改產品碼。
<!-- /sdd-rule -->
