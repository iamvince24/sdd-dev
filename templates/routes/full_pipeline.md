---
route: full_pipeline
---

<!-- sdd-rule -->
這份指令只適用 manifest.route 為 full_pipeline 的 run。ag 與 agentflow 是這條路線的別名，不是另外一條路線。route 不是 full_pipeline 就停。

先執行 `sdd context --role <role>`，只打開清單裡的路徑。不要把整包 run 塞進上下文。產物只用 sdd 命令寫。不要手改 `spec/revisions/`、`plan/revisions/`、`approvals/`、已寫入的 evidence 或 manifest。開 run 時帶 `--platform`，值用這份指令對應的平台 id。沒帶、也沒有 `SDD_PLATFORM`，平台就是 unknown。

先查文件、codebase，或在該 run 的 `scratch/` 做小實驗，再問使用者。假設被推翻就重查。阻塞只停受影響範圍。不要把自己評成獨立。不要跑沒有 `sdd grant check` 命中的破壞性操作。不要在流程產物裡寫模型名稱。

局部阻塞用 `sdd block add --id <B-n> --affects <R-n,AC-n,T-n> --condition <text>`，解除用 `sdd block resolve <B-n> --evidence <path|sha>`。問題用 `sdd problem add --impact <text> --handling <text> --reason <text>`；會擋住下游時加上 `--blocks-downstream --affects <T-n,...>`。解除問題用 `sdd problem resolve <P-n> --result <text> --evidence <path|sha>`，沒有證據就不能解除。使用者中止用 `sdd run stop --reason <text>`。status 是 stopped 之後，`sdd run done` 會失敗。直接的 `git commit` 會被擋下，改走 `sdd commit`。刪掉寫入範圍外的檔需要 `delete_outside_roots` grant。核准類命令沒有 grant 可以放行。安裝平台 hook 用 `sdd hook install --platform <平台 id>`，解除用 `sdd hook uninstall --platform <平台 id>`。

核准與驗證：

- 核准是使用者的動作。agent 不執行 `sdd spec approve`、`sdd plan approve`、`sdd approval revoke`、`sdd review carry`，也不執行 `sdd run route --by user`。
- 沒有蓋到現行 spec revision 的核准，就不能 `sdd plan write`。核准要嘛 hash 等於現行 revision，要嘛 `carried_from` 鏈到現行 revision 且每一段都過。
- 沒有蓋到現行 plan revision 的核准，就不能把任務標成 `in_progress`。`plan_only` 在核准前出現 `in_progress` 也失敗。
- 依賴任務的每條驗收必須是 `pass`、不是 `stale`，而且這次有自己的證據。`preexisting` 不是通過。
- 沒有現行 revision 的獨立 result review 為 `READY`，就不能 `sdd run done`。executor 的 `context_id` 不能拿來當這份審查的 `context_id`。
- `sdd commit --task T-n` 是 agent 唯一的 commit 入口。`auto_commit` 不是 true、驗收的 `codebase_ref` 對不上工作樹、staged 路徑超出該任務、或檔案在 baseline 就髒又被這次改到，命令會拒絕，而且不改 git 歷史、不 push。

修飾詞擋的是這些事，不是另開路線：

- `fast_lane` 只減篇幅、合併重複紀錄。不減 spec 核准、plan 核准、獨立審查、驗證。
- `plan_only` 在計畫通過審查後把 run 設成 `awaiting_user`，不開 `in_progress`。使用者核准 plan 之後才回到 `active`。
- `no_delegation` 不允許 `reviewer_kind: agent` 寫 `independent: true`。要獨立就由人審查，或使用者解除這個修飾詞並記進 `route_history`。
- `cross_check` 由這份 result review 滿足，不加第二個 reviewer。
- `no_delegation` 加上 `cross_check` 時，result review 維持 `pending_human`。agent 不能把自己標成獨立。

步驟：spec 寫完執行 `sdd spec write` 與 `sdd check --stage spec`。使用者執行 `sdd spec approve` 核准現行 revision 之後才寫 plan。plan 寫完執行 `sdd check --stage plan`。full_pipeline 要有獨立且沒有未解 blocking 的 READY 計畫審查，用 `sdd review write --kind plan`，才能由使用者執行 `sdd plan approve`。沿用審查是使用者的動作，用 `sdd review carry --kind plan|result --from <n>`。推翻核准用 `sdd approval revoke --artifact spec|plan --reason <原因>`，也只由使用者執行。開發中執行 `sdd verify` 與 `sdd check --stage dev`。越界會回報 `route_reassess`。要改路線先問使用者，使用者再用 `sdd run route --route <route> --reason <原因> --by user`。選路建議用 `sdd route suggest --risk <feature>`，只寫 `route_history` 的 `by: auto`。不要自己改 route。結果審查用 `sdd review write --kind result`。收尾用 `sdd run done`。
<!-- /sdd-rule -->
