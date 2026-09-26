# SDD 流程與效能檢視（Claude Code 為主要執行環境）

| 欄位 | 內容 |
| --- | --- |
| 日期 | 2026-09-14 |
| 狀態 | proposal — D0 定位已拍板；待拍板 D1–D5。**2026-09-25 部分被取代**：D0 由 D13 取代；P5 由 D17 取代；P6、P8、D3 由 D18 取代；D5 由新執行順序取代。見 `2026-09-25-verification-driven-sdd.md` 0.2 節 |
| 範圍 | 整個 devplan 工具：`bin/`、`lib/`、`scripts/`、`templates/`、`integrations/claude-code/` |
| 不含 | 任何專案私有 state；本文只談公開工具本身 |
| 修訂 | 2026-09-14 二次檢視：補 P0-A（核准狀態不受保護）與 P0-B.1（指紋豁免已實測繞過），D4 改判為前提，D5 改採 C |

> 這是一份分析與提案，不是規則。拍板後的規則會回寫到 `docs/` 既有文件或新的 skill，
> 本文保留為「為什麼這樣改」的紀錄。

## 0. 結論

Runtime 效能不是瓶頸（hook 50–90ms、`check --gate G2` 190ms）。真正的成本在五處，
其中第 1 項是前提問題：它不成立的話，第 2 項全部修完，Gate 仍然沒有強制力。

1. **核准狀態不在保護範圍內。** item 文件住在 `TOOL_ROOT/state/`、不在目標 repo 裡，
   而 gate hook 第一步就把 repo 外的 target 過濾掉——於是對 `notes.md` Gate 狀態表的編輯
   （包含「狀態」與「核准指紋」兩欄）完全不經任何檢查，`devplan fingerprint` 還負責把
   該貼的值印出來。「腳本唯讀所以 Claude 不能自己核准」並未兌現：agent 不需要腳本，
   它需要的是一個文字編輯器，而它有。見 P0-A。
2. **既有保護有 correctness 缺口。** 指紋豁免可被單方面觸發（已實測繞過，見 P0-B.1）；
   G1 只在 branch 選中 item 時檢查；guard 回 exit 3、config 解析失敗或其他例外時一律
   靜默放行；`archive` 也沒有驗 G3 是否有效核准。
   在擴充整合載體前，必須先證明既有 Gate 真的守得到。
3. **Claude 看不到 warn。** `hookMode: warn` 用 exit 1，在 Claude Code 語意裡是
   non-blocking error：transcript 只給人看一行 `Failed with non-blocking status code:`，
   **模型完全收不到訊息**，不會自我修正。預設模式下整套 gate 保護對 agent 是隱形的。
4. **Context 稅。** `templates/` 共 18.8k chars（CJK ≈ 1 token/char）、`docs/` 27k。
   每個 item 複製一份帶滿規則說明的模板；每個 session、每個 subagent 讀 `00-spec.md`
   時都重新吞這些散文。約 40–50% 是說明而非資料。
5. **流程靠 Claude 記得。** docs 引用的 `plan-verifier`／`verifier`／`executor`／
   `mech-executor` subagent、`README.md`〈對 Claude 的規則〉、`AskUserQuestion` 流程，
   repo 裡沒有任何實體。`hook install` 只裝 PreToolUse；沒有 CLAUDE.md 片段、
   commands、agents、skills。

### 0.1 定位（D0，已拍板）

這個工具要的是**真的 enforcement**，不是 checklist 提醒：核准狀態必須離開 agent 的可寫範圍，
並願意為此付額外複雜度。這一條先於其他所有決策——D2 的模式設計、D4 的 `approve` 命令、
D1 的載體選擇都由它推導。

曾評估並否決的替代方案：承認這是 checklist automation，把 `enforce` 收窄到 push／merge
這類有外部副作用的操作、其餘一律 `audit`，並改掉 docs 的語氣。否決理由是它放棄了
「Gate 未核准不得改程式碼」這個本工具存在的主要理由。但要記得：**在 P0-A 完成之前，
實際強度就等於這個被否決的選項**，那段時間裡 docs 的語氣是錯的。

## 1. 效能實測

環境：macOS、Node 現行 LTS、temp fixture（一個註冊 repo、一個 `active/r1/item`），
每項跑 3 次取穩定值。fixture 已刪除，未留任何檔案。

| 路徑 | 耗時 |
| --- | --- |
| bare `node -e 0` | 20ms |
| gate hook：branch 命中、G1 未核准 | 50ms |
| gate hook：path 命中 → spawn `gate-guard.js` | 80–90ms |
| pipeline hook：`git commit` → spawn `pipeline-guard.js` | 70–80ms |
| 每次無關 Bash（例如 `ls`）兩個 hook 都跑 | 70ms |
| `check --gate G2`（含 HTML 渲染） | 190ms |

### 可省但不重要的浪費

| 位置 | 問題 | 修法 |
| --- | --- | --- |
| `scripts/check.js` | 起 4 個子 process；`schema-lint` 實際跑 3 次（獨立一次 + `coverage-lint` 內 `assertSchema` + `gate-guard` 內 `assertSchema`） | 各檢查改成可 `require` 的函式，`check.js` 同 process 呼叫，schema 只驗一次 |
| `scripts/check.js` | 每次都跑 `render-html.js` 寫 2–4 個 HTML | 改 opt-in `--html` |
| `integrations/claude-code/settings.js` | Bash 的 gate 與 pipeline 是兩個 hook entry、兩個 node process | 合併成一個 entry，讀 payload 的 `tool_name` 分派 |
| `lib/hook.js` `gateHook` | 用 `runScript` spawn `gate-guard.js` 再 regex 解 stdout 的「檢查報告」 | `require` 進來直接呼叫，回傳結構化結果 |

合計省約 30–50ms/call。順手做，但不是重點。

## 2. 流程問題清單

### P0-A — 核准狀態不在保護範圍內（結構前提，先於 P0-B）

`lib/resolver.js` 的 `STATE_ROOT = path.join(TOOL_ROOT, 'state')`：item 文件不在目標 repo 內。
而 `gateHook` 的第一步是：

```js
const targets = parsed.targets.map((t) => repoRelative(t, context.repoRoot)).filter(Boolean);
if (targets.length === 0) return { exitCode: 0, output: '' };
```

`repoRelative` 對 repo 外的路徑回 `null`，被 `filter(Boolean)` 濾掉後 `targets.length === 0`
直接 exit 0。**因此對 `notes.md` 的任何編輯都不經檢查**——而 Gate 狀態表的「狀態」與
「核准指紋」兩欄就是整套 Gate 的信任錨點，`devplan fingerprint` 負責把要貼的值印出來。
branch 命中時的 G1 檢查也救不了：那條路徑同樣在這個過濾之後。

根因不是漏了一條規則，是檔案配置：`notes.md` 標題寫著「由 Claude 維護」，
**核准狀態與 agent 日常進度筆記共用同一個檔案**。agent 對該檔的寫入權限是流程必需的，
所以不能靠「禁止編輯 notes.md」解決。

修法方向（依 D0 採真 enforcement）：

- Gate 狀態表從 `notes.md` 拆成獨立的核准記錄；append-only 較佳，保留「誰、何時、
  核准了哪個指紋」而不只是當下狀態。
- hook 對該檔的寫入固定走 `enforce`／deny，不受一般模式影響；此判定必須在 repo-relative
  過濾**之前**完成，否則同一個洞會原封不動地重現。
- `devplan approve` 成為唯一寫入入口（即 D4——其性質因此從便利功能升級為前提）。

附帶要收斂的矛盾：程式碼裡有兩套「已核准」定義。`lib/hook.js` 的 `gateStatus` 只測
`/已核准|approved/i` 字樣，`gate-guard` 另外要求指紋有效；branch 命中的路徑上，
在狀態欄打三個字就能通過 hook 的 G1 檢查。

### P0-B — 既有 Gate 的可繞過與 fail-open 路徑

這些不是新增功能，而是現有保護的 correctness 缺口；應在 plugin 化前用 fixture 鎖住：

1. **指紋豁免可被單方面觸發（已實測繞過）。** `gate-guard.js` 的指紋分支呼叫
   `exemptedByRevisionNotes(revisions, null)`；`fromVer === null` 代表「檢查全部修訂列」，
   而不是「核准之後的修訂列」。舊的版本號分支傳的是 `approvedVer`、行為正確——
   **也就是推薦的指紋路徑比它取代的版本號路徑嚴格更弱。**
   實測（temp fixture，已刪除）：把一條已核准的 AC 從「匯出前必須通過權限檢查」改成
   「匯出前不需要權限檢查」，`gate-guard G1` 正確回 exit 1；接著只在修訂紀錄的「原因」欄
   寫「錯字修正，不影響核准」（AC 與指紋欄都不再動），同一支腳本回 exit 0、印出
   「Gate 仍有效」。
   三件事讓它從 bug 變成陷阱：修訂紀錄依 `fingerprint.js` 的設計被刻意排除在指紋之外，
   豁免開關因此住在不受保護的區域；模板自帶的 `v1 / 初版` 那一列也算數，連新增修訂列都不必；
   最後，blocker 訊息本身就是繞過教學——它寫「在修訂紀錄註明『不影響核准』並更新指紋欄」，
   而程式碼從未檢查指紋欄有沒有被更新。
   修法：豁免必須綁定一次具體的內容轉移（修訂列要記
   `spec:ab02eb8e → spec:6f786028 不影響核准`），下一次內容再變就自動失效，
   而不是掛一面永久免死金牌。
2. `lib/hook.js` 只有 `selection.selectedBy === 'branch'` 時會檢查 G1。由 path 或唯一 item
   選中時直接進 G2 判定，等於 G1 未核准仍可能開始改程式碼。
3. `gate-guard`／`pipeline-guard` 回 exit 3（結構錯誤）時，hook 目前把它當成 exit 0 放行。
   `loadConfig`、repo resolver 或任何其他例外也被最外層 `catch` 吞掉後放行。
4. pipeline 的 command regex 只認 `git commit`／`git push` 連續字樣，
   `git -C . commit`、`git -c key=value push` 可繞過。更根本的問題是
   `WRITE_PATTERNS`／`commandTargets` 這條路線：用 regex 從 bash 字串猜「這次會寫哪些檔」
   原則上補不完（`python -c`、`node -e`、heredoc、`xargs`、`npm run build`、引號裡的 `>`）。
   建議把權威判定移到 `PostToolBatch`，用 `git status --porcelain` 跟宣告路徑對帳——
   事後看真的動了什麼，而不是事前猜——`PreToolUse` 的 Bash 解析降級成便宜的 best-effort
   （見 §3 hooks 分工）。
5. branch 用 `declared.includes(branch)` 比對；`main` 會誤命中 `maintenance`。
   應正規化後做完整值比對，不做子字串比對。
6. strict pipeline 已宣告但狀態表為空時，`pipeline-guard.js` 仍 exit 0。
7. `devplan archive` 的檢查組合不含 `gate-guard G3`，證據格式通過但 G3 未核准／已過期時，
   仍可能印出「可以歸檔」。
8. `selectProject` 同時存在於 `lib/hook.js` 與 `scripts/lib/project-detect.js`，
   回傳欄位與 ambiguous 行為已不同；必須收斂成單一實作。

原則：無法判定保護狀態時不可靜默成功。`audit` 模式至少要留 log 並把 diagnostic 餵給模型；
`confirm`／`enforce` 模式則應停止或要求使用者確認。只有「確定不適用」才能無輸出放行。

### P1 — warn 模式對 agent 隱形（執行順序上排第一，見 D5-C）

`lib/hook.js` 的 `gateHook` 與 `pipelineHook` 在非 block 模式回 `exitCode: 1`。

Claude Code 現行 hook 語意：

- exit 2 → 阻擋，stderr 餵給模型
- 其他非 0 → **放行**，只在 transcript 顯示一行 hook error 給使用者；模型看不到
- exit 0 + stdout JSON → 依 `hookSpecificOutput` 決定：
  - `permissionDecision: "ask"` → 使用者確認；`permissionDecisionReason` 顯示給使用者，
    **不會自動餵給模型**
  - `permissionDecision: "allow"` + `additionalContext` → 不擋，但模型一定收到警告
  - 若用 `ask` 且模型也必須知道原因，要同時回 `additionalContext`

現況等於「warn 模式 = 沒有模式」，且對使用者來看像 hook 壞了。

舊版 auto mode 可能吞掉 hook 的 `ask`；官方文件記載 v2.1.211 起，`ask` 會強制顯示
permission prompt（classifier 仍可拒絕，但不能靜默核准）。D2 不再以舊限制設計。

### P2 — 多個 active item 時保護靜默失效

`lib/hook.js` `selectProject`：branch 對不到、path 對不到、又不只一個 item 時回 `item: null`，
`gateHook` 直接 `exit 0` 無輸出。這正是 `scripts/lib/project-detect.js` 開頭註解自己警告的
「看起來有檢查、其實沒檢查到」。

修正時先刪除 `lib/hook.js` 的 duplicate `selectProject`，統一使用
`scripts/lib/project-detect.js` 的結果。ambiguous 時至少要 `appendLog`；對模型與使用者的行為
依 D2 模式輸出 `additionalContext`／`ask`／`deny`，不要另創一套 `systemMessage` 語意。

pipeline hook 目前以空 targets 選 item，因此多 item 且 branch 對不到時也會靜默放行 commit。
要明確定義 commit 如何綁 item：優先用完整 branch equality；無法唯一判定時不得假裝 guard 已跑。

### P3 — `snapshot.js` 存在的理由沒被自動化

它的目的是「context 壓縮後不必重讀四個檔」，但要 Claude 記得跑。應掛 `SessionStart`
hook（matcher `startup|resume|compact`）用 `hookSpecificOutput.additionalContext` 注入，
這是官方 hooks guide 明列的 compaction 復原模式。

已知限制：`SessionStart` 只在 CLI process 啟動／resume 觸發，同 process 內切對話不重跑。

### P4 — 核准指紋要人手貼

流程：`devplan fingerprint` → 人複製 → 貼進 `notes.md` Gate 狀態表的「狀態」「核准指紋」
「日期」三欄。多一個回合、多一類抄錯。

提案 `devplan approve --repo <id> --item <key> --gate G2`：一次寫入三欄。
「腳本唯讀」原則的目的是防 Claude 自己改核准；使用者明確下的 CLI 指令不衝突，
且可在 pipeline hook 的 RISKY 清單加入 `devplan approve`，禁止 agent 自動執行。

補充（二次檢視）：把 `devplan approve` 列入 RISKY 清單是必要但遠遠不足的——P0-A 顯示
agent 根本不需要這個命令，直接編輯 `notes.md` 的核准欄即可，而那條路徑完全沒有檢查。
所以 P4 不只是「省一個回合」的人因問題，它與 P0-A 是同一件事的兩面：核准必須有唯一的
寫入入口，其他寫入路徑要被實際擋下。

### P5 — Tier S/M 也複製六個模板

`bin/devplan.js` `createItem` 用 `fs.cpSync(templates)` 整包複製。Tier M 不需要
`01-plan.md`／`03-verify.md`，Tier S 只需 `notes.md` 一行。副作用：`schema-lint` 會去驗
空模板、`listActiveProjects` 多掃、subagent 多讀。

提案 `new --tier S|M|L` 只複製對應檔案；Tier 事後升級時再 `devplan add-doc`。

但這不能只改 `createItem`：現有 resolver 與 `listActiveProjects` 都把「存在 `00-spec.md`」
當成 item 身分，G3／archive 又強制要求 `03-verify.md`。若 Tier S 真只有 `notes.md`，
CLI 與 hook 會完全看不到它；Tier M 也無法走現有歸檔流程。

先拍板並測試完整生命週期：

- Tier S 是否是正式 active item？若是，需要獨立的 machine-readable item marker，
  不能再用 `00-spec.md` 是否存在辨識 item。
- Tier M 的完成條件與 G3 證據放哪裡？若仍需要逐條驗證，就不能宣稱不需要 `03-verify.md`；
  若不需要，`check G3`／`archive` 必須 tier-aware。
- `new` 時是否已有足夠資訊判 Tier？若 Tier 要等 spec 問答後才能判定，初始命令應先建立
  最小 item marker，再由 `devplan set-tier`／`add-doc` 完成升級。

### P6 — 規則沒有落點

- `docs/strict-commit-pipeline.md` 說「這一條併入 `README.md`〈對 Claude 的規則〉」，
  公開化後那一節不存在。
- 「Claude 不執行 `git commit` 除非使用者要求」「G2 後先問嚴格／一般模式」「subagent 範圍紀律
  逐字帶上」——現在沒有任何機制讓 agent 載入這些。
- `templates/notes.md` 與 `docs/decision-anchors.md` 引用的 `plan-verifier`／`verifier`／
  `security-reviewer`，`docs/strict-commit-pipeline.md` 引用的 `executor`／`mech-executor`，
  都沒有對應的 agent 定義檔。

### P7 — 核心檢查邏輯零測試

`tests/run.js` 只測 `lib/` 與 `privacy-check`。`gate-guard`／`coverage-lint`／
`verify-evidence-lint`／`pipeline-guard`／`archive` 都沒有 fixture 測試。這些腳本的 regex
與模板結構高度耦合（例如 `coverage-lint.js` 的 AC 行 regex 要求
`- [ ] **R1.1** … \`[C]\`` 精確格式），要做 P8 的模板瘦身，沒這層會很危險。

fixture 至少要包含 P0-A 與 P0-B 的每一條 bypass，以及：

- guard exit 0／1／3 如何映射到 `audit`／`confirm`／`enforce`
- 多 item：branch 唯一、path 唯一、兩者衝突、完全 ambiguous
- Tier S/M/L 的 new → check → approve → archive 路徑
- schema 欄位改名時，所有讀該欄位的 checker 都必須明確失敗
- fingerprint 核准、內容變更、白名單修訂與 STALE evidence

### P8 — 模板即說明書

| 檔案 | 大小 | 估計說明散文比例 |
| --- | --- | --- |
| `templates/notes.md` | 5.2k | ~80%（真正表格不到 1k） |
| `templates/01-plan.md` | 3.9k | ~50% |
| `templates/00-spec.md` | 3.8k | ~45% |
| `templates/03-verify.md` | 3.7k | ~55%（「可以／不可以」對照表、NOT-PROVEN 說明） |
| `templates/02-tasks.md` | 2.1k | ~40% |

每個 item 一份、每次讀一次、每個 subagent 再讀一次。這些說明是「規則」，
該住在只載入一次的地方（skill／CLAUDE.md），不該住在「資料」裡。

瘦身的前置條件是把 schema 從散文裡抽出來。所有 checker 都拿 CJK 標題與欄名當 schema
（`extractSection(notes, /^Gate 狀態$/)`、`'核准指紋'`、`coverage-lint.js` 的 AC 行 regex），
而 `schema-lint.js` 的 `SCHEMA` 常數已經是「schema 與散文分離」的雛形。應先把它擴成單一
source of truth 並由它生成模板骨架，否則 P7 的測試只是把現在的耦合凍結起來。

## 3. 建議架構：核心引擎與 Claude Code adapter 分離

先把 checker 從「會 `process.exit` 的 CLI script」改成純函式：

```text
lib/core/
├── project-selection.js
├── checks/
│   ├── schema.js
│   ├── coverage.js
│   ├── gate.js
│   ├── evidence.js
│   ├── pipeline.js
│   └── archive.js
└── result.js
```

每個 checker 回結構化結果，例如
`{ status: "pass"|"blocker"|"structure", diagnostics: [...] }`；CLI、hook 與測試共用同一函式。
不要再 spawn script、解析 stdout 裡是否出現「檢查報告」來判定語意。`scripts/` 只保留薄 CLI
adapter。這同時解決測試性、重複 schema 檢查與每次多起 process 的問題。

Claude Code 整合則是 adapter，不讓核心 workflow 綁死單一 agent runtime：

```
integrations/claude-code/
├── .claude-plugin/plugin.json     # manifest 必須在這個位置
├── hooks/hooks.json               # SessionStart / PreToolUse / PostToolBatch / Stop
├── commands/                      # /devplan:new  :snapshot  :check  :approve  :archive
├── agents/                        # plan-verifier  verifier  executor  mech-executor  security-reviewer
│                                  #   範圈紀律內建；tools 限制；mech-executor 指定便宜模型
├── skills/devplan-workflow/
│   └── SKILL.md                   # progress-rhythm / decision-anchors / numbering 的可執行版
└── CLAUDE.md.fragment             # 目標 repo 只放 ~20 行，指向 skill
```

### hooks 分工

| 事件 | matcher | 做什麼 |
| --- | --- | --- |
| `SessionStart` | `startup\|resume\|compact` | 跑 `snapshot`，以 `additionalContext` 注入 |
| `PreToolUse` | `Edit\|Write\|NotebookEdit\|Bash` | 現有 gate／pipeline 判定，改用 JSON 輸出（見 D2） |
| `PostToolBatch` | — | 一批 edit 完成後，若動到 `0x-*.md`／`notes.md` 才跑 schema；避免平行 edit 重複執行與暫時性半成品誤報。同時用 `git status --porcelain` 對帳宣告路徑，作為「有沒有動到受管檔案」的**權威**判定（見 P0-B.4） |
| `Stop` | — | `02-tasks.md` 有 `wip` 但 `notes.md`「進行中」未更新 → 要求補；必須檢查 `stop_hook_active`，最多提醒一次 |

`SessionStart` 若有多個 active item，不可任選一個 snapshot 注入；應列出 candidates 與
ambiguous 原因，讓後續透過 branch／path 或使用者選擇決定。

`PostToolUse` 發生在單一工具完成後，檔案可能正處於多步修改的中間狀態。現行 Claude Code
已有 `PostToolBatch`，此處優先使用 batch event，最後仍由明確的 `devplan check` 作 Gate 判定。

`Stop` hook 會讓 conversation 繼續，若狀態無法自動修復可能形成迴圈；除了
`stop_hook_active`，還應在背景工作未完成、item ambiguous 或使用者中斷時放行並留下 diagnostic。

### 模板

瘦成純表格 + 標題 + 一行「規則見 devplan-workflow skill」。說明散文全部進 `SKILL.md`，
on-demand 載入一次。

### 安裝

`devplan install --repo-root <repo>` 取代 `hook install`。採 D1-A 時，它負責註冊／啟用 plugin
並只寫目標 repo 必要的最小設定，不把 hooks、commands、agents、skills 各複製一份；
採 D1-B 時才複製 `.claude/` 元件。`uninstall` 對稱移除，沿用現有 backup 機制。

兩個現存的 adapter 缺口要一起修：

- `integrations/claude-code/settings.js` 的 `commandFor` 把工具位置寫死成安裝當下的相對路徑
  （`node "$CLAUDE_PROJECT_DIR/../../sdd-dev/bin/devplan.js" hook …`）。工具目錄一搬，
  指令找不到 → exit 127 → 依 Claude Code 語意是 non-blocking error → 放行。
  **移動或改名工具目錄等於靜默停用全部 Gate。** 這是 D1-A（`${CLAUDE_PLUGIN_ROOT}` 定位）
  的實質理由，不只是「比較乾淨」。
- `removeOurs` 只清 `PreToolUse`。擴到 `SessionStart`／`PostToolBatch`／`Stop` 之後，
  `uninstall` 會留下三個孤兒 hook，指向可能已不存在的路徑。

## 4. 決策點（待拍板）

### D1. 整合載體

| 選項 | 內容 | Pros | Cons |
| --- | --- | --- | --- |
| A | Claude Code plugin（`.claude-plugin/plugin.json` + hooks + commands + agents + skills 一包，`${CLAUDE_PLUGIN_ROOT}` 定位） | 最乾淨、可 marketplace 分發、更新一處 | plugin 機制較新、使用者需 enable |
| B | 維持 `settings.json` 安裝，另把 commands/agents/skills 複製進目標 repo `.claude/` | 相容現況 | 每個 repo 一份拷貝，會漂移 |
| C | 裝在 user-level `~/.claude/` | 一次裝、跨 repo | 違反 `privacy-boundary.md`「不依賴 home directory」 |

A 還有一個沒被記到的實質好處：`${CLAUDE_PLUGIN_ROOT}` 一併修掉「工具目錄一搬就靜默停用
全部 Gate」的問題（見 §3 安裝）。現行 `commandFor` 寫死安裝當下的相對路徑，路徑失效時
hook 以 exit 127 收場，而那在 Claude Code 語意裡是放行。

### D2. hook policy 模式

| 選項 | 內容 | Pros | Cons |
| --- | --- | --- | --- |
| A | 改成三個明確模式：`audit` = `allow + additionalContext`；`confirm` = `ask + additionalContext`；`enforce` = `deny`／exit 2 | 語意清楚；使用者與模型都收到正確訊息；可逐步畢業 | 要遷移現有 `warn`／`block` 設定 |
| B | 維持 `warn`／`block` 二元模式，只修成 JSON | 變更較小 | `warn` 到底是純提醒還是要求確認仍不清楚 |

建議採 A：現有 `warn` 遷移為 `audit`，`block` 遷移為 `enforce`。push／PR／merge 與
`devplan approve` 這類不能授權 agent 自行執行的命令固定走 `enforce`，不受一般模式影響。
所有 structured output 一律 exit 0 且 stdout 只輸出 JSON；exit 2 留給真正的 blocking error。

### D3. 模板瘦身幅度

| 選項 | 內容 | Pros | Cons |
| --- | --- | --- | --- |
| A | 激進：只留表格與標題，說明全進 skill（估砍 60–65%） | context 稅最低 | 需先補 P7 測試 |
| B | 溫和：每節留一行指引（砍 ~35%） | 風險低 | 仍有重複 |

### D4. `approve` 寫入指令（已由 P0-A 升級為前提，不再是便利功能）

| 選項 | 內容 | Pros | Cons |
| --- | --- | --- | --- |
| A | 新增 `devplan approve --gate`，在同一次操作計算當下指紋並原子寫入獨立的核准記錄；成為該記錄的唯一寫入入口，hook 對其他寫入路徑固定 deny | 少一回合、無抄錯、避免計算後內容又變動；**且是 P0-A 的載體** | 打破「腳本唯讀」的絕對敘述，要改 docs |
| B | 維持人手貼指紋 | 不動 | 現況痛點不變 |

原本 A 的 Cons 被記成「打破腳本唯讀敘述」。P0-A 顯示那個敘述本來就沒兌現——agent 可以直接
編輯 `notes.md` 的核准欄，唯讀腳本擋不住任何東西。所以這個 Cons 不是「失去一項保護」，
而是「把一個從未存在的保護，換成一個真的存在的保護」。B 在 D0 之下不再是可行選項。

### D5. 執行順序

| 選項 | 順序 |
| --- | --- |
| A | P0（A+B）/P7 contract tests → P0/P1/P2 correctness → Tier 生命週期 → core 純函式化 → D1 plugin → D4 approve → D3 瘦身 |
| B | D1 載體先（最快看到體感差異）→ 其餘 |
| C | D2 → P0-B（1 指紋洞、其餘 fail-closed）→ P0-A 核准狀態外移（含 D4）→ P7 contract tests → Tier 生命週期 → core 純函式化 → D1 → D3 |

**建議：D0 真 enforcement、D1-A、D2-A、D3-A、D4-A、D5-C。**

改採 C 而非 A，理由是第 0 節第 3 項：預設 `warn` 模式下模型收不到任何訊息，所以 P0-B 的
fail-open 目前「幾乎不重要」——就算 hook 正確擋下了，也沒有人或模型看得到。在可觀測性
成立之前修 correctness，無法確認自己修好了。D2 是 `lib/hook.js` 內約 20 行的改動，
而且它定義了後續所有修正的輸出契約（`additionalContext`／`ask`／`deny`）；先做，
P7 的 contract tests 才有明確的斷言對象，不必寫完測試再回頭改契約。

P0-A 排在 P0-B 之後、P7 之前：它要改檔案配置與 CLI（拆核准記錄、`approve` 寫入路徑），
比 P0-B 的區域性修正大，但必須在 plugin 化與模板瘦身之前完成——否則後面兩步都是在一個
信任錨點不成立的系統上疊東西。

不建議採 D5-B：把尚有 bypass 的 hook 先包成 plugin，只會讓錯誤保護更容易安裝。

可交付 milestone：

1. hook 的每一種判定結果（pass／blocker／structure／ambiguous）都能在 transcript 與模型端觀察到。
2. P0-A／P0-B 的每一條 bypass 都有 fixture 鎖住，含 P0-B.1 的指紋豁免重現腳本。
3. 核准記錄只能由 `devplan approve` 寫入，直接編輯該檔會被 deny 且留下 diagnostic。

## 5. 參考

- Claude Code hooks reference：`code.claude.com/docs/en/hooks`
- Claude Code hooks guide（compaction 復原模式）：`code.claude.com/docs/en/hooks-guide`
- Claude Code plugins：`code.claude.com/docs/en/plugins`
- Claude Code plugins reference：`code.claude.com/docs/en/plugins-reference`
- anthropics/claude-code issue #61918：歷史上的 auto mode `ask`／`SessionStart` 行為；
  `ask` 問題已由官方文件標示於 v2.1.211 修正，不再作為 D2 的現行限制
