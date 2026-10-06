# 平台探測

探測只記行為，不記使用者專案路徑，也不記 run 內容。格子沒有實測結果就維持空。空格不是「等同某個已填支援的平台」。

列名：

- `delegate`：獨立上下文的委派
- `readonly_review`：唯讀審查
- `browser`：瀏覽器
- `block_destructive_git`：擋 `git reset --hard`、force push、刪寫入範圍外的檔
- `block_git_commit`：擋直接 `git commit`
- `grant_enforcement`：平台強制點能讀現行 run 的 `manifest.grants[]`；對 guard 已分類為需要 grant 的操作，只有同 op 且 scope 涵蓋時放行，否則拒絕。`user_action` 不適用 grant
- `block_install_network`：擋裝依賴與連網
- `verify_on_stop`：工作結束時跑 verify
- `user_action`：擋 agent 執行使用者專屬命令（`sdd spec approve`、`sdd plan approve`、`sdd approval revoke`、`sdd review carry`、`sdd run route --by user`、`sdd grant add`、`sdd review write --reviewer-kind human`）；任何 grant 都不能放行

`true` 是這次實測做得到。`false` 是這次實測做不到。鍵不存在就是還沒測。功能表或文件不算實測。還沒測的格子在 `capability_limits` 記 `measured: false`；實測做不到的記 `measured: true`。

路線列不進 `capability_limits`。定義是在該平台用 adapter 實際走完一次這條路線：

- `direct`
- `full_pipeline`
- `selected_advisors`

這三列的鍵不存在就是還沒走完。`instructions` 的 `verified` 讀這三列。

## Cursor

委派：在這個工作階段派出一個新的子代理，沒有把父對話交出去。子代理回覆它看不到父對話。`delegate` 填 `true`。

瀏覽器：這次打開 `https://example.com/`，頁面標題是 Example Domain。`browser` 填 `true`。

唯讀審查：派出的探索子代理用寫入工具把一個檔寫成功了。這不是唯讀審查。沒有另外觀察到唯讀審查回合。`readonly_review` 維持空。

工作結束時跑 verify：這次沒有裝上並觀察到結束 hook 真的跑了驗證。`verify_on_stop` 維持空。

擋破壞性 git、擋直接 `git commit`、擋裝依賴與連網：這次沒有在 Cursor 裡裝 hook 並觀察到命令被擋下。三格維持空。

## Claude Code

命令列在，本機狀態顯示已登入。非互動回合回 401，OAuth token 過期，回合沒有跑起來。沒有觀察到獨立委派、唯讀審查、瀏覽器、結束時跑 verify，也沒有在真的 Claude Code 裡跑到 hook。`integrations/claude-code/hook.js` 在假的設定檔裡能依 grant 擋 force push，那不是這格的實測。上述格子維持空。

## Codex

命令列已登入。功能表把 `hooks`、`multi_agent`、`browser_use` 標成 stable。功能表不是實測結果。

這次用 `codex sandbox -c sandbox_mode="workspace-write"` 跑指令：

- `git commit` 無法建立 `.git/index.lock`（Operation not permitted），commit 沒有產生。sandbox 外的同一個 commit 有產生。`block_git_commit` 填 `true`。
- `git reset --hard` 同樣無法建立 `index.lock`，工作樹沒有被重置。
- `git push --force origin main` 有跑起來。失敗原因是沒有 `origin`，不是 sandbox 拒絕。
- 刪除 workspace 外的一個檔成功了。
- 所以「擋破壞性 git」整列做不到。`block_destructive_git` 填 `false`。
- `curl` 對 `https://example.com` 成功。連網沒有被擋。`block_install_network` 填 `false`。

`sandbox_mode="read-only"` 時 `touch` 被拒絕。審查回合沒有跑起來：非互動 exec 在送出前就因 CLI 與設定裡的模型不相容而失敗，檔案沒有被改到，但也沒有觀察到審查。`readonly_review` 維持空。

沒有派出一個看不見父提示的子代理。`delegate` 維持空。沒有在工作結束時跑到 verify。`verify_on_stop` 維持空。沒有打開瀏覽器。`browser` 維持空。


## 2026-10-05 執行與交付探測

本批 Stop adapter 契約依 [Claude Code hooks](https://code.claude.com/docs/en/hooks#stop) 的 Stop 決策輸出與 `stop_hook_active`，以及 [Cursor hooks](https://cursor.com/docs/hooks) 的 `followup_message`、`loop_count`、`status`。文件確認介面，不代表本機平台執行成功。自動繼續、可信 reviewer 來源與可信操作授權來源在實機通過前維持 unmeasured／unconfirmed，不補填能力矩陣。

本機讀取結果：Claude Code 2.1.123 的 `claude auth status` 回 `loggedIn: false`；Cursor agent 2026.09.23-86fc751 的 `cursor agent status` 回 Authentication required，`cursor --help` 另回找不到 Cursor IDE。無法跑已登入的受控平台回合；本批不登入、不更改帳號設定。恢復點：在已登入的測試平台安裝 fixture hook，觀察一次可繼續、同判定兩次上限、使用者中止／API 錯誤與等待人處理，再確認平台 permission 沒有被放寬。adapter fixture 測試只能證明 JSON／迴圈／安裝邏輯。

`user_action` 攔截範圍新增 `sdd grant add` 與 `review write --reviewer-kind human`；普通 CLI 自填來源不算可信人類授權。這些本地防護不代表已解決未實測平台的審查者冒充。Codex 本階段只使用 AGENTS 與 run next，無 Stop hook 強制能力宣稱。

2026-10-06 收尾再次讀取登入狀態：Claude Code 仍為 `loggedIn: false`，Cursor agent 仍回 Authentication required。平台實機續跑與可信來源能力維持未量測；沿用上述恢復點。
