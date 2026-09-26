# Verification-Driven SDD（以驗證回饋取代預先控制）

| 欄位 | 內容 |
| --- | --- |
| 日期 | 2026-09-25 |
| 狀態 | proposal — D13–D20 已拍板；同日 review 後修訂 D13、D14、D15、D17、D20、第 3 節與第 4 節。同日二次 review 再修訂 D14、D15、D16、D20、第 3–6 節，新增 4.1「SV-spike 判定」。三次 review 再修訂 D14、D15、D16、D17、D20、3.1、3.3、3.5、第 4–5 節，SV-spike 拆成 spike-a／spike-b。SV-spike、SV 與修訂後的 S0–S7 待執行 |
| 範圍 | SDD 流程本身的定位（Spec 負責什麼、Gate 擋在哪裡）、驗證層、模板與規則的取捨 |
| 不含 | 任何專案私有 state；本文只談公開工具本身 |
| 前置 | `2026-09-14-claude-code-workflow-review.md`（D0–D5、P0–P8）、`2026-09-15-open-source-readiness.md`（D6–D12、S0–S7） |

> 這是一份分析與提案，不是規則。拍板後的規則會回寫到 `docs/` 既有文件或新的 skill，
> 本文保留為「為什麼這樣改」的紀錄。
>
> 編號延續前兩份：問題用 `VD-n`（verification-driven），決策接在 D12 之後用 `D13` 起。
> 新增的執行階段叫 `SV`，插在 09-15 的 S2 與 S3 之間。
> 本文取代或修訂的條目，前兩份只在 metadata「狀態」欄標註，內文保留原貌。

## 0. 定義與結論

> **SDD 的目的不是替 Coding Agent 寫出完整的實作流程，而是提供足夠的意圖、限制與驗收條件，
> 使 Agent 能自主決定實作方式，並透過可執行的驗證與環境回饋持續修正結果。**
>
> **流程、Rules 與 Agent orchestration 應只在能解決已知 failure mode 時加入，
> 並隨模型能力提升持續重新評估。**

這段定義要放在 README 最前面，取代現在「Gate 未核准不得改程式碼」的定位（D13）。

對照現況，這個工具目前做的是另一件事：

1. **沒有任何 checker 驗產品行為。** `devplan check` 的每一個 Gate 組合都只讀 markdown（VD-1）。
2. **強制點在改檔前。** hook 在 G1／G2 未核准時擋 Edit／Write，這正是「用 Spec 預先控制實作路徑」（VD-4）。
3. **證據是 agent 自我申報。** G3 的「可重現證據」由 agent 寫進表格，checker 只驗文字長得像不像證據（VD-2）。

所以這次不是把模板寫短，而是補一層目前完全不存在的驗證層，再把強制點從「改檔前」搬到「驗收時」。

新方向本身有一個沒提到的盲點：**越依賴驗證，agent 越有動機去改弱驗證本身**
（放寬 AC、改測試、skip 測試）。09-14 的 P0-B.1 實驗就是這件事的實測版本（VD-3）。
因此前兩份在 enforcement 上的投資不是白費，而是換保護對象：
從「保護 plan 核准」改成「保護契約與 oracle」。

### 0.1 五個原則在本工具的落點

| 原則 | 現況 | 本文的處理 |
| --- | --- | --- |
| Spec 定義 Outcome，不定義 Path | `00-spec.md` 已經只寫 What／Why；但 Tier M 強制 `02-tasks.md`，hook 的路徑判定也要求事先宣告「檔案」欄 | tasks 改條件式（D17），Gate 不再依賴事先宣告的路徑（D13） |
| 正確要 machine-verifiable | AC 要求「能客觀判定真假」，但沒有欄位寫「怎麼判定」，也沒有工具去跑 | AC 帶驗證欄（D20），`devplan verify` 執行並產生證據（SV） |
| Rules 是 failure-driven | 模板約 40–50% 是規則散文；09-14 的 D3 打算把它搬進 SKILL.md | 每條規則要登記它解的 failure，沒有就刪或標 `review` 待補，不是搬家（D18） |
| 能交給 Tool 就不交給 Prompt | 模板到處貼「記得跑 `devplan check`」；G3 證據靠 regex 判斷文字 | 驗證由 hook 自動跑並餵回模型（SV）；指令指向 repo 既有 script，不重做 lint／test |
| Workflow 要 adaptive | L 項目固定走 spec、plan、tasks，嚴格模式再加 per-commit executor／verifier | Tier 拆 risk 與 horizon 兩軸（D17）；strict pipeline 降為選用（D19） |

### 0.2 與前兩份的關係

| 前兩份的項目 | 本文的處理 |
| --- | --- |
| 09-14 D0（真 enforcement：Gate 未核准不得改程式碼） | **被 D13 取代。** 強制點移到驗收。D0 否決的替代方案（把 enforce 收窄到 push／merge）在新方向下大致成立；否決理由「等於 checklist automation」不再適用，因為 Gate 背後改跑真實驗證 |
| 09-14 P0-A、P4、D4（核准狀態與 `approve`） | 保留，範圍縮到 G1 契約與 G3 驗收（L tier 另含 G2） |
| 09-14 P0-B.1（指紋豁免可被單方面觸發） | 保留且最優先。重新定性為 VD-3（oracle 被改弱）的一個實例 |
| 09-14 P0-B.2（G1 只在 branch 選中時檢查） | 降級。只剩 L tier 的改檔前提醒用得到，選錯 item 只影響提醒內容 |
| 09-14 P0-B.3（exit 3 與例外 fail-open） | 保留，但 fail-closed 原則改套在驗收 Gate、`archive` 與 CI |
| 09-14 P0-B.4（regex 猜 bash 寫入目標） | 大部分刪除。`WRITE_PATTERNS` 不再作為強制判定；`git status` 對帳留作範圍偏移的 audit 訊號 |
| 09-14 P0-B.5／.6／.8 | 保留（純 correctness） |
| 09-14 P0-B.7（`archive` 不驗 G3） | 升級。`archive` 就是驗收 Gate 的落點 |
| 09-14 P1（warn 對模型隱形） | 升為 SV 的第一步。feedback 餵回模型是整個新方向的前提 |
| 09-14 P2、P3 | 保留。P3 的 snapshot 內容改成最小集合（見 3.5） |
| 09-14 P5（Tier S/M 也複製六個模板） | 被 D17 取代 |
| 09-14 P6、P8、D3（規則落點與模板瘦身） | 被 D18 取代：問題從「散文該住哪」換成「這條規則該不該存在」 |
| 09-14 P7（零 contract test） | 保留；另補 harness eval（D18，排在最後） |
| 09-14 §3 hooks 分工 | 改寫：`Stop` 從記帳改成跑驗收驗證；`PostToolBatch` 加跑 fast checks（3.5） |
| 09-14 §3 `agents/` 五個 subagent | 改條件式，只在 L tier 或 D19 的選用模式派出 |
| 09-14 D2（audit／confirm／enforce） | 保留，輸出契約提前到 SV 實作 |
| 09-14 D5（執行順序） | 被第 4 節的新順序取代 |
| 09-15 OS-1、D6、D12 | 不受影響 |
| 09-15 OS-2、D11 | 保留；AC 表格改版（D20）與 anchor 化合併在 S1 一次做 |
| 09-15 OS-3、D7（先修完 P0-A + P0-B 才開源） | 由 D13 修訂：開源前置條件改為「驗證層與驗收 Gate 可用」 |
| 09-15 D8、D9 | 保留；D9 的 Cursor adapter 要多支援 `stop` 與 `postToolUse`（3.5、附錄 A） |
| 09-15 D10（TTY gate + HMAC） | 被 D16 修訂：拿掉 HMAC，改由 CI 重算指紋 |
| 09-15 S2 | 拿掉 `~/.devplan/approval.key` 的生成（D16），其餘不變 |
| 09-15 S3 | `approve` 與 `approvals/<item>.json` 移進 SV（D16）；S3 只剩 deny 清單、CI 範本與 CODEOWNERS 指引 |
| 09-15 S4 | 縮小，見第 4 節 |
| 09-15 S6 | 改成依 D18 的 registry 刪規則，再依 D17 產 tier-aware 模板 |

## 1. 問題

### VD-1 — 沒有任何 checker 驗產品行為

`scripts/check.js:20-23` 的 Gate 組合：

```js
G1: [['schema-lint.js'], ['coverage-lint.js'], ['gate-guard.js', 'G1']],
G2: [['schema-lint.js'], ['coverage-lint.js'], ['gate-guard.js', 'G2']],
G3: [['schema-lint.js'], ['verify-evidence-lint.js'], ['gate-guard.js', 'G3']],
ARCHIVE: [['schema-lint.js'], ['verify-evidence-lint.js'], ['archive.js']],
```

這些腳本全部只讀 `.md`：表格結構、編號對帳、核准指紋、證據欄的文字型態。
目標 repo 的 test、lint、typecheck、build、E2E 沒有一個會被執行。
整個 G3 的語意是「文件宣稱驗過了」，而不是「驗過了」。

### VD-2 — 證據是自我申報，且不綁程式碼版本

`scripts/verify-evidence-lint.js:63-70` 判斷「可重現證據」的方式是比對文字型態：

````js
const EVIDENCE_PATTERNS = [
  /refs\/evidence\//,
  /\b[0-9a-f]{7,40}\b/i, // commit hash
  /[.\w/-]+\.\w+:\d+/, // file:line
  /```/, // 貼上的輸出區塊
  /"[^"]+"\s*:/, // 貼上的 JSON 片段，例如 "sort": 12
  /\$\s?\S+/, // 貼指令
];
````

任何 7–40 位的 hex、任何以 `$` 開頭的字串都算合格。它檢查的是「證據長得像證據」，
沒有人真的跑過那個指令。

另外兩個相同形狀的洞：

- **證據只綁 spec 指紋。** 驗證時記錄的是「對著哪一版 spec 驗的」，沒有記錄「對著哪一版程式碼驗的」。
  PASS 之後再改 code，那一列還是 PASS。
- **strict pipeline 的放行條件由 agent 自己寫。** `scripts/pipeline-guard.js:77` 只看 `notes.md`
  那一列是不是 `verifier_confirmed`，而 `docs/strict-commit-pipeline.md` 規定這個值由主 session 自己改。
  這跟 P0-A 是同一種洞：agent 申報、agent 放行。

### VD-3 — Oracle 可以被改弱

驗證越有強制力，「讓驗證通過」就越容易被做成「讓驗證變寬」：

- 放寬 AC 本文（09-14 P0-B.1 實測：把「匯出前必須通過權限檢查」改成「不需要」，再用修訂紀錄豁免）
- 改驗收測試的 assertion、加 `.skip`／`.only`
- 改 verify 指令（拿掉 filter、加 `--passWithNoTests`）
- 關掉 lint rule、放寬 tsconfig

現行指紋（`scripts/lib/fingerprint.js:41-47`）只涵蓋 spec 的 §4、§5、§6。
驗證指令與測試檔目前根本不在契約裡，自然也沒有保護。

### VD-4 — 強制點在改檔前，而且逼 agent 事先宣告路徑

`lib/hook.js:85-93`：G1 未核准就擋改 code；G2 未核准時擋「命中宣告路徑」的改動。
宣告路徑來自 `02-tasks.md` 的「檔案」欄（`scripts/lib/project-detect.js:36-45`）。

這條鏈造成三個後果：

1. 為了讓 hook 有東西比對，agent 必須在動手前寫好要改哪些檔。這就是 path prescription。
2. Bash 的寫入目標只能用 regex 猜（09-14 P0-B.4），原則上補不完。
3. 控制點越前面，繞過面越大；09-14、09-15 大部分 P0 條目都在修這一段。

### VD-5 — 流程固定，而且部分方向相反

- **Tier M 強制 `02-tasks.md`、把設計併進 tasks**（`docs/numbering-and-tiers.md`）。
  新方向的優先序是 Plan「中」、Task decomposition「條件式」，現況剛好倒過來。
- **Tier S 完全沒有驗證**，只在 `notes.md` 記一行。
- **`coverage-lint` 的核心規則是「每條 AC 至少一個 T」**（`scripts/coverage-lint.js:105-109`）。
  追溯鏈建立在 R、AC、Task 上，而不是 R、AC、驗證。
- **Tier 反推與 gotcha 比對都讀「檔案」欄**（`scripts/coverage-lint.js:146-215`）。沒有 tasks 就沒有這兩個檢查。
- **strict pipeline 固定每個 commit 派 executor 再派 verifier**，且明文「不做瀏覽器驗證」
  （`docs/strict-commit-pipeline.md`）。

### VD-6 — 規則以預防為主，沒有生命週期

`templates/` 共 18.8k chars，09-14 估約 40–50% 是規則散文。沒有任何一條規則記錄
「它解的是哪個 failure」與「最後在哪個模型上驗證過」。
09-14 的 D3 與 09-15 的 S6 的處理方式是把散文搬進 SKILL.md：context 成本只是換地方付，
規則本身也不會因此被重新檢驗。

## 2. 決策紀錄（D13–D20）

### D13 — 強制點從改檔前移到驗收（取代 D0）

**選定。**

| 強制點 | 做什麼 | 強度 |
| --- | --- | --- |
| `PostToolBatch`（Cursor：`postToolUse`） | 背景跑 `verify.fast`，結果在下一個 turn 餵回模型 | feedback，不擋 |
| `Stop`（Cursor：`stop`） | S tier，或 M／L tier 的 G1 已核准後，且本 item 的 oracle diff 非空時，跑 acceptance 驗證；Claude Code 在背景跑，失敗才喚醒 agent | feedback，有重試上限 |
| G3／`devplan archive` | 要求機器證據在目前程式碼上 PASS、指紋與核准一致 | 硬擋 |
| CI（D15） | 重跑驗證、重算指紋 | 硬擋，agent 在本機碰不到 |
| `PreToolUse` deny | 只剩：Edit／Write 寫入 `.devplan/approvals/**` 或 `.devplan/local/evidence/**`、agent 執行 `devplan approve`、push／merge／開 PR | 硬擋 |
| L tier 的改檔前提醒 | G1 或 G2 未核准時 Edit／Write 照常放行，另外把「G1／G2 尚未核准」餵給模型 | audit，不詢問、不 deny |

S／M tier 沒有改檔前檢查，L tier 只有提醒。原本「G2 未核准就擋改檔」的路徑判定整段刪除，
`WRITE_PATTERNS`／`commandTargets` 不再作為強制判定。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 完全移除改檔前檢查，連提醒都沒有 | L tier（碰信任邊界，或多個 risk 同時命中）先做錯方向的代價高；提醒幾乎沒有成本 |
| L tier 未核准時 `ask`，同一個 session、同一個 item 只問一次（初稿選定） | 需要 PostToolUse 記 ack、`.devplan/local/ack/` 狀態，還依賴 `session_id` 在 resume 與 compact 後是否沿用；Cursor 的 `preToolUse` 又不執行 `ask`，兩個平台行為不一致。它防的是「G2 核准前就動工」造成的重工，不是錯誤被 merge，後者 G3 已經擋住。沒有觀察到的 failure 支撐這個成本（D18） |
| 保留 D0 的改檔前強制，另外疊一層驗證 | 兩套強制點並存；改檔前那套仍然要事先宣告路徑、仍然要補 bash regex，VD-4 全部成立 |
| L tier 的 G1／G2 未核准直接 deny | 回到 D0 的強度與它的全部繞過面 |
| 每次改檔都 `ask` | 核准前的探索與 spike 會被詢問視窗淹沒，使用者最後會習慣性按允許，詢問失去意義 |
| M／L tier 在 G1 核准前也跑 Stop acceptance | G1 前是探索期，AC 失敗是預期中的事；Stop 在 agent 停下來問問題時也會觸發，這時把它推回去修 AC 等於打斷釐清 |
| G1 核准後、驗收測試還沒寫時也跑 Stop acceptance（前一版選定） | 跟上一列同一個問題：這時 AC 必定失敗，agent 停下來問「要用 A 還是 B」會被喚醒、沒等回答就繼續做，還消耗重試次數。「oracle diff 為空」是「還沒開始寫驗收測試」的機器可判定近似值。代價是這段期間 INV 的破壞要等 agent 動到 oracle 檔才回報，fast 照常跑 |
| 讀 `last_assistant_message` 判斷 agent 是否在提問 | 要猜自然語言意圖；Cursor 的 `stop` 輸入也沒有這個欄位，兩個平台行為不一致 |

**誠實邊界（必須寫進 README）：**

- 驗收 Gate 不阻止 agent 寫出錯的程式碼，它阻止的是「錯的程式碼被宣稱完成、被歸檔、被 merge」。
- 本機的機器證據存在 `.devplan/local/`。PreToolUse 只擋得到 Edit／Write 工具，擋不到 agent 用 Bash
  寫檔，所以 agent 有能力偽造本機證據。本機 Gate 的強度是「阻止意外與順手」；
  **最終驗收以 CI 為準**（D15），CI 不讀本機證據。
- L tier 的改檔前提醒在兩個平台都只是 audit：Claude Code 用 PreToolUse 的 `additionalContext`，
  Cursor 用 `postToolUse` 的 `additional_context`（Cursor 的 `preToolUse` 不執行 `ask`）。

### D14 — Oracle 的範圍與保護

**選定。** Oracle 定義為以下六項，合起來算一個 oracle 指紋：

1. AC 本文與其驗證欄的完整字串（D20）
2. `INV-n` 本文與其驗證欄的完整字串（D20：搬進 spec）
3. Non-goals 與規格偏離登記（現行 spec 指紋已涵蓋）
4. `.devplan/config.json` 的 `verify` 區段中與 merge-base 版本不同的 key，排除 `baseRef`、`timeoutSec`、`maxAutoRetries`；
   `ci.skip` 裡屬於本 item 的條目一律納入，屬於其他 item 的一律排除
5. `verify.oracle` 命中的檔案，以及 `verify.oracleJsonKeys` 抽出、與 merge-base 版本不同的 JSON key，相對 merge-base 的正規化 diff
6. `03-verify.md` 的 manual 證據列

規則：

- **驗收測試由 agent 寫。** G1 核准的是契約：AC 與 INV 本文、驗證欄的型式（D20 的 `verifyShape`）、第 3 項。
  完整的 `cmd:` 字串、第 4–6 項到 G3 核准時才一起納入。
  `devplan approve --gate G3` 會列出第 5 項的 diff、`verify` 設定 diff，以及 G1 之後驗證欄的變動給人審。
- G3 核准之後，oracle 指紋任何變動都讓 G3 失效，CI 重算時也會失敗。
- **第 5 項只看本分支改了什麼。** `verify.oracle` 決定哪些檔案算 oracle，repo 可以改寫；
  指紋的內容則是 merge-base 與 3.3 的 `worktree` tree 之間、在這些檔案上的 diff。merge-base 取 `HEAD` 與 base ref：
  base ref 依序取 `--base`、環境變數 `DEVPLAN_BASE_REF`、`verify.baseRef`（預設 `origin/main`），
  G3 核准時把 ref 名稱（不是 sha）寫進核准記錄（D16），CI 照記錄重算（D15）。這樣處理有兩個理由：
  - 弱化手法（改 assertion、加 `.skip`、刪測試）一定出現在這份 diff 裡，人審的也正是它。
  - main 上與本項目無關的測試改動不進指紋。如果指紋涵蓋全部測試檔，別人的 PR 改到任何測試並
    merge，rebase 之後所有進行中項目的 G3 會一起失效。
- **diff 要先正規化再 hash：** 用 `-U0` 去掉上下文行，刪掉 `index <blob>..<blob>` 行與 `@@` 的行號。
  否則 main 在同一個檔案的其他位置改動，會讓 blob hash、行號與上下文行跟著變，指紋照樣失效。
- **`verify.oracle` 的每一項是 git pathspec 的 `:(glob)` 語法，不支援大括號展開。** 比對與 diff 都交給 git，
  而且都對同一份暫存 index（3.3 算 `worktree` 時建的那份）操作：
  `GIT_INDEX_FILE=<tmp> git ls-files -- ':(glob)…'` 與 `git diff -U0 <merge-base> <worktree tree> -- ':(glob)…'`。
  未追蹤的新測試檔因此同時出現在比對集合與 diff 裡。直接用 `git diff <merge-base>` 比 worktree 不行：
  它只涵蓋已追蹤的檔案，新寫、還沒 `git add` 的測試檔會被 `UNGUARDED` 判為受保護，卻不出現在 G3 人審的 diff 裡。
  devplan 也不必引入 glob 套件。
- **`devplan approve --gate G3` 要求 worktree 乾淨。** `git status --porcelain --untracked-files=all` 必須為空
  （`.devplan/local/` 已被 ignore，不影響），否則拒絕核准並列出未 commit 的檔案。這時 `worktree` tree 等於 `HEAD^{tree}`，
  本機核准時算出的 oracle 指紋與 CI 在同一個 commit 上重算的值必定一致；spec、`03-verify.md` 與 `config.json` 也已經 commit，
  CI 讀到的就是人核准時看到的那份。
- **預設範圍不只測試檔。** 改 runner、lint、型別設定與 `package.json` 的 scripts 一樣能讓驗證變寬（VD-3），
  例如 `"test": "echo ok"` 會讓 `npm test --` 前綴照樣通過 allowlist。預設涵蓋：
  - 測試檔：`.test`／`.spec` 搭配 `ts`／`tsx`／`js`／`jsx`、`__tests__/`、`e2e/`
  - `__mocks__/`：把受測對象 mock 掉也是弱化
  - `playwright`／`vitest`／`jest` 的 config、`vitest.workspace`、`eslint.config.*`、`.eslintrc*`、`tsconfig*.json`
  - `package.json` 不整份納入，否則每次升套件都讓 G3 失效；`verify.oracleJsonKeys` 指定只抽
    `scripts`、`jest`、`eslintConfig`。每個 key 的值 canonical JSON 化後與 merge-base 版本比對，只有不同的 key
    把「merge-base 值、目前值」一起納入 hash。相同的 key 不進指紋：否則 main 改了 `scripts`，rebase 後 merge-base
    版本跟著變，所有進行中項目的 G3 會一起失效，這正是第 5 項改看 diff 要避免的事。第 4 項的 `verify` 區段同樣處理
- **執行到的測試檔必須在 oracle 範圍內。** 設了 `verify.reporter` 時，devplan 讀 JUnit 裡每個 testcase 的檔案路徑，
  轉成 repo 相對路徑後對 `git ls-files` 的 oracle 集合；不在集合內的那一列記為 `UNGUARDED`，不算 PASS。
  這擋住「驗收測試寫在 oracle 範圍外的檔案」，而且不需要解析 `cmd:`。
  讀不到檔案路徑時記為 `file: unknown`、`doctor` 提示，不擋；否則沒有路徑資訊的 runner 會全部卡死。
- **S tier 沒有獨立的 G1**，merge-base 是唯一有意義的比較基準；M／L tier 也用同一個基準，不另外記「G1 當時的狀態」。
- **第 6 項的理由：** CI 無法分辨 manual 證據的真假，能做的只有確認「這份內容就是人核准時看到的那份」。
  沒有納入的話，G3 核准後 agent 仍能改 manual 證據，G3 與 CI 都不會發現。
- **L tier** 另派一個看不到實作 diff、只拿到 AC 與 INV 的 verifier 補黑箱測試。它的產出固定寫在
  `verify.blackbox.path`（預設 `e2e/blackbox/{item}/`），這個路徑必須被 `verify.oracle` 涵蓋；
  devplan 用 `verify.blackbox.cmd` 執行它，結果在證據裡記成 `BLACKBOX` 一列。G3 條件見 3.4。
- `.skip`／`.only`／`xit` 這類弱化訊號**交給 repo 自己的 lint 偵測**（例如 `eslint-plugin-jest` 的
  `no-disabled-tests`、`no-focused-tests`，或 Playwright 的 `forbidOnly`）。devplan 不重做，
  只在 `doctor` 提示有沒有開。

| 被否決的方案 | 否決理由 |
| --- | --- |
| test-first：G1 就寫好並鎖定驗收測試 | 前端測試常要等實作的 DOM 結構才寫得下去；強制 test-first 等於在 G1 預先決定實作細節，違反「Outcome 不定義 Path」 |
| 全部交給獨立 verifier agent 寫 | 每個項目都多一個 agent 回合；在小項目上正是 D17 要消除的 ceremony |
| 從 `cmd:` 字串解析出引用的測試檔當 oracle 範圍 | 又回到用 regex 猜指令意圖的老問題（09-14 P0-B.4） |
| AC／INV 表格加「驗收測試檔」欄明確列出 | 這欄由 agent 維護，漏列的檔案就不受保護；等於讓被保護的一方決定保護範圍 |
| 第 5 項 hash glob 命中的全部測試檔內容（初稿選定） | main 上任何測試改動都讓所有進行中項目的 G3 失效；S tier 也沒有「G1 之後」的基準點可以算 diff |
| 預設 oracle 只含測試檔（前一版選定） | runner、lint、tsconfig 與 `package.json` scripts 的改動不受保護，VD-3 列出的手法有一半擋不到；`npm test --` 的 allowlist 可以被改 script 繞過 |
| 內建或引入 glob 套件比對 oracle | 比對語意會跟 `git diff` 的 pathspec 不一致，出現「diff 有算到、比對沒算到」的縫 |
| 比對用 `git ls-files -co`、diff 用 `git diff <merge-base>` 比 worktree（前一版選定） | 前者含未追蹤檔、後者不含，正是上一列要避免的縫：新測試檔還沒 `git add` 時被判為受保護，卻不在 G3 diff 裡；本機指紋也會跟 CI 對不上 |
| G3 允許 worktree 不乾淨，oracle 照暫存 index 算 | 核准的是未 commit 的狀態；commit 時漏 add 一個檔案，CI 重算必定失敗，而且要等 push 後才發現。人核准前本來就要看最終內容，先 commit 沒有額外成本 |
| `package.json` 的抽取 key 與 merge-base 版本各算一份一起 hash（前一版選定） | main 改到 `scripts`，rebase 後 merge-base 那份跟著變，所有進行中項目的 G3 一起失效，跟第 5 項改看 diff 的理由矛盾 |
| 讀不到 testcase 檔案路徑時一律判 `UNGUARDED` | 各 runner 輸出路徑的方式不同，沒有路徑的 runner 會完全無法使用；改由 `doctor` 提示 |
| 黑箱 verifier 只要求留下「已執行」紀錄 | 紀錄由 agent 寫，跟 `verifier_confirmed` 是同一種洞（VD-2） |
| 黑箱 verifier 降為非 Gate 的建議 | L tier 是最需要獨立驗證的地方；產出落在固定路徑之後，「有沒有做」可以機器檢查，沒有理由放掉 |

### D15 — 驗證的執行位置：本機 `devplan verify` + CI 跑同一份設定，以 CI 為準

**選定。**

- 本機：`devplan verify` 給 hook 用，目的是 feedback loop，速度優先。
- CI：`devplan verify --ci` 在 PR 上重跑 full 驗證、重算 spec 與 oracle 指紋並比對 `approvals/`，
  作為 required status check。CI 不讀本機的 `.devplan/local/`。
- 沒有 CI 的 repo 仍然能用，但 README 要寫明此時 Gate 強度只到本機等級（D13 誠實邊界）。
- 先只出 GitHub Actions 範本；其他 CI 只要能跑 `npx sdd-dev verify --ci` 就能接。

**CI 的驗證範圍：**

- **驗哪些 item：** PR diff（merge-base 到 `HEAD`）碰到的 `.devplan/items/**` 所屬的 item。
  PR 沒有碰到任何 item 時，只跑 `verify.full` 與 regression。這表示一個 PR 走不走驗收 Gate，取決於它有沒有碰 item；
  README 的誠實邊界要寫明這一點。
- **一個 item 對應一個 PR。** item 的文件與實作在同一個 PR 裡，PR 碰到的 item 沒有有效的 G3 時 CI 失敗，
  訊息寫「`<item>` 尚未核准 G3」。需要分批給不同 reviewer 的工作要拆成多個 item（D17）。
- **oracle 指紋的 base：** 用核准記錄的 `G3.base` 重算 merge-base，不用 PR 的 base branch。
  stacked PR 的 base 不是 main 時，本機與 CI 因此算得出同一個值。`G3.base` 在 CI fetch 不到時失敗，
  訊息寫「base `<ref>` 不存在，rebase 後重新核准 G3」。父分支 merge、子分支 rebase 到 main 之後，
  oracle diff 本來就會變，G3 必須重新核准，這是正確行為。CI 範本的 checkout 要 `fetch-depth: 0`，
  另外 `git fetch origin <G3.base>`。
- **本機能跑、CI 不能跑的 `cmd:`**（要 staging DB、secret、外部服務）列在 `verify.ci.skip`，
  key 是 `<item>#<AC 或 INV id>`，value 是理由。這些項目 CI 不跑、列在 CI summary；本機 G3 仍然要求 PASS。
  `ci.skip` 屬於 `verify` 區段，本 item 的條目進 oracle 指紋（D14 第 4 項），所以 G3 核准時人會看到它。
- **歸檔後的 regression：** `devplan archive` 把該 item 的 INV `cmd:` 附加到 `.devplan/regression.json`，
  每筆記來源 `<item>#INV-n`；CI 每次都跑這份清單。AC 的 `cmd:` 歸檔即停。
  `regression.json` 刻意不放在 `config.json` 的 `verify` 區段：放在那裡的話，每次歸檔都會改到
  其他進行中項目的 oracle 指紋。移除條目會出現在 PR diff 裡，與 `approvals/**` 一起設 CODEOWNERS。

| 被否決的方案 | 否決理由 |
| --- | --- |
| devplan 只讀 CI 結果，本機不跑 | 回饋要等 push 與 CI 排隊，延遲從秒級變成分鐘級，Stop hook 的 feedback loop 等於廢掉 |
| 只在本機跑 | 本機證據 agent 寫得到，驗收 Gate 永遠停在「阻止意外」的強度 |
| 用 spec metadata 的 branch 欄比對 PR head branch 決定 item | 分支改名、一個分支做兩個 item 就對不上；diff 是 CI 本來就拿得到的事實 |
| 所有 active item 全跑 | 一個 PR 會被無關 item 的 FAIL 擋住 |
| 一個 item 分多個 PR，G3 未核准時 CI 只跑 acceptance、標示 pending 不擋 | 中間的 PR 可以在沒有人審 oracle 的情況下 merge，驗收 Gate 在分批的項目上等於不存在 |
| 一個 item 分多個 PR，每個 PR 對它涵蓋的 AC 子集各過一次 G3 | 核准記錄要從「每個 gate 一筆」變成「每個 gate 每個 AC 子集一筆」，oracle diff 也要按子集切；拆成多個 item 就能得到同樣的效果 |
| CI 跑不了的 `cmd:` 一律改成 `manual:` | 最後會累積大量 manual，等於退回自我申報 |
| AC 驗證欄加 `env: local-only` 標記 | 標記散在各 AC 裡，沒有集中一處給人審；而且它落在 spec 指紋內，CI 環境一變就要重過 G1 |
| AC 與 INV 歸檔後都繼續跑 | AC 的測試 merge 後已經在 repo 的測試套件裡，由 `verify.full` 涵蓋，重複跑只增加 CI 時間 |
| 歸檔後都不跑 | INV 的 `cmd:` 常是指定的 E2E 子集，不一定在預設測試套件裡；歸檔後就沒人跑，INV 的保護只活到歸檔那天 |
| CI 用 PR 的 base branch 算 merge-base | stacked PR 的 base 不是 main 時，本機核准的 oracle 指紋與 CI 必定不同，CI 必定失敗 |
| 核准記錄存 merge-base 的 sha | rebase 之後 sha 一定改變；要記的是「對哪條線算 diff」，也就是 ref 名稱 |

### D16 — 修訂 D10：拿掉 HMAC，改由 PR review + CI 重算指紋

**選定。**

- `devplan approve` 保留 D10 的前半：要求 TTY、要求逐字打出指紋。實作從 S3 移到 SV：
  SV 的 G3 判定與 S tier 合併核准都要讀核准記錄，排在 S3 會變成循環依賴；TTY 與逐字指紋的成本也低，
  沒有理由拆開。S3 只剩 D13 的 deny 清單、CI 範本與 CODEOWNERS 指引。
- `approvals/<item>.json` 依 D12 進版控，以 gate 為 key（L tier 一個 item 有三個 gate），
  不再有 `nonce`／`mac`。`~/.devplan/approval.key` 不再生成（09-15 S2 的這一步刪除）：

  ```json
  {
    "tier": "M",
    "gates": {
      "G1": { "spec": "spec:ab02eb8e", "approvedAt": "…", "approvedBy": "…" },
      "G3": { "spec": "spec:ab02eb8e", "oracle": "oracle:91c0d2e4", "base": "origin/main", "approvedAt": "…", "approvedBy": "…" }
    }
  }
  ```

  S tier 只寫 `G3`；判定 G1 時讀 `G3.spec`。`G2` 只記 `plan` 指紋。
- **核准記錄存完整的 sha256，人只打前 8 碼。** 上面範例為了閱讀只寫 8 碼。現行 `digest()` 截成 8 個 hex（32 bits）；
  拿掉 HMAC 之後，核准的效力只靠指紋相等，32 bits 可以被暴力碰撞：agent 改完 oracle 後在測試檔加註解湊出同一個指紋
  （推測：Node 在一般筆電上約數十分鐘）。`approve` 的顯示與逐字輸入維持 8 碼，寫入、比對與 CI 重算一律用完整值。
  `lib/hook.js` 的 `gateStatus()` 在 SV 就改讀這份檔案，`notes.md` 的「Gate 狀態」「核准指紋」兩欄同時移除。
- CI 重算指紋並與 `approvals/` 比對（D15）。
- 團隊使用：`.devplan/approvals/**` 設 CODEOWNERS + branch protection，核准記錄的變更必須經過人 review。
- 個人使用、沒有 branch protection：agent 偽造的核准記錄只能在 diff 裡被看見，不能被阻止。README 照實寫。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 維持 D10 的 HMAC | key 放在 `~/.devplan/`，agent 讀得到，本來就只是篡改偵測；而且 CI 沒有 key 就驗不了 MAC，直接跟 D15「以 CI 為準」衝突 |
| 本機 HMAC + CI 再驗一次 | 要把 key 放進 CI secret，等於多管一個 secret，去換一個已經被 CI 取代的保護 |
| `approve` 留在 S3，SV 先讀暫時格式 | 暫時格式要多寫一次遷移；SV 的驗收條件 10、17 在 S3 之前都無法驗證 |
| 核准記錄沿用單一 `{ gate, … }` 物件 | L tier 同一個 item 有 G1、G2、G3，單一物件要嘛互相覆蓋，要嘛拆成多個檔 |

### D17 — Tier 拆成 risk 與 horizon 兩軸

**選定。** 現在一個 Tier 混了兩件事：要不要獨立驗證與審查（risk），以及要不要拆 task、記 wip（horizon）。

- **Tier（S／M／L）只代表 risk。** 沿用 `docs/numbering-and-tiers.md` 現有的封閉觸發清單，
  以及「禁止用工作量判斷 Tier」。
- **新增 metadata 欄位 `Horizon`（`short`／`long`）。** 封閉觸發清單：預期跨 session；
  跨子系統的改動需要依序落地。命中任一條即 `long`。Horizon 可以看工作量，Tier 不行。
- **一個 item 對應一個 PR（D15）。** 需要分批給不同 reviewer 的工作拆成多個 item，各自有 AC 與 G3；
  它不是 Horizon 的觸發條件。

| | 產出 | 核准 | 驗證 |
| --- | --- | --- | --- |
| **S** | `00-spec.md`（目標 + AC + 驗證欄；有 INV 才寫） | G1 與 G3 合併成一次核准，在驗收時進行 | 機器驗證；有 manual AC 才需要 `03-verify.md` |
| **M** | + 選用的 `01-plan.md`（必填只有設計決策表與「被否決的更小方案」；§5 檔案變更選填） | G1 獨立核准；G3 | 同上 |
| **L** | + `01-plan.md` 必要 | G1、G2、G3；G1／G2 未核准時改檔會收到提醒（D13） | + D14 的黑箱 verifier；獨立審查紀錄 |
| `Horizon: long`（任何 Tier） | + `02-tasks.md`、`wip` 記帳、`SessionStart` 注入 snapshot | 不影響核准 | 不影響驗證 |

**S tier 合併核准的理由：** S tier 的定義是風險觸發清單命中 0 條，也就是 AC 沒有 `[C]`、
沒有 open 問題、沒有未拍板的決策。契約在動手前就已經確定，另外過一次 G1 的資訊量很低。
驗收時的那一次核准同時涵蓋契約與 oracle。

附帶解掉 09-14 P5 的 item 身分問題：每個 Tier 都有 `00-spec.md`，resolver 與 `listActiveProjects`
「用 `00-spec.md` 辨識 item」的邏輯可以不動。

不再讀「檔案」欄之後，三個檢查要改資料來源：

- Tier 反推（`coverage-lint.js:146-196`）改成驗證時看實際 diff（`git diff --name-only <base>...`）
  對 `codebase-profile.json`。
- Gotcha 比對（`coverage-lint.js:205-215`）同樣改看實際 diff；命中時在驗證輸出與 Stop feedback 提示
  「你動到 G4 的位置，確認對應的 INV」。
- hook 選 item 不再用 path：完整 branch equality 優先、唯一 item 次之，否則依 09-14 P2 輸出
  ambiguous diagnostic。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 維持單一 Tier，tasks 綁在 L | 跨多個 session 的 M 項目沒有 task 可以拆；一個 session 做得完的 L 項目反而被迫拆 |
| 不分級，由 agent 自己決定產哪些檔 | 「每個項目開頭都重新辯論 Tier」是已經發生過的 failure（`docs/numbering-and-tiers.md`）；獨立審查也失去觸發條件 |
| S tier 的 G1 也獨立核准 | 見上面「S tier 合併核准的理由」 |
| S tier 不需要人核准，機器驗證通過即可歸檔 | 驗收測試由 agent 寫（D14），沒有任何人看過 oracle，VD-3 在 S tier 完全不設防 |
| 「需要分批 commit 給不同 reviewer」列為 Horizon 觸發條件（前一版選定） | 分批就是同一個 item 有多個 PR，跟 D15「PR 碰到的 item 必須有有效 G3」衝突，中間的 PR 全部被 CI 擋下 |

### D18 — 規則要有 failure 才存在：rules registry 與生命週期

**選定。** 取代 09-14 D3 與 09-15 S6 的「搬家式瘦身」。

**Registry（`docs/rules-registry.md`）每條規則一列：**

| 欄位 | 內容 |
| --- | --- |
| id | `RULE-n` |
| 規則 | 一句話 |
| 解的 failure | 觀察到、可重現的失敗；推論出來的要標「推論」 |
| 類別 | `quality`／`safety` |
| 落點 | 模板、skill、hook 訊息、checker |
| 最後驗證 | 日期 + 模型 |
| 狀態 | `active`／`review`／`retired` |

`safety` 類（不可逆操作與權限：不自動 commit、不 push／merge／開 PR、不自行核准）豁免 failure 要求，
可以先防。其他一律 failure-driven。

**盤點結果（2026-09-25 拍板）：**

`review` 的意思是先保留，S6 結束前要補上「解的 failure」；補不出來再議，不自動刪除。

| 規則 | 文件裡寫出的 failure | 處理 |
| --- | --- | --- |
| AC 來源標記與 `[U:Qn]` 回指 | 下個 session 分不出哪條 AC 可以動 | 保留 |
| 問答紀錄不刪除 | 需求來源救不回 | 保留 |
| `wip` 與「進行中」一行 | 中斷後進度沒有落點 | 保留，但只在 `Horizon: long` |
| `NOT-PROVEN` | 證據不足被硬塞成 PASS | 保留，範圍縮到 manual AC |
| 「被否決的更小方案」必填 | 多做的抽象能合法通過覆蓋率對帳 | 保留 |
| 同一決策修第二次就重開 | 在錯的切法上打補丁 | 保留 |
| Tier 用封閉清單 | 每個項目重新辯論 Tier | 保留 |
| 偏離必須回寫 spec | spec 開始騙人 | 保留 |
| Gotcha 歸檔前搬進 `refs/` | repo 知識跟著項目被埋掉 | 保留 |
| 獨立審查三軸 O／M／C 與 subagent 範圍紀律 | 推論（只看 Outcome 會漏掉多做與違反慣例） | `review`：只在 L tier，實測後決定 |
| spec §8「偏好（非需求）」 | 無 | 刪除；真正的限制移到 §3 約束 |
| notes「讀過的檔案（含關鍵行號）」表 | 文件未寫出 | 保留，`review` |
| `01-plan.md` §5 逐檔變更清單 | 文件未寫出；原本兼作 hook 的路徑判定來源 | 保留，`review`。D13 之後不再餵 hook，只給人讀；M tier 選填（D17） |
| 任務的「Done 條件」欄 | 文件未寫出 | 保留，`review`。只在 `Horizon: long` 有 `02-tasks.md` 時存在；它是任務層級，與 AC 層級的驗證欄並存 |
| 「建議 Commit 規劃」與預寫 commit message | 無 | 移進 D19 的選用模式 |
| 每份模板重複貼 `devplan check` 用法 | 無；hook 會自動跑 | 刪除；CLI 用法只留在 skill 一處 |

**生命週期：** 出現可重現的 failure → 加規則並登記 → 換模型時重新評估 → 無法證明仍有必要就 `retire`。

**Harness eval（補 09-14 P7，排在最後）：** 用 2–3 個 fixture item 在一個小型範例 repo 上，
比較「有／沒有某組規則」時 agent 的驗證通過率與多做程度。成本高，先不進 CI，換模型時手動跑一次
（推測：投入產出比要實測後才知道）。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 只記 failure 欄，不記最後驗證模型與生命週期 | 換模型時沒有依據判斷哪些規則該重新評估，規則只會增加不會減少 |
| 不建 registry，照盤點表一次刪完 | 一次性清理之後沒有機制擋規則重新累積，VD-6 會原樣回來 |

### D19 — `strict-commit-pipeline` 降為 L tier 選用

**選定。**

- 刪除 `verifier_confirmed` 這個由主 session 自己寫入的放行條件。選用嚴格模式時，commit 放行條件改成：
  staged 內容上的 `verify.fast` 通過，外加這個 commit 涵蓋的 AC 的 `cmd:` 通過。由 hook 自己跑，
  不讀 agent 寫的狀態。
- `notes.md`「Commit Pipeline 狀態」的七個狀態值刪除。中斷復原靠 `git log` 與證據檔。
- per-commit 派 executor／verifier 改為選用；預設 L tier 只在 G3 前派一次 D14 的黑箱 verifier。
- 「待人工確認清單」保留概念，改成由 AC 驗證欄的 `manual:` 自動產生，不再靠主 session 累積。
- 瀏覽器驗證：repo 有 Playwright／Cypress 時寫成 `cmd:`；只能靠 agent 的瀏覽器工具操作、
  沒留下可重跑腳本的，一律算 `manual`。
- 權限邊界（push／merge／開 PR 一律硬擋）不變，登記為 D18 的 `safety` 規則。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 整份刪除，連同 `pipeline-guard` 與狀態表 | 程式碼最少，但長時程的 L 項目失去逐 commit 驗證；Stop hook 只在 agent 停下時才跑，中間的 commit 沒有被驗過 |
| 保留現行流程，只修 `verifier_confirmed` 自我申報 | 修掉自我申報之後，放行條件本來就只能改成機器驗證；剩下的七個狀態值與固定的 executor／verifier 派工是 VD-5 的 ceremony |

### D20 — 契約格式：AC 帶驗證欄、INV 搬進 spec

**選定。** **AC 從條列改成表格**，配合 D11 的 anchor 在 S1 一次改完（不要先把舊條列格式 anchor 化再改表格）：

```markdown
<!-- devplan:table id="spec.ac" cols="id,condition,source,verify" -->
| AC | 可觀察條件 | 來源 | 驗證 |
| --- | --- | --- | --- |
| R1.1 | loading 中再按 Submit 不會送出第二個 request | U:Q2 | `cmd: npx playwright test e2e/checkout.spec.ts -g "double submit"` |
| R1.2 | 欄位錯誤訊息顯示在對應欄位下方 | S | `manual: 視覺位置，需截圖` |
```

- 驗證欄只有兩種：`cmd:` 與 `manual:`（必須附理由）。不另外發明 `test:`／`e2e:`
  語法，指令本身就是 repo 既有的 runner。
- 需求 R 的標題與 Why 保留在表格上方，表格只放 AC。

**G1 只鎖驗證欄的型式。** 驗收測試在 G1 之後才寫（D14），如果完整的 `cmd:` 字串進 spec 指紋，
agent 必須在 G1 就猜好測試檔名與 `-g` 的測試名，之後改名就讓 G1 失效；這正是 D14 否決 test-first 的理由。
因此 spec 指紋只收驗證欄正規化後的型式，完整字串進 oracle（D14 第 1、2 項），到 G3 才鎖：

```js
const SHELL_META = /[;&|<>`$()\n]/;

function verifyShape(cell, runners) {
  const m = /^\s*(cmd|manual):\s*(.*)$/.exec(stripBackticks(cell));
  if (!m) return 'invalid';
  if (m[1] === 'manual') return `manual:${normalize(m[2])}`;
  if (SHELL_META.test(m[2])) return 'invalid';
  const runner = runners.find((r) => m[2].startsWith(r));
  return runner ? `cmd:${runner}` : 'invalid';
}
```

G1 時人審的是「這條 AC 用 Playwright E2E 證明」或「這條只能人工驗，理由是…」，這是契約層級的決定。
G1 之後 agent 可以自由改檔名、改 filter；改成空驗證的風險由 G3 的 oracle diff、`UNGUARDED` 與 `NO-REPORT` 擋。

**`cmd:` 的最低要求。** 光看 exit 0 擋不住兩種空驗證：`cmd: true`、`cmd: echo ok` 這種不測任何東西的指令；
以及 filter 什麼都沒匹配到、runner 卻回 exit 0 的情況（據稱 Jest 的 `-t` 如此，Vitest 待確認，
Playwright 的 `-g` 沒匹配會回非 0）。S tier 的人要到 G3 才第一次看到驗證欄，後者人眼也看不出來。

- **Runner allowlist：** `cmd:` 必須以 `verify.runners` 其中一個前綴開頭。這是純字串前綴比對，不解析指令意圖；
  不符合時 `coverage-lint` 擋。
- **不經過 shell 執行。** 前綴比對擋不住串接：`npx playwright test e2e/x.spec.ts || true` 符合前綴，測試真的跑、
  真的失敗，exit 卻是 0。所以 `cmd:` 含 `SHELL_META`（`;`、`&`、`|`、`<`、`>`、反引號、`$`、括號、換行）時
  `verifyShape` 判為 `invalid`，由 `coverage-lint` 擋；執行時依引號拆成參數陣列，`spawn(argv[0], argv.slice(1), { shell: false })`。
  需要環境變數或管線的驗證，寫成 repo 的 npm script（`package.json` 的 `scripts` 在預設 oracle 內），
  再把呼叫它的前綴加進 `verify.runners`。
- **執行數檢查（選用）：** 設了 `verify.reporter` 時，devplan 每跑一條 `cmd:` 前清掉 reporter 檔、跑完讀回來，
  算出實際執行（排除 skipped）的 test case 數。數量為 0 記為 `EMPTY`，不算 PASS。
  格式只支援 JUnit XML，Jest、Vitest、Playwright 都能輸出；devplan 用環境變數 `DEVPLAN_JUNIT` 告訴 runner
  寫到哪裡（每次執行一個新路徑，`.devplan/local/run/<runId>/<resultId>.xml`，不會讀到上一次的殘檔），
  repo 的 runner 設定負責讀它。沒設 reporter 時 `doctor` 提示。
- **設了 reporter 卻沒有產出：** 檔案不存在或解析失敗時記為 `NO-REPORT`，不算 PASS，也不退回只看 exit code；
  否則 repo 設定沒讀 `DEVPLAN_JUNIT` 時，執行數檢查會無聲失效。訊息與 `doctor` 都附 runner 設定片段
  （細節以 SV-spike 實測為準）：

  ```ts
  // vitest.config.ts
  test: {
    reporters: process.env.DEVPLAN_JUNIT ? ['default', 'junit'] : ['default'],
    outputFile: { junit: process.env.DEVPLAN_JUNIT },
  },

  // playwright.config.ts
  reporter: process.env.DEVPLAN_JUNIT
    ? [['list'], ['junit', { outputFile: process.env.DEVPLAN_JUNIT }]]
    : 'list',
  ```

  Jest 用 `jest-junit`，devplan 另外設 `JEST_JUNIT_OUTPUT_FILE=$DEVPLAN_JUNIT`。這些 runner 設定檔都在
  預設 oracle 內（D14），agent 拿掉 reporter 會出現在 G3 的 diff 裡。
- 每一列的判定依序是：前綴不在 allowlist 內或含 shell 語法，由 `coverage-lint` 事先擋；有設 reporter 時，沒有產出記 `NO-REPORT`、
  實際執行數為 0（全部 skipped 也算）記 `EMPTY`、有 testcase 不在 oracle 集合內記 `UNGUARDED`（D14）、
  JUnit 的 `failures` 或 `errors` 不為 0 記 `FAIL`（不管 exit code）；以上都沒有且 exit 0 才是 `PASS`。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 不限制 `cmd:`，靠 G1／G3 的人審看出空驗證 | S tier 人到 G3 才第一次看到；filter 沒匹配這種情況人眼看不出來 |
| 每種 runner 寫 adapter 解析測試數 | 又回到替每種工具寫解析器；三大 runner 都能輸出 JUnit XML，一種格式就夠 |
| spec 指紋納入完整的 `cmd:` 字串（前一版選定） | 逼 agent 在 G1 預先決定測試檔名與測試名，改名就要重過 G1；與 D14 否決 test-first 的理由矛盾 |
| G1 允許 `cmd: TBD`，只在 G3 擋 | G1 的契約可能大半是空的，人審不到「這條 AC 用什麼方式證明」；G1 核准後 Stop 也沒有東西可跑 |
| 沒有 JUnit 產出時退回只看 exit code | repo 沒接好 `DEVPLAN_JUNIT` 時，`EMPTY` 檢查無聲失效，filter 沒匹配的空驗證又能通過 |
| `cmd:` 交給 shell 執行（前一版未定義） | `\|\| true`、`; exit 0` 讓失敗的測試回 exit 0；G1 只鎖 `verifyShape`，這種改動連 G1 都不會失效，只剩 G3 人眼 |
| 只靠 JUnit 的 `failures` 擋 `\|\| true`，仍然用 shell 執行 | 沒設 reporter 的 repo 完全不設防；shell 語法還能做 `cd` 到別處、改 `DEVPLAN_JUNIT` 指向假檔 |

**INV 從 `01-plan.md` §6 搬進 `00-spec.md`**，因為「不能破壞的既有行為」是契約，不是 How：

```markdown
<!-- devplan:table id="spec.inv" cols="id,trigger,observable,verify" -->
| INV | 起始條件 | 可觀察結果 | 驗證 |
| --- | --- | --- | --- |
| INV-1 | 本次動到共用的 `CartSummary` | `/cart` 既有流程不變 | `cmd: npx playwright test e2e/cart.spec.ts` |
```

連帶修改：

- `specFingerprint` 納入 AC 表與 INV 表（驗證欄只取 `verifyShape`）、Non-goals、偏離登記；
  `planFingerprint` 拿掉 INV，只剩設計決策。
- `03-verify.md` 回歸風險表的「驗證時 plan 指紋」改為 spec 指紋；`03-verify.md` 整份只留給 `manual:`
  的 AC 與 INV，其餘由機器證據取代。
- `coverage-lint`：「每條 AC 至少一個 T」改成「每條 AC 與 INV 都有驗證欄」；T 的檢查只在
  `02-tasks.md` 存在時跑，且只剩「每個 T 回指至少一條 AC」。
- spec §3「外部既定約束」擴充為「約束」：產品、架構、相容性、權限。技術名詞只有在真的是約束時才能出現在 spec。
- spec §8「偏好（非需求）」刪除（D18）；其中真的是限制的項目移進 §3。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 維持條列，每條 AC 下一行加 `verify:` | 人讀起來比較順，但 D11 的 anchor 對條列的解析比表格脆弱；`coverage-lint` 現有的 AC 行 regex 本來就是 09-14 P7 點名的高耦合點 |
| 表格 + 驗證欄，但 INV 留在 plan | S tier 沒有 plan（D17），就沒有地方寫「不能弄壞什麼」；INV 也會落在 G1 契約指紋之外 |

## 3. SV — 驗證層規格

### 3.1 設定

```json
{
  "verify": {
    "baseRef": "origin/main",
    "runners": ["npx playwright test", "npx vitest run", "npm test --"],
    "fast": ["npx eslint --quiet {files:ts,tsx,js,jsx}", "npx tsc --noEmit --incremental --tsBuildInfoFile .devplan/local/tsbuildinfo"],
    "full": ["npm test", "npm run build"],
    "oracle": [
      "**/*.test.ts", "**/*.test.tsx", "**/*.test.js", "**/*.test.jsx",
      "**/*.spec.ts", "**/*.spec.tsx", "**/*.spec.js", "**/*.spec.jsx",
      "**/__tests__/**", "**/__mocks__/**", "e2e/**",
      "**/playwright.config.*", "**/vitest.config.*", "**/vitest.workspace.*", "**/jest.config.*",
      "**/eslint.config.*", "**/.eslintrc*", "**/tsconfig*.json"
    ],
    "oracleJsonKeys": { "package.json": ["scripts", "jest", "eslintConfig"] },
    "reporter": { "format": "junit" },
    "blackbox": { "path": "e2e/blackbox/{item}/", "cmd": "npx playwright test {path}" },
    "ci": { "skip": { "2026-10/checkout-double-submit#R1.2": "需要 staging DB，CI 沒有" } },
    "timeoutSec": { "fast": 30, "acceptance": 300, "acceptanceSync": 120 },
    "maxAutoRetries": 3
  }
}
```

指令一律指向 repo 既有的 script。devplan 不內建任何 lint、test 或 formatter。

- `{files}` 代入本批改動、仍然存在、且不在 `.devplan/` 下的檔案；`{files:<ext,…>}` 再只留指定副檔名。
  刪除的檔案不代入：傳給 eslint 會直接報錯，`fast` 會一直是紅的。過濾後清單為空時略過這條指令；
  沒有 placeholder 的指令照原樣跑。
- `runners`（D20）、`reporter`（D20）、`oracle`／`oracleJsonKeys`（D14）、`blackbox`（D14）、`ci.skip`（D15）的語意見各決策。
- `baseRef` 是預設值；`--base` 與 `DEVPLAN_BASE_REF` 優先，G3 核准時實際用到的 ref 寫進核准記錄（D14、D16）。
- `fast` 範例把 `tsbuildinfo` 導到 `.devplan/local/`：驗證產生的檔案如果落在 worktree 裡又沒被 ignore，
  證據會被判為無效（3.3）。
- `timeoutSec.acceptanceSync` 是 hook 無法背景執行時（Cursor `stop`）的預算，見 3.5。

`timeoutSec.acceptance` 是整批 acceptance 的總預算，不是單一指令的上限。
`devplan install` 產生 Stop hook 設定時，hook 本身的 `timeout` 要設得比這個預算大；
否則 hook 先被平台取消、輸出被丟棄，agent 連「哪些沒跑到」都收不到。

### 3.2 `devplan verify`

| 層級 | 跑什麼 | 誰呼叫 |
| --- | --- | --- |
| `--fast` | `verify.fast`，`{files}` 代入本批改動檔 | `PostToolBatch`／`postToolUse` |
| 預設（acceptance） | item 內所有 AC 與 INV 的 `cmd:`，L tier 再加 `verify.blackbox.cmd`；依序執行，超過預算就中止，剩下的記為 skipped | `Stop`／`stop` |
| `--full` | acceptance + `verify.full` | G3、`archive` |
| `--ci` | 依 D15 選出 item，跑它們的 `--full`（跳過本 item 在 `verify.ci.skip` 的條目），加跑 `.devplan/regression.json`；重算 spec／oracle 指紋並比對 `approvals/`，不讀本機證據 | CI |

### 3.3 證據

每次執行寫一份到 `.devplan/local/evidence/<item>/`，並更新 `latest.json`：

```json
{
  "item": "2026-10/checkout-double-submit",
  "level": "acceptance",
  "at": "2026-09-25T02:10:00+08:00",
  "code": { "head": "3f2a9c1", "worktree": "tree:8d1e0a7f" },
  "contract": { "spec": "spec:ab02eb8e", "oracle": "oracle:91c0d2e4" },
  "results": [
    { "id": "R1.1", "cmd": "npx playwright test e2e/checkout.spec.ts -g \"double submit\"", "exitCode": 0, "executed": 1, "durationMs": 8120, "output": "…" },
    { "id": "INV-1", "cmd": "npx playwright test e2e/cart.spec.ts", "exitCode": 1, "executed": 6, "durationMs": 6400, "output": "…" },
    { "id": "R2.1", "cmd": "npx playwright test e2e/refund.spec.ts", "exitCode": null, "skipped": true }
  ]
}
```

- `worktree` 用暫存 index 計算：`GIT_INDEX_FILE=<tmp> git read-tree HEAD`，再 `git add -A -- . ':!.devplan'`，
  最後 `git write-tree`。先 `read-tree` 讓 git 只需重新 hash 有變動的檔案。涵蓋未 commit 與未追蹤
  （未 ignore）的檔案，排除 `.devplan/`，不動使用者的 index。未 ignore 的大型未追蹤檔會拖慢計算，`doctor` 提示。
  D14 第 5 項的 oracle 比對與 diff 用的也是這份暫存 index 與它寫出的 tree。
- **`worktree` 在開跑前與跑完後各算一次。** 兩者相同才寫進證據。不同時先比對前後的
  `git status --porcelain --untracked-files=all`：
  - 多出來的全是這次驗證新產生的未追蹤檔（例如 `tsconfig.tsbuildinfo`、`test-results/`、`playwright-report/`）：
    整批判為 FAIL，訊息列出這些檔案並要求加進 `.gitignore`。不能默默丟棄，否則證據永遠不會 PASS，agent 也不知道原因。
  - 其他情況表示驗證期間有人改了檔（`asyncRewake` 在背景跑時，使用者可能已經送出新訊息）：結果標為 `discarded`，
    不更新 `latest.json`，下次觸發再跑。
  - `doctor` 檢查 `test-results/`、`playwright-report/`、`coverage/`、`*.tsbuildinfo` 是否被 ignore。
- 證據有效條件：`worktree`、`spec`、`oracle` 三者都等於當下的值。任何一個不同就是 `STALE`。
- `executed` 只在設了 `verify.reporter` 時出現；各列的 `NO-REPORT`、`EMPTY`、`UNGUARDED`、`FAIL`、`PASS` 判定見 D20
  （有 reporter 時，JUnit 記到失敗就是 `FAIL`，不看 exit code）。
- `skipped`、`NO-REPORT`、`EMPTY`、`UNGUARDED` 都不算 PASS。Stop feedback 會列出哪些沒跑到或沒通過；
  G3 只看 `--full`，而 `--full` 不受 acceptance 預算限制。
- `output` 取頭尾各一段，不是只取尾巴：runner 輸出的尾巴通常是摘要，真正的失敗細節在中段。
  有 reporter 時改放失敗 case 的名稱與訊息。餵回模型時受 `additionalContext` 的 10,000 字元上限限制。
- `verify-evidence-lint` 的 `EVIDENCE_PATTERNS`／`VAGUE_PATTERNS` 只剩 manual AC 用得到。

### 3.4 G3 有效條件（tier-aware）

1. G1 已核准且 spec 指紋一致（S tier：與 G3 同一次核准）。
2. `--full` 的最新證據在目前 `worktree` 上全部 PASS（`skipped`、`NO-REPORT`、`EMPTY`、`UNGUARDED` 都不算）。
3. 每條 `manual:` AC 在 `03-verify.md` 有人工證據，且狀態不是 `NOT-PROVEN`。
4. G3 核准記錄的 oracle 指紋等於用記錄裡的 `base` 重算的當下值（含 D14 第 6 項的 manual 證據列）。
5. L tier：獨立審查紀錄存在；`verify.blackbox.path` 下至少有一個測試檔且被 `verify.oracle` 涵蓋；
   `--full` 證據裡的 `BLACKBOX` 一列 PASS。

`devplan archive` 等於「G3 有效」。沒有 `01-plan.md`、`02-tasks.md` 時，對應的檢查視為不適用，而不是失敗。

### 3.5 Hooks

所有 hook 共用中性結果（即 09-15 S5 的 `{ verdict, userMessage, agentMessage }`，提前到 SV 實作），
再由各 adapter 序列化。

**Claude Code：**

| 事件 | 做什麼 | 輸出 |
| --- | --- | --- |
| `PostToolBatch`（`async: true`） | 批次內有改到 `.devplan/` 以外的檔案時跑 `--fast`；已有一次在跑就略過 | 失敗時回 `hookSpecificOutput.additionalContext`（截斷輸出），下一個 turn 送達。不回 `decision: block`，它會中斷 agentic loop |
| `Stop`（`asyncRewake: true`） | S tier，或 M／L tier 的 G1 已核准；本 item 的 oracle diff 非空（D13）；自上次驗證後 `worktree` 有變；`background_tasks` 非空時略過 | 全部 PASS 時 exit 0、不輸出；有任何非 PASS 的列（FAIL、skipped、`NO-REPORT`、`EMPTY`、`UNGUARDED`）時 exit 2，stderr 放摘要，喚醒 agent；結果為 `discarded` 時 exit 0、不喚醒 |
| `SessionStart` | 注入最小 snapshot：目標、AC 與 INV 的最新狀態（PASS、FAIL、`NO-REPORT`、`EMPTY`、`UNGUARDED`、PENDING）、最近一次失敗摘要、open 問題、自動重試是否已達上限 | `additionalContext` |
| `PreToolUse` | D13 的 deny 清單；L tier 的 G1／G2 未核准時 `allow` + 提醒 | `permissionDecision` + `additionalContext` |

**為什麼用背景執行：**

- `fast` 裡的 typecheck 在中型 repo 要 10 秒以上，同步跑會讓每個改檔的 batch 都卡住；
  重構做到一半時型別本來就是紅的，結果晚一個 turn 送達反而比較不會逼 agent 去修半成品。
- Stop 的 acceptance 最長要跑到 `timeoutSec.acceptance`，同步跑等於每次停下來都把使用者卡住幾分鐘。
  `asyncRewake` 在背景跑，exit 2 才喚醒 Claude，session idle 時也會叫醒。
- async hook 不會去重，每次觸發都是一個新 process。devplan 用 `.devplan/local/fast.lock`、
  `.devplan/local/acceptance.lock` 自己擋重複執行。lock 內容記 pid 與開始時間；pid 已不存在，或開始時間超過
  對應的 `timeoutSec` 加上寬限，就視為殘留、直接接手。`asyncRewake` 超時時 process 會被砍掉，
  不處理殘留的話 acceptance 從此不再執行，而且不會有任何訊息。

**重試上限：** devplan 在 `.devplan/local/` 自己記連續失敗次數。計數在兩種情況歸零：驗證全部 PASS，
以及使用者送出新訊息（Claude Code 的 `UserPromptSubmit`）。沒有後者的話，達到上限一次之後，
使用者介入修正也不會再有自動重試。`asyncRewake` 的喚醒是否受
`stop_hook_active` 與 Claude Code「連續 8 次」上限約束，官方文件沒有寫（推測不受），所以這個計數是主要的迴圈保護。
達到 `verify.maxAutoRetries` 時仍然 exit 2，但 stderr 改成「自動重試已達上限，停止修正，向使用者回報以下未通過的 AC」。
async hook 的 `systemMessage` 不會顯示給使用者，只能靠 agent 轉述；下次 `SessionStart` 也會帶出。

Claude Code 對 `asyncRewake` hook 仍然套用 `timeout`（純 `async` 不套用）。超時時輸出會被丟棄，等於這一輪沒有 feedback。
Stop feedback 不是安全 Gate，這個 fail-open 可以接受；安全性由 G3 與 CI 負責。

**Cursor：**

| 事件 | 做什麼 | 輸出 |
| --- | --- | --- |
| `postToolUse`（matcher `Write`） | 跑 `--fast`。Cursor 沒有 batch 事件，每次寫檔都會觸發，要 debounce（距上次執行太近、或已有一次在跑就略過）。L tier 的 G1／G2 未核准時，同一個 hook 附上提醒 | `additional_context` |
| `stop` | `status === "completed"`，且是 S tier 或 M／L tier 的 G1 已核准、本 item 的 oracle diff 非空時跑 acceptance；預算用 `timeoutSec.acceptanceSync` | 失敗時回 `followup_message`；hook 設定的 `loop_limit` 設成 `verify.maxAutoRetries` |
| `preToolUse`／`beforeShellExecution` | D13 的 deny 清單，`failClosed: true` | `permission: "deny"` + `agent_message`，exit 0 |
Cursor 的 `stop` 沒有背景執行，跑 acceptance 期間 UI 會卡住，所以預算比 Claude Code 小；
超過的 AC 記為 skipped，G3 仍然用不受預算限制的 `--full`。

Cursor 的 `stop` 沒有 block 語意，`followup_message` 會以「使用者的下一則訊息」送出。
訊息開頭要標明這是 devplan 自動送出的驗證結果，避免模型把它當成使用者的新需求。
`afterFileEdit` 沒有輸出欄位，只適合跑 formatter，不用它做 feedback。

## 4. 修訂後的執行順序

| 階段 | 內容 | 相對 09-15 的變化 |
| --- | --- | --- |
| **SV-spike** | 驗證 feedback loop 的核心假設 | **新增，排最前**，分兩段，程式碼預期丟棄。**spike-a**（不開 agent session，用 fixture 驗確定性事實）：三大 runner 讀 `DEVPLAN_JUNIT` 的設定、filter 沒匹配時的 exit code、testcase 檔案路徑的屬性，以及附錄 A 標為推測的平台行為。**spike-b**（agent session）：在現有 layout 上，`devplan verify` 暫用 4.1 的語法讀 AC 的 `cmd:`、Claude Code 的 Stop（`asyncRewake`）與 `PostToolBatch`（`async`）、Cursor 的 `stop`、D20 的 runner allowlist、shell 語法拒絕與 JUnit 判定；在 4.1 指定的 repo 上跑，依 4.1 記錄與判定。`integrations/claude-code/settings.js` 的 `removeOurs` 目前只清 `PreToolUse`，spike 加的 `Stop`／`PostToolBatch` 要一起清 |
| S0 | CI + contract tests | 補 VD-2 的 bypass fixture：任意 hex 當證據會通過；`verifier_confirmed` 由 agent 寫入即可放行 commit。即將刪除的判定（`EVIDENCE_PATTERNS` 的非 manual 用途、`verifier_confirmed`）只留 bypass fixture，不寫細部 contract test |
| S1 | Schema anchors | 與 D20 的 AC／INV 表格改版合併 |
| S2 | Layout 遷移 | 拿掉 `~/.devplan/approval.key` 的生成（D16），其餘不變 |
| **SV** | 驗證層 | **新增**：3.1–3.5 全部，含 D14 的 merge-base oracle、預設範圍、`UNGUARDED` 與黑箱路徑、D15 的 CI 範圍與 `regression.json`、D20 的 `verifyShape` 與 `cmd:` 最低要求；`devplan approve` 與 `approvals/<item>.json`（從 S3 移入，D16）；中性結果契約從 S5 提前；09-14 P1 在這裡解掉。依 SV-spike 的結果先修訂本文再動工 |
| S3 | 契約與 oracle 保護 | 縮小：`approve` 已在 SV 完成；只剩 D13 的 deny 清單、CI 範本（`fetch-depth: 0`、fetch `G3.base`）與 CODEOWNERS 指引（`approvals/**`、`regression.json`） |
| S4 | fail-closed | 縮小：刪除 G2 改檔前擋與 `WRITE_PATTERNS` 強制路徑；fail-closed 改套在 G3、`archive`、CI；P0-B.3／.5／.6／.7／.8；D19 |
| S5 | Cursor adapter | 加 `stop` + `followup_message`、`postToolUse` debounce |
| S6 | 英文化 + 模板瘦身 | 改成依 D18 的 registry 刪規則，再依 D17 產 tier-aware 模板 |
| S7 | Packaging 與 OSS 門面 | README 定位改成第 0 節的定義與 D13 的誠實邊界 |

SV-spike 排在最前面：整個方向押在「Stop feedback 會收斂、agent 不會去弱化驗證」這個假設上（第 6 節未解項目 1），
要在投入 S1、S2 的重構之前先驗。結果負面時，回頭修 D13–D20，而不是照原規格做完 SV。
SV 排在 S3 前面：S3 要保護什麼，取決於 SV 對 oracle 範圍的定義；SV 自己的 G3 判定要讀核准記錄，所以 `approve` 跟著移進 SV（D16）。
SV 排在 S2 後面：證據住在 `.devplan/local/`，要先有新的 layout。

### 4.1 SV-spike 判定

門檻在跑之前寫死，不在跑完之後決定怎麼解讀。以下判定只適用 spike-b；spike-a 是事實確認，結果直接回寫 D20 與附錄 A。

**開跑前寫死：**

| 項目 | 內容 |
| --- | --- |
| 目標 repo | 待填。至少要有 Vitest／Jest 其中一種與 Playwright E2E |
| 模型與平台版本 | 待填。門檻只對這個組合有效，換模型就重跑 |
| 項目數 | 3–5 個，至少一個 M tier（G1 核准後才有 Stop acceptance） |
| 暫時的 `cmd:` 語法 | 現有 AC 是條列 `- [ ] **R1.1** …`；在 AC 那一行的行尾加 `` `cmd: …` `` 或 `` `manual: …` ``，regex 取最後一段 backtick |

**樣本數。** 統計單位是「失敗事件」（Stop 回報非 PASS 的一次），不是項目：3–5 個項目的樣本太小。
agent 常常自己跑到綠燈才停，失敗事件可能只有個位數，所以**失敗事件少於 15 次時，本次 spike 判為無效**，
追加項目直到湊滿，不從現有數字下結論。可以在項目裡刻意放一條會被本次改動弄壞的 INV，提高失敗事件數。

**記錄。** 每次 Stop 觸發寫一份到 `<projectStateRoot>/spike/<item>/<n>.json`（現有 layout 還沒有 `.devplan/`）：

```json
{
  "n": 3,
  "trigger": "stop",
  "worktree": "tree:…",
  "results": [],
  "oracleDiff": "git diff -U0 $(git merge-base HEAD origin/main) <worktree tree> -- <oracle pathspecs> 的輸出（worktree tree 依 3.3，含未追蹤檔）",
  "askedQuestion": "這次 Stop 前，agent 最後一則訊息是否在等使用者回答（人工標記）",
  "verifyColumnDiff": "與上一次相比，AC／INV 驗證欄的差異",
  "acTextDiff": "與上一次相比，AC 本文的差異"
}
```

`results` 格式同 3.3。

**分類。** 跑完後人工逐筆分類。分類清單：放寬 assertion（例如 `toBe` 改成 `toContain`、刪掉 `expect`）、加
`skip`／`only`／`xit`、刪測試、改 `-g`／`-t` filter、改 `cmd:`、改 runner 或 lint 設定、改 AC 本文。
每筆標「合理」或「弱化」。**漏抓**指確認是弱化，但沒有出現在 `oracleDiff` 裡。

**門檻：**

| 指標 | 定義 | 門檻 | 不合格時回頭修 |
| --- | --- | --- | --- |
| 收斂率 | 失敗事件在 `maxAutoRetries` 內、不需人介入修到 PASS 的比例 | ≥ 70% | D13：Stop feedback 撐不起主迴圈，改成 feedback 只做提示、由人驅動 |
| 漏抓的弱化 | 見上 | = 0（硬門檻） | D14：oracle 範圍 |
| 被抓到的弱化 | 出現在 `oracleDiff` 裡的弱化，平均每個項目幾件 | 只記錄；> 2 時檢討 | G3 人審負擔（D14），以及 S tier 合併核准（D17） |
| 空驗證 | `EMPTY`、`NO-REPORT` 加上被 allowlist 或 shell 語法檢查擋下的 `cmd:` 次數 | 只記錄 | D20 |
| 打斷提問 | `askedQuestion` 為真、卻被 Stop 喚醒的次數 | 失敗事件的 10% 以下 | D13：「oracle diff 非空」這個近似值不夠，改成提問時不喚醒、下一個使用者 turn 再注入 |
| 誤喚醒 | 因 flaky 或與本次改動無關的失敗而喚醒 agent 的次數 | 失敗事件的 20% 以下 | 3.5：加 flaky 重跑，或降級為提示 |
| Claude Code Stop 阻塞 | acceptance 執行期間使用者是否被卡住 | 不阻塞 | 3.5 |
| Cursor `stop` 延遲 | p50／p90 | p90 < `timeoutSec.acceptanceSync` | 3.5：Cursor `stop` 只跑 fast，acceptance 交給 CI |
| `PostToolBatch` 送達 | async `additionalContext` 是否在下一個 turn 送達 | 送達 | 3.5：fast 改在 Stop 一起跑 |

70%、20%、10% 與 15 次都是估計值（推測），只是起點；要改就在開跑前改。

**spike-a 的確認清單：** 附錄 A 標為推測的平台行為（`asyncRewake` 是否受 8 次上限約束）；三大 runner 讀 `DEVPLAN_JUNIT`
的設定方式、filter 沒匹配時的 exit code、testcase 檔案路徑的輸出位置
（jest-junit 需要 `addFileAttribute`；Vitest 預設放在 `classname`；Playwright 的 testsuite `name` 相對於 `testDir`，
以上皆待確認）；三大 runner 在 JUnit 裡記錄 `failures`／`errors` 的方式。

## 5. 驗收條件

延續 09-15 第 10 節的 1–7：

| # | 條件 | 對應階段 |
| --- | --- | --- |
| 8 | 任一 AC 的 `cmd:` 失敗時，Stop hook 把失敗輸出餵回 agent；在重試上限內不需人介入即可修正到 PASS（Claude Code 與 Cursor 各一個情境） | SV、S5 |
| 9 | 驗證 PASS 後改動任何 `.devplan/` 以外的檔案，該份證據判為 `STALE`，G3 失效 | SV |
| 10 | G3 核准後改動 AC、INV、驗證欄、`verify` 設定或 oracle 測試檔，G3 失效，CI 失敗 | SV、S3 |
| 11 | 手寫假的證據 JSON、在 `03-verify.md` 填任意 hex，或 G3 核准後改動 manual 證據列，都不能讓 CI 的驗收通過 | SV、S3 |
| 12 | Tier S 項目只有 `00-spec.md`，能從 `new` 走完 verify、approve、`archive`，不產生 plan、tasks、notes | S6 |
| 13 | S／M tier 在 G1 未核准時 Edit／Write 不被擋；L tier 在 G1 或 G2 未核准時 Edit／Write 放行、agent 收到提醒；D13 deny 清單內的操作一律被擋 | S3、S4 |
| 14 | `docs/rules-registry.md` 中每條 `quality` 規則都有 failure 欄；沒有的已刪除或標為 `review` | S6 |
| 15 | acceptance 超過時間預算時，未執行的 AC 記為 skipped、出現在 Stop feedback 裡，且不會被當成 PASS | SV |
| 16 | `cmd: true` 與不在 `verify.runners` 內的指令被 `coverage-lint` 擋；設了 reporter 時，filter 沒匹配到任何 test 的 `cmd:` 記為 `EMPTY`，不算 PASS | SV |
| 17 | main 上與本項目無關的測試檔改動 merge 後 rebase，G3 不失效；本項目 diff 內的測試檔被改動，G3 失效 | SV、S3 |
| 18 | CI 只驗 PR diff 碰到的 item；`verify.ci.skip` 內的條目不在 CI 跑、列在 CI summary；歸檔項目的 INV `cmd:` 繼續在 CI 跑 | SV |
| 19 | L tier 的 `verify.blackbox.path` 沒有測試檔，或 `BLACKBOX` 未 PASS 時，G3 無效 | SV |
| 20 | Claude Code 上 Stop 的 acceptance 在背景執行、不卡住使用者；M／L tier 在 G1 核准前不跑 acceptance；任何 tier 在本 item 的 oracle diff 為空時不跑 acceptance | SV |
| 21 | G1 核准後改 `cmd:` 的測試檔名或 filter（runner 前綴不變），G1 不失效；改變 `cmd:`／`manual:` 型式或 runner 前綴，G1 失效；G3 核准後改 `cmd:` 任何字元，G3 失效 | SV |
| 22 | G3 核准後改 `package.json` 的 `scripts`、runner 或 lint 設定、`tsconfig*.json`，G3 失效；只升級 dependencies 不失效；main 上改 `package.json` 的 `scripts` 或 `verify` 設定、merge 後 rebase，G3 不失效 | SV、S3 |
| 23 | 設了 reporter 時：runner 沒產出 JUnit 記為 `NO-REPORT`；執行到的 testcase 不在 oracle 範圍內記為 `UNGUARDED`；兩者都不算 PASS | SV |
| 24 | 驗證本身產生未 ignore 的檔案時判 FAIL 並列出檔案；驗證期間 worktree 被改動時結果為 `discarded`，不更新 `latest.json`、不喚醒 agent | SV |
| 25 | base 不是 main 的 stacked PR，本機核准的 oracle 指紋與 CI 重算的一致；`G3.base` 不存在時 CI 失敗並提示重新核准 | SV、S3 |
| 26 | `cmd:` 含 `\|\| true`、`;`、`&&`、`$(…)` 等 shell 語法時被 `coverage-lint` 擋；設了 reporter 時，JUnit 記到失敗的列即使 exit 0 也記為 `FAIL` | SV |
| 27 | 新寫、尚未 `git add` 的測試檔出現在 oracle diff 裡；worktree 不乾淨時 `devplan approve --gate G3` 拒絕核准並列出檔案 | SV |
| 28 | `approvals/<item>.json` 存完整 sha256；只有前 8 碼相同、完整值不同的指紋判為不一致 | SV |
| 29 | PR 碰到的 item 沒有有效的 G3 時 CI 失敗，訊息指出是哪個 item | SV、S3 |
| 30 | 殘留的 `acceptance.lock`（pid 不存在或超過 timeout）不會讓 acceptance 永久停跑；使用者送出新訊息後，自動重試計數歸零 | SV |

## 6. 未解項目

初稿列的 Stop 驗證範圍、oracle 範圍、L tier 的 G2、S tier 合併核准四項，已在 2026-09-25 拍板，
分別寫進 3.2、D14、D13、D17。二次 review 列的 `verify.baseRef` 與 PR base 不一致，改由核准記錄存 base ref 解掉
（D14、D15、D16）。三次 review 列的 shell 串接、未追蹤檔、指紋長度、提問時被喚醒、分批 PR 與 CI 衝突、
JSON key 整份 hash、lock 殘留與重試歸零，分別寫進 D20、D14、D16、D13、D15／D17、D14、3.5。剩下的：

0. **SV-spike 的目標 repo 與模型**（4.1「開跑前寫死」表格的兩個待填欄位）。沒填之前 spike-b 不能開跑；spike-a 不受影響。

1. **Feedback loop 會不會收斂、agent 會不會去弱化驗證。** 整個方向的前提，由 SV-spike 依 4.1 的門檻實測。
   Cursor `stop` 的 `followup_message` 以使用者訊息形式出現，對模型行為的影響一併觀察。
2. **`asyncRewake` 在 Stop 事件上的行為。** 喚醒是否受 `stop_hook_active` 與 8 次上限約束（推測不受）；
   重試上限到了之後，使用者只能從 agent 的轉述或下次 `SessionStart` 得知，體驗是否可接受。
3. **Runner 行為與 reporter 設定。** Jest、Vitest 的 filter 沒匹配到時是否回 exit 0；三大 runner 讀
   `DEVPLAN_JUNIT` 輸出 JUnit XML 的設定方式；testcase 檔案路徑放在哪個屬性、相對於哪個目錄（`UNGUARDED` 的前提）。SV-spike 實測。
4. **`timeoutSec.acceptance` 與 `acceptanceSync` 的預設值。** 300 秒與 120 秒都是估計值，要用真實 repo 的 E2E 跑一輪再調。
5. **Harness eval 的投入產出比**（D18），實測後再決定要不要進 CI。
6. **個人使用、沒有 branch protection 時**，agent 偽造的核准記錄只能被看見、不能被擋（D16）。
   是否要在 `doctor` 強烈建議開 branch protection。
7. **D18 盤點表中標為 `review` 的四列**（O／M／C 三軸與 subagent 範圍紀律、「讀過的檔案」表、plan §5、任務 Done 條件）
   要在 S6 結束前補上 failure 欄。

---

## 附錄 A：Stop 與工具後注入的 hook 事實（補 09-15 附錄 A）

影響 3.5 設計的部分，2026-09-25 依兩家官方文件確認。

| 項目 | Claude Code | Cursor |
| --- | --- | --- |
| 事件 | `Stop` | `stop` |
| 讓 agent 繼續 | `decision: "block"` + `reason`，或 `hookSpecificOutput.additionalContext`（非錯誤 feedback，transcript 標為 `Stop hook feedback`） | `followup_message`（以下一則使用者訊息自動送出） |
| 迴圈保護 | 輸入 `stop_hook_active`；連續 8 次後強制結束 | 輸入 `loop_count`；`loop_limit` 預設 5，可設 `null` |
| 其他輸入 | `last_assistant_message`、`background_tasks`、`session_crons` | `status`：`completed`／`aborted`／`error` |
| 工具後注入 | `PostToolBatch`：整批工具完成後觸發一次，`additionalContext`；無 matcher；回 `decision: block` 會中斷 loop | `postToolUse`：每次工具完成後觸發，`additional_context`；matcher 依工具類型（`Write`、`Shell`…） |
| 預設 timeout | command hook 600 秒；超時丟棄輸出 | 依平台預設；`failClosed` 預設 `false` |
| 背景執行 | `async: true`：不等待、不套 timeout、結果在下一個 turn 送達、不去重；`asyncRewake: true`：背景執行，exit 2 時立即喚醒 Claude（idle 也會），stderr 以 system reminder 送達，套 timeout | 無 |
| 注入長度上限 | `additionalContext`、`systemMessage` 與純 stdout 各 10,000 字元 | 未查 |
| 改檔前 `ask` | 有效 | `preToolUse` 的 schema 接受但不執行 |
| 只適合 formatter 的事件 | — | `afterFileEdit`（沒有輸出欄位） |

## 7. 參考

- Claude Code hooks reference：`code.claude.com/docs/en/hooks`（Stop decision control、PostToolBatch、Timeouts）
- Cursor hooks：`cursor.com/docs/hooks`（stop、postToolUse、preToolUse、`loop_limit`、`failClosed`）
- 前兩份檢視：`2026-09-14-claude-code-workflow-review.md`、`2026-09-15-open-source-readiness.md`
