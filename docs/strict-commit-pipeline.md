# 嚴格 Per-Commit Pipeline 模式（選用）

這是「建議 Commit 規劃」表的另一種執行方式，跟 `progress-rhythm.md`〈Commit 與 staging〉
的預設流程（主 session 直接做、做完一個階段自己確認、commit 由使用者明確要求才執行）
並存——**兩者只能擇一，由使用者當場選**，這份文件只規定選了嚴格模式之後怎麼跑。

## 什麼時候問、問什麼

G2 核准完成、準備開始寫程式碼的那一刻，Claude 必須用 `AskUserQuestion` 問使用者：
這次要走嚴格 per-commit pipeline，還是 `progress-rhythm.md` 的原本階段確認流程。
沒問過不能動程式碼——這一條併入 `README.md`〈對 Claude 的規則〉。

選定的模式套用到「建議 Commit 規劃」表裡**全部**待做的 commit，不是每個 commit 重問一次；
使用者隨時可以中途喊停或換模式。

## 每個 commit 的流程

依「建議 Commit 規劃」表逐列、**依序**執行（不平行——commit 之間有前置依賴，
例如後面的 commit 建立在前面 commit 已落地的程式碼上，執行者直接讀當下的檔案狀態即可，
不需要主 session 重述前一個 commit 做了什麼）：

1. **組一次性執行 brief**：這個 commit 涵蓋的任務 ID、對應 AC、要動的檔案、Done 條件、
   相關既有慣例（D 決策編號）——用檔案路徑指到 `01-plan.md`／`02-tasks.md` 對應段落讓
   執行者自己讀，不整段貼文字進 brief。
2. **派一個獨立 `executor`**（這個 commit 的任務在 `02-tasks.md` 裡已經寫死到不需要任何
   設計判斷——例如純別名賦值、複製既有 pattern——才改派 `mech-executor`）執行這份 brief，
   對這批檔案有專屬所有權。
3. 收到結果後，**派一個全新的 `verifier`**，只給它這個 commit 的 AC、Done 條件與相關 diff。

### 驗證範圍：目前只做程式碼層級核對

`verifier` 這一步**目前只做**：邏輯是否符合 Done 條件與 AC、有沒有既有可跑的 lint／腳本
（`coverage-lint.js` 之類、專案既有的 lint/test 指令）能跑得動並通過。

**明確不做**：真正的瀏覽器／互動行為驗證。若專案沒有自動化 UI 測試套件，或 `verifier`
角色沒有瀏覽器工具可用，就必須把這類驗證留給人工確認——假裝驗了等於偽造證據，比不驗更糟。

4. **`verifier` 回 CONFIRMED** → 主 session：
   - 把該列在 `notes.md`「Commit Pipeline 狀態」表(見下面〈機器保護〉一節)的狀態改成
     `verifier_confirmed`——**這一步必須先做,再執行 `git commit`**,`pipeline-commit-hook.js`
     靠這個值判斷放不放行,沒改就 commit 會被攔下來(目前是 warn,之後可能轉真的擋)。
   - 把這個 commit 涉及的 AC／Done 條件記進「待人工確認清單」(見下一節),**不管是否
     全部或部分只驗了程式碼邏輯**——只要牽涉瀏覽器／互動行為的 AC 一律進清單。
   - `git add` 這個 commit 範圍的檔案,用 `02-tasks.md`「建議 Commit 規劃」裡已經預先
     寫好的 commit message 執行 `git commit`(遵守 `progress-rhythm.md` 既有規則:
     不加 Co-Authored-By、內文精簡)。
   - commit 成功後,把 `notes.md` 該列的狀態改成 `committed`。
   - 依 `progress-rhythm.md` 既有規則,把 `02-tasks.md` 對應任務列狀態改 `done`、
     更新 `notes.md` 進度。
   - 進下一個 commit,把 `notes.md` 該列的狀態依序填 `executor_dispatched`／
     `verifier_dispatched`(可選,純供中斷後復原用)。
5. **`verifier` 回 REFUTED**:把具體失敗證據回饋給新一輪 `executor` 重做,**最多重試一次**
   (第二次還不過就停,不第三次同層重試)→ 把 `notes.md` 該列狀態改成 `refuted_retry`;
   仍失敗就改成 `paused_for_user`,用 `AskUserQuestion` 問使用者,不自己決定要不要硬 commit。
6. **`verifier` 回 INCONCLUSIVE**:只有在牠指出具體缺什麼證據、且那個證據可以補齊時才重試
   一次;否則同上改成 `paused_for_user`,暫停該 commit 問使用者。

## 機器保護:`notes.md` 的 Commit Pipeline 狀態表

上面「誰驗過才能 commit」不是只靠 Claude 記得——`pipeline-guard.js`(唯讀檢查)與
`pipeline-commit-hook.js`(PreToolUse hook)會真的去讀這個狀態、攔下不符合條件的
`git commit`,細節見 `automation.md`。這個狀態記在**該專案的 `notes.md`**(不是
`02-tasks.md`),因為 `notes.md` 從來不被任何 G1/G2/G3 指紋函式讀取,加這個區塊不會弄壞
任何 Gate 核准指紋。

**選定嚴格模式當下**,主 session 要在該專案 `notes.md` 新增這個區塊(`Commit` 欄的編號要
跟 `02-tasks.md`「建議 Commit 規劃」表一致,這是 Claude 手動維護一致性的責任,腳本不跨檔案
比對):

```
## Commit Pipeline 狀態

**模式**：`strict-commit-pipeline`

| Commit | Pipeline 狀態 | 時間 |
| --- | --- | --- |
| 1 | todo | |
| 2 | todo | |
```

「Pipeline 狀態」欄是固定字面值,不是自由文字(仿照 `todo`/`wip`/`done`/`PASS`/`FAIL` 的
既有慣例):

| 值 | 意義 |
| --- | --- |
| `todo`(或空白) | 這個 commit 還沒開始 |
| `executor_dispatched` | executor 已派出,尚未回報 |
| `verifier_dispatched` | verifier 已派出,尚未回報 |
| `verifier_confirmed` | verifier 回 CONFIRMED——**唯一允許執行 `git commit` 的狀態** |
| `committed` | `git commit` 已完成 |
| `refuted_retry` | verifier 回 REFUTED,第一次重試中 |
| `paused_for_user` | 重試後仍失敗(或 INCONCLUSIVE 補不齊證據),已暫停等使用者決定 |

`pipeline-guard.js` 找「由上到下第一列狀態不是 `committed`」當作目前列;不是
`verifier_confirmed` 的任何值(含空白、含打錯字)一律視為不可 commit,預設落在安全側。
`pipeline-commit-hook.js` 目前是 `warn` 模式(累積 `.pipeline-hook-log` 證據、確認不會
誤擋一輪完整流程之後才會手動轉 `block`,比照 `gate-hook.js` 的畢業節奏)。

## 權限邊界

這個模式只授權**本機 `git commit`**。`push`／`gh pr create`／`gh pr merge`／`git merge`
**一律被 `pipeline-commit-hook.js` 立即硬擋(不設 warn-only 觀察期,整個 repo、不分模式)**
——這支腳本沒辦法分辨「使用者剛剛親口要求」跟「Claude 自己決定」,所以連使用者當場要求時
也會被攔下。**真正需要 push／建 PR／merge 時,請使用者自己用 `! <command>` 在終端機執行**
(不經過 Claude 的 Bash 工具呼叫,不會被這支 hook 攔到)。

## 全部 commit 完成後：待人工確認清單

最後一個 commit 落地（或整個 pipeline 因暫停／使用者喊停而結束）時，主 session 把
第 4 步累積的「待人工確認清單」整理成一張表，**同時**：

- 直接貼進聊天回覆給使用者，讓他當場能照著清單操作瀏覽器驗。
- 寫進這個專案的 `03-verify.md`：每條進清單的 AC 一列，狀態填「程式碼核對 PASS／待人工確認」，
  證據欄註明對應的 commit（hash 或訊息第一行）與 `verifier` 給出的核對依據；
  **不是**直接判 `PASS` 或留 `PENDING`——這條狀態是給 `verify-evidence-lint.js`／G3
  流程看的中繼狀態，之後使用者實際操作驗過，再由 Claude 或使用者改成真正的 `PASS`／`FAIL`。

表格欄位建議：

| AC | 對應 commit | Done 條件摘要 | 需要怎麼手動確認 |
| --- | --- | --- | --- |
| （例）R1.3 | commit 2 | 上傳滿 8 張時入口隱藏或停用 | 瀏覽器上傳 8 張圖，確認第 9 張上傳入口消失/停用 |

## 與 `progress-rhythm.md` 的關係

Commit message 的格式規則（不加 Co-Authored-By、精簡內文、粒度對應需求切片）沿用
`progress-rhythm.md`〈Commit 與 staging〉，這份文件不重複定義，只多規定「誰來執行、
誰來驗、什麼時候自動 commit」。
