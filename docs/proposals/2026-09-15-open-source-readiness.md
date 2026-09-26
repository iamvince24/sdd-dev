# 開源整備檢視（devplan → 公開發佈）

| 欄位 | 內容 |
| --- | --- |
| 日期 | 2026-09-15 |
| 狀態 | proposal — D6–D12 已拍板，S0–S7 待執行。**2026-09-25 部分被修訂**：D7 由 D13 修訂；D10 由 D16 修訂；S2 與 S3 之間插入 SV 階段，S3–S7 範圍調整。見 `2026-09-25-verification-driven-sdd.md` 0.2 節與第 4 節 |
| 範圍 | 整個工具的公開發佈整備：distribution、i18n、enforcement 強度、整合載體、OSS 門面 |
| 不含 | 任何專案私有 state；本文只談公開工具本身 |
| 前置 | `2026-09-14-claude-code-workflow-review.md`（D0–D5、P0-A、P0-B、P1、P7） |

> 這是一份分析與提案，不是規則。拍板後的規則會回寫到 `docs/` 既有文件或新的 skill，
> 本文保留為「為什麼這樣改」的紀錄。
>
> 本文延續前一份檢視的編號空間：問題用 `OS-n`（open source）、決策接在 D5 之後用 `D6`–`D12`。
> 引用 `P0-A` / `P0-B` / `P1` / `P7` 時指的是前一份檢視的定義。

## 0. 結論

程式碼本體的公開整備是健康的：沒有個人絕對路徑、沒有真實公司或專案識別碼、
`privacy-check` 通過、10 個測試通過、零 npm runtime 依賴、MIT LICENSE 齊備。

開源的阻礙**不在 hygiene 缺件**（CONTRIBUTING、CI、CHANGELOG 那些），而在三個結構性問題：

1. **OS-1 — distribution model 要求使用者把私有資料放進本工具的 clone。** 這同時是 `P0-A`
   的成因，兩者是同一個問題的兩面。
2. **OS-2 — 整個驗證層硬綁繁體中文表頭字面值。** 非中文使用者翻譯模板 → 檢查靜默失效，
   而這正是 `schema-lint.js` 存在要防的那個失敗模式。
3. **OS-3 — docs 宣稱的強制力高於實際強制力。** 前一份檢視的 0.1 節已自承這件事；
   開源會把它的成本從「自己知道」放大成「使用者覺得被騙」。

三者之中 OS-1 是前提：修掉它會連帶解決 `P0-A`、npm 安裝、團隊共用、`doctor` 要求 ≥2 repo
這四件事。其餘都是它的下游。

### 0.1 與 2026-09-14 檢視的關係

前一份檢視問的是「這個流程對我自己好不好用」，本文問的是「這個流程交給陌生人能不能裝起來、
用得下去、改得動」。兩者在三處交會：

| 前一份的項目 | 本文的處理 |
| --- | --- |
| `P0-A`（核准狀態不受保護） | 由 D6 的 layout 變更解決 —— state 進到目標 repo 內，hook 才看得到它 |
| `D1`（整合載體選擇） | 改判：範圍從「Claude Code plugin 化」擴為「Claude Code + Cursor 雙 adapter」，見 D9 |
| `D3`（模板瘦身） | 與 D8 的英文化**合併執行**。不要先翻譯 18.8k chars 的散文再刪掉它 |
| `D4`（`approve` 命令） | 保留為前提，並在 D10 補上它的 enforcement 上限與誠實邊界 |
| `P7`（零 contract test） | 升為 S0，排在所有改動之前 |

前一份檢視列的效能浪費（4 個 process、`schema-lint` 跑 3 次、每次都 render HTML）不另外排階段，
它們會在 S4 把 checker 改成可 `require` 的函式時順帶解決。

## 1. 現況盤點

開源前的體檢結果，作為後續改動的基準線。

| 檢查 | 結果 |
| --- | --- |
| `npm test` | 10 passed |
| `node bin/devplan.js doctor` | **fail** — `fewer than two repositories are registered` |
| `npm run privacy-check` | pass，掃 51 個檔案，無私有標記／個人路徑／credential |
| 硬編碼個人絕對路徑 | 無（`privacy-check.js:60` 出現的 home 目錄前綴是掃描 regex，不是路徑） |
| 真實公司名／專案代號 | 無。`examples/` 與 `devplan.local.example.json` 都是 fictional placeholder |
| runtime 依賴 | 零，只用 Node built-in + `git` CLI |
| LICENSE | MIT，holder 為 `iamvince24` |
| npm 名稱 `devplan` | **已被佔用**（v1.0.1）。`sdd-dev` 可用 |

`doctor` 在乾淨 checkout 上必定失敗這件事本身就是 OS-4 的一部分，見第 3 節。

## 2. 結構性阻礙

### OS-1 — Distribution model 要求使用者把私有資料放進本工具的 clone（最嚴重）

`lib/resolver.js` 的 `STATE_ROOT = path.join(TOOL_ROOT, 'state')`，而 `lib/config.js:36-38`
的 `resolveRepoRoot` 又把註冊的 repo 解析成**相對 TOOL_ROOT** 的路徑：

```js
function resolveRepoRoot(entry) {
  return path.resolve(TOOL_ROOT, entry.repoRoot);
}
```

於是使用者的流程是「clone 本 repo → 在這個 clone 裡面放自己的私有 spec → 註冊隔壁的 repo」。
四個後果：

- **升級路徑衝突。** 使用者的 `state/` 與 `devplan.local.json` 和工具原始碼在同一棵 tree 裡。
  他要拿新版就得 `git pull`，而維護者改 `.gitignore` 或 `templates/` 都可能撞到他。
- **無法 npm 安裝。** 沒有 `npm i -g`、沒有 `npx`。`package.json` 的 `"private": true`
  與 `"version": "0.1.0-local"` 也直接封死 publish。
- **強迫 sibling layout。** `integrations/claude-code/settings.js:12-13` 產生的 hook command
  是 `$CLAUDE_PROJECT_DIR/<relative>/bin/devplan.js`；使用者的 repo 不放在工具 clone 的隔壁就失效。
- **團隊無法共用。** state 在個人 clone 裡，兩個人跑同一個專案就是兩份不相干的 Gate 狀態。

**與 `P0-A` 的同一性。** 因為 state 在目標 repo 之外，`lib/hook.js:77-78` 的第一步就把它過濾掉：

```js
const targets = parsed.targets.map((target) => repoRelative(target, context.repoRoot)).filter(Boolean);
if (targets.length === 0) return { exitCode: 0, output: '' };
```

agent 編輯 `state/.../notes.md` 的 Gate 狀態表（含「狀態」與「核准指紋」兩欄）時，
`repoRelative` 回 `null` → `targets` 空 → 直接放行，完全不經任何檢查。
`devplan fingerprint` 還負責把該填的值印出來。

所以**修 distribution 與修 `P0-A` 是同一件事**，不是兩件要排優先序的事。

### OS-2 — 驗證層硬綁繁體中文表頭字面值

機器判定的 key 全部是中文字面值。`scripts/schema-lint.js:22-53`：

```js
const SCHEMA = {
  '00-spec.md': [
    { heading: null, headers: ['欄位', '內容'], ctx: 'metadata 表' },
    { heading: /^9\. 問答紀錄$/, headers: ['#', '狀態', '問題'], ctx: '問答紀錄' },
    // ...
```

同樣的耦合遍佈整個判定層：

| 檔案 | 行 | 內容 |
| --- | --- | --- |
| `scripts/lib/fingerprint.js` | 17, 43, 45, 53, 54, 60, 61, 62 | `['狀態', '關聯 Gotcha']`、`/^4\. 需求與驗收條件$/`、`findTableByHeader(section, '服務 AC')`、`r['任務']` |
| `scripts/coverage-lint.js` | 50, 71, 73, 76, 80, 89, 152, 205, 208, 215 | `/^9\. 問答紀錄$/`、`r['狀態']`、`t['服務 AC']`、`t['檔案']`、`g['位置']`、`t['關聯 Gotcha']` |
| `scripts/lib/project-detect.js` | 39, 40, 42, 51 | `/^任務清單$/`、`r['任務']`、`r['檔案']`、`meta['Git branch']` |
| `lib/hook.js` | 44, 47 | `extractSection(readFile(notes), /^Gate 狀態$/)`、`row['狀態']` |
| `scripts/gate-guard.js` / `verify-evidence-lint.js` / `archive.js` / `snapshot.js` | 多處 | 同一模式 |

`scripts/schema-lint.js:5-9` 的註解寫得很清楚，這支存在的唯一理由就是防「改表頭 → 檢查靜默失效」。
但一個英文使用者把 `## 9. 問答紀錄` 翻成 `## 9. Q&A Log`，
`fingerprint.js:43` 的 `sectionBody(content, /^9\. 問答紀錄$/)` 就抽不到內容 —— 指紋算出來是空的、
Gate 照樣通過，而他不會收到任何訊號。

實質上這個工具現在**只能給讀繁體中文的人用**。這是個合理的定位選擇，但必須是有意識的選擇，
而不是實作副作用。半套（README 英文、判定層中文）是最糟的組合。

### OS-3 — docs 宣稱的強制力高於實際強制力

前一份檢視的 0.1 節自承：「在 P0-A 完成之前，實際強度就等於這個被否決的選項，
那段時間裡 docs 的語氣是錯的。」

開源會放大這句話的成本。`docs/numbering-and-tiers.md` 與 `docs/strict-commit-pipeline.md`
的語氣是「Gate 未核准不得改程式碼」，但實際上：

| 位置 | 行為 |
| --- | --- |
| `lib/hook.js:97-99`、`lib/hook.js:126-128` | catch-all，任何例外（config 解析失敗、payload 非法 JSON）一律 `exitCode: 0` 放行，且不留痕跡 |
| `lib/hook.js:92` | `guard.code !== 1` 就放行 —— guard 回 exit 3（結構錯誤）等於通過 |
| `lib/hook.js:85` | G1 只在 `selection.selectedBy === 'branch'` 時檢查 |
| `lib/hook.js:96`、`:125` | `hookMode: 'warn'` 回 exit 1，在 Claude Code 語意下模型收不到訊息（`P1`） |
| `scripts/archive.js` | 不驗 G3 是否有效核准 |

第一個發 issue 說「我沒核准也改得動程式碼」的人，會覺得 README 在騙他。
開源前必須二選一：先做完 `P0-A` / `P0-B`，或改掉 docs 語氣。見 D7。

## 3. OS-4 — 新使用者第一小時會撞到的牆

| 問題 | 位置 |
| --- | --- |
| `doctor` 硬要 ≥2 repo，乾淨 checkout 上第一個健檢命令必定失敗 | `bin/devplan.js:122` |
| `docs/local-migration.md` 整份是從 legacy `.devplan-v2` 遷移的紀錄，外部使用者沒有這個東西 | 整份 |
| 三個名字並存：repo `sdd-dev` ／ package `devplan-local` ／ docs 與 regex `devplan-v2` | `package.json:2`、`scripts/README.md:1`、`integrations/claude-code/settings.js:16`、`tests/run.js:67` |
| `devplan` 在 npm 已被佔用，且 devplan.com 是同領域商業產品 | — |
| README 只有 26 行，沒說「這是什麼／為什麼要用／Gate 是什麼」 | `README.md` |
| 反過來 detail docs 大量引用 README 裡**不存在**的〈對 Claude 的規則〉〈失效鏈表〉〈日常規則摘要〉 | `docs/decision-anchors.md:61`、`docs/strict-commit-pipeline.md:11`、`docs/numbering-and-tiers.md:3` |
| docs 通篇寫 `devplan xxx`，但沒有 `npm link` 時只能 `node bin/devplan.js xxx` | `docs/automation.md` vs `README.md:9` |
| `privacy-check` 的語意對外部使用者是反的 —— 它保護的是**作者**不要把公司資料推上公開 repo | `scripts/privacy-check.js` |

**文件承諾但實作不存在的介面**（必須實作或從 docs 移除）：
`devplan approve`、`devplan add-doc`、`devplan set-tier`、`devplan new --tier S|M|L`、
`devplan install --repo-root`（實際是 `devplan hook install`）、
`plan-verifier` / `verifier` / `executor` / `mech-executor` / `security-reviewer` 五個 subagent、
`AskUserQuestion` 流程、`references/decision-anchors.md`（`scripts/lib/fingerprint.js:6` 註解路徑寫錯，
應為 `docs/decision-anchors.md`）。

## 4. OS-5 — 正確性與貢獻者面

### 4.1 會真的壞掉的

| 問題 | 位置 | 影響 |
| --- | --- | --- |
| `spawnSync('node', ...)` 而非 `process.execPath` | `scripts/check.js:46`、`:60` | nvm／Volta／fnm 環境下找不到或用到錯版本的 node。`lib/run-check.js:8` 是對的，兩者不一致 |
| `engines.node: ">=16"` 但用了 `fs.cpSync` | `package.json:10` vs `bin/devplan.js:80` | `fs.cpSync` 需要 16.7+ |
| `.gitignore` 沒有 `.env`，但掃描規則有 | `.gitignore` vs `bin/devplan.js:128`、`scripts/privacy-check.js:52` | 掃描規則比 ignore 規則寬，預留一個踩雷點 |
| branch 比對用子字串 | `scripts/lib/project-detect.js:100`、`lib/hook.js:55` | `feat/foo` 會誤中 `feat/foo-bar`。**同一支檔案的第 18-19、30 行註解明確說明路徑比對已經從子字串修成 segment 比對，但 branch 比對漏改** |
| `listActiveProjects` 深度上限 3 層無使用者可見訊號 | `scripts/lib/project-detect.js:67` | 更深的 nesting 靜默找不到項目 |
| Cursor 的 `beforeShellExecution` payload 在頂層 `command` | `lib/hook.js:29-32`、`:113` 只讀 `payload.tool_input` | Cursor adapter 下會拿到 `undefined`。見附錄 A |

### 4.2 開源後會痛的

- **10 個測試，零覆蓋 Gate 判定邏輯。** `check.js`、`gate-guard.js`、`coverage-lint.js`、
  `verify-evidence-lint.js`、`pipeline-guard.js` 全裸，加上沒有 CI，第一個 PR 就能靜默改壞 Gate。
  這就是前一份檢視的 `P7`。
- **三處 fail-open 不留痕跡。** `lib/hook.js:68`（`appendLog`）、`:97`、`:126`。
  使用者報 bug 時維護者沒有任何線索。
- **`selectProject` 重複兩份且不一致。** `lib/hook.js:50-63` 與
  `scripts/lib/project-detect.js:93-110`：回傳 key 不同（`item` vs `project`）、
  參數不同（positional `targets` vs `{ outsideTargets }`），且 `lib/hook.js` 的副本**缺少**
  `projects.length === 0` 的早退與 `ambiguous` 旗標。
- **`lib/` 反向依賴 `scripts/lib/`。** `lib/hook.js:9-10` require `../scripts/lib/md`
  與 `../scripts/lib/project-detect`，分層方向相反。
- **程式碼註解與所有 CLI 輸出訊息為繁體中文。** 若目標是全球社群，這會直接篩掉貢獻者。
- **無 ESLint / Prettier / EditorConfig。**

### 4.3 OSS hygiene 缺件

`CONTRIBUTING.md`、`CHANGELOG.md`、issue / PR templates、GitHub Actions、`SECURITY.md`、
npm publish 設定（`files` 欄位、移除 `private`、語意化版號）、README badges。

這些最好補，但都不是瓶頸 —— 在現在的 layout 上先補 CI 與 CONTRIBUTING 會白做，見第 8 節的排序。

## 5. 決策紀錄（D6–D12）

### D6 — Distribution：npm package + state 進目標 repo 的 `.devplan/`

**選定。** 工具本身成為純 npm package，不再是被 clone 的 central hub。
state 住在使用者 repo 內的 `.devplan/`。

一次解決 OS-1 的四個後果，並讓 `P0-A` 變成可解：核准狀態進到 repo 內，
`lib/hook.js:77-78` 的 `repoRelative` 才看得到它。

| 被否決的方案 | 否決理由 |
| --- | --- |
| state 放 `~/.devplan/projects/<id>/` | 保住「私有資料絕不進 repo」的隱私模型，但 `P0-A` 要另外用 file lock 或外部核准機制解，且團隊仍無法共用 |
| 混合：核准狀態進 repo、spec 與 evidence 放家目錄 | 最小改動能解 `P0-A`，但兩地維護、`snapshot` 要跨兩棵 tree、文件複雜度加倍 |
| 維持 clone-and-use | OS-1 全部成立 |

### D7 — 開源定位：先修完 `P0-A` + `P0-B` 才開源

**選定。** docs 維持「真 enforcement」語氣，但要在 `P0-A` / `P0-B` 完成後才公開發佈。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 現在就開源，README 明講「workflow scaffolding + 可繞過的 guard rails」 | 最快，但放棄了「Gate 未核准不得改程式碼」這個本工具存在的主要理由（延續 D0 的判斷） |
| 收窄 `enforce` 到 push / PR / merge，其餘 `audit` | 語氣誠實且立刻可開源，但同上，等於承認 checklist automation |

註：D7 不免除 D10 的誠實邊界說明義務。修完 `P0-A` 之後強度仍有上限，README 要寫清楚上限在哪。

### D8 — 語言：英文為主，繁中降為 locale pack

**選定。** 程式碼註解、CLI 輸出、`docs/` 主版本英文；繁中模板保留為 `templates/zh-TW/`，
現有繁中 docs 移到 `docs/zh-TW/`。前提是把 OS-2 的中文字面值抽成 locale-agnostic 的 schema（見 D11）。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 繁中優先、README 雙語 | 成本最低，但受眾限中文圈，且 OS-2 的靜默失效風險對任何嘗試翻譯的人都還在 |
| 機器讀的狀態全部搬 `state.json`、markdown 只給人讀 | 最強健，但損失「人可以直接編輯 markdown」這個核心體驗 |

保留意見：`docs/zh-TW/` 的 `progress-rhythm`、`numbering-and-tiers`、`decision-anchors`、
`strict-commit-pipeline` 四份是這個工具最有價值的部分，英文化不等於丟棄它們。

### D9 — 整合載體：Claude Code + Cursor 雙 adapter

**選定。** 改判前一份檢視的 `D1` 範圍。SDD 的受眾有很大一塊在 Cursor，
而 Cursor 的 `agent_message` 欄位正好是 `P1`（warn 對 agent 隱形）的解法。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 只做 Claude Code plugin 化（原 D1-A） | 曝光面過窄，且錯過 Cursor 的 `agent_message` / `ask` / `failClosed` 三個能力 |
| 抽 core/adapter 分層後只出 CLI，adapter 交給社群 | 社群不會替一個沒人用的工具寫 adapter，順序反了 |

### D10 — `P0-A` 的 enforcement 上限：TTY gate + hook 攔 `approve` 雙層

**選定。** 核准寫入要求 TTY 且要求逐字打出指紋；hook 額外阻擋 agent 發起的
`devplan approve` 與對 `.devplan/approvals/**` 的寫入。README 認定其強度為
**「阻止意外與順手，不阻止刻意繞過」**。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 只做 TTY gate，不攔 `approve` | agent 跟著文件自己跑 `approve` 會因無 TTY 而失敗，但沒有主動阻擋，也沒有訊息告訴它為什麼 |
| `devplan approve` 只寫 pending request，另一個常駐程序 `devplan watch` 在使用者自己的終端按鍵確認 | 強度最高，但多一個常駐程序的 UX 成本，對一個要推廣的工具是負擔 |
| 核准寫成 git commit + pre-commit hook 驗簽 | 審計軌跡最好，但 D12 的 split 策略已經讓核准進版控，git 歷史本身就是軌跡，額外的驗簽機制邊際效益低 |

**誠實邊界（必須寫進 README）：** HMAC key 放在 `~/.devplan/approval.key`，agent 用 Bash 讀得到。
所以 MAC 不是密碼學保證，而是**篡改偵測** —— 手改 `approvals.json` 會讓 MAC 失效、Gate 隨之失效。
本地工具在這個威脅模型下沒有更強的解，不要把 README 寫成比這更強。

### D11 — Schema 抽象：HTML comment anchor

**選定。** 模板每張機器要讀的表與 section 前面加 anchor，parser 只認 anchor id，不看 prose。

```markdown
<!-- devplan:table id="spec.qa" cols="id,status,question,answer,answered_at" -->
| # | 狀態 | 問題 | 回答 | 回答時間 |
| --- | --- | --- | --- | --- |
```

新增一種語言從此是**零 code 變更**，且徹底消滅「改標題 → 靜默失效」這一整類 bug。

| 被否決的方案 | 否決理由 |
| --- | --- |
| 每份檔案用 YAML frontmatter 宣告 section／table 對應表 | anchor 集中一處好維護，但標題改名時對應表會脫鉤，原問題只是換了位置 |
| 維持 heading regex，抽成 `lib/core/locales/{en,zh-TW}.js` | 改動最小，但每新增一種語言就要動 code，且靜默失效風險完整保留 |
| 機器狀態搬 `state.json`、markdown 只給人讀 | 同 D8 的否決理由 |

**副作用（正面）：** `schema-lint.js` 存在的主要理由大半自動成立，它退化成一層薄薄的
「anchor 存在且 `cols` 涵蓋必要欄位」檢查。

### D12 — `.devplan/` 的版控策略：分兩層

**選定。**

- **committed**：`config.json`、`items/**`（spec / plan / tasks / verify / notes）、
  `approvals/**`、`refs/codebase-gotchas.md`、`refs/codebase-profile.json`
- **gitignored**：`.devplan/local/**`（evidence、截圖、`.hook-log`、`.pipeline-hook-log`、生成的 HTML）

| 被否決的方案 | 否決理由 |
| --- | --- |
| 全部 commit | 核准有完整 git 審計軌跡，但使用者 repo 會多出截圖與生成物 |
| 全部 ignore | 侵入性最低，但回到「團隊不共用、無審計軌跡」的原問題 |
| `devplan init` 問答讓使用者選 | 彈性最高，但文件與支援成本加倍，且兩條路徑都要測 |

## 6. 架構檢查：`privacy-boundary` 這個概念會消失

D6 之後，`codebase-gotchas.md` 與 `codebase-profile.json` 住在**使用者自己的 repo** 裡。
它們不再是「會洩進公開工具 repo 的私有資料」，而是「這個 repo 的知識，本來就該進版控」（D12）。

連帶影響：

| 項目 | 處理 |
| --- | --- |
| `docs/privacy-boundary.md` | 整份刪除。它描述的 public tree ↔ local state 邊界在 D6 之後不存在 |
| `docs/local-migration.md` | 整份刪除。外部使用者沒有 legacy `.devplan-v2` |
| `devplan privacy-check` | 從使用者 CLI 表面移除，改為維護者的 release check（CI job） |
| `scripts/privacy-check.js` | 現有「掃 tracked `state/`」的邏輯作廢。可另外重新定義一個版本：commit `.devplan/` 前掃 spec 有沒有貼到 credential |
| `examples/ignored-files*`、`devplan.local.example.json` | 刪除。它們是為了示範 ignored 檔案長相而存在 |

也就是說這波改動**淨刪碼**，不是淨加碼。

## 7. 目標結構

```
<user-repo>/
  .devplan/
    config.json              # committed：mode、locale、tier 觸發規則
    items/
      <release>/<item>/
        00-spec.md  01-plan.md  02-tasks.md  03-verify.md  notes.md
    approvals/
      <item>.json            # committed：gate / fingerprint / mac
    refs/
      codebase-gotchas.md    # committed
      codebase-profile.json  # committed
    local/                   # gitignored
      evidence/  .hook-log  .pipeline-hook-log  *.html
  .claude/settings.json      # devplan install --host claude
  .cursor/hooks.json         # devplan install --host cursor

~/.devplan/approval.key      # 0600，devplan init 時生成
```

`--repo <id>` 參數從所有命令消失，只留 `--item`。

## 8. 執行計畫

分八階段。**每階段結束時工具都必須是可用的**，且每階段都能獨立 review。

### S0 — 先上鎖：CI + Gate contract tests

排在所有改動之前。後面七個階段每一個都會動 `gate-guard` / `coverage-lint` / `fingerprint`，
沒有 golden fixture 就是盲改。對應前一份檢視的 `P7`。

- 建 `tests/fixtures/`：每個 Gate 各一組 pass / fail 案例 —— orphan AC、殘留 `[C]`、
  open 問答、指紋過期、Tier L 缺獨立審查列、`NOT-PROVEN`、敘述性證據。
- 建 `tests/gates.test.js`：斷言 exit code 與關鍵訊息，**針對現有行為**，不是針對未來行為。
- 前一份檢視列的每一個已知 bypass 都補一個 fixture，先標 `TODO: currently passes (P0-B.x)`，
  S4 修完才翻成正式斷言。
- `.github/workflows/ci.yml`：Node 18／20／22 × ubuntu／macos／windows。
  Windows 很可能會抓到路徑處理的 bug。

### S1 — Schema anchors（D11）

- `scripts/lib/md.js` 加 `findTableById(content, id)` / `sectionById(content, id)`，
  回傳以穩定 id 為 key 的 rows。從所有 caller 移除
  `extractSection(content, /regex/)` 與 `findTableByHeader(text, '服務 AC')`。
- `scripts/schema-lint.js` 的 `SCHEMA` 從中文字面值改成
  `{ table: 'spec.qa', requiredCols: ['id', 'status', 'question'] }`。
- 依 OS-2 的表逐一改：`fingerprint.js`、`coverage-lint.js`、`gate-guard.js`、
  `verify-evidence-lint.js`、`archive.js`、`snapshot.js`、`project-detect.js`、`lib/hook.js`。
- S0 的 fixture 補上 anchor，測試必須全綠。

### S2 — Layout 遷移（D6、D12）

- `lib/config.js` 的 TOOL_ROOT-relative `repoRoot` 整套拆掉；改成從 cwd 往上找 `.devplan/`。
- **刪除**：`register`、`import-state`、`lib/migration.js`、`repoIdForRoot`、`validateRepoId`、
  中央 `devplan.local.json`、`devplan.local.example.json`、`examples/`。
- `bin/devplan.js:122` 的 ≥2 repo 檢查刪除；`doctor` 改為檢查 `.devplan/` 結構、
  `local/` 是否被 ignore、Node 版本。
- `devplan init` 在目標 repo 建結構、寫 `config.json`、
  把 `.devplan/local/` append 進該 repo 的 `.gitignore`、生成 `~/.devplan/approval.key`。
- `lib/resolver.js` 的 `validateItem` path traversal 防護**保留**，那段是對的。
- `package.json`：移除 `"private": true`、加 `files`、`engines` 改 `>=18`
  （順手解掉 `fs.cpSync` 需 16.7 的問題）。
- 執行第 6 節的刪除清單。

### S3 — `P0-A`：核准離開 agent 可寫範圍（D10）

**唯一寫入者 `devplan approve --item <key> --gate G1|G2|G3`：**

- 拒絕非 TTY：`if (!process.stdin.isTTY || !process.stdout.isTTY)` → exit 3。
- 要求使用者逐字打出當前 8-hex 指紋才寫入，`yes |` 之類的盲確認無效。
- 寫 `.devplan/approvals/<item>.json`：
  `{ gate, fingerprint, approvedAt, approvedBy, nonce, mac }`，
  `mac = HMAC-SHA256(key, item + gate + fingerprint + nonce)`。
- **`notes.md` 的「Gate 狀態」與「核准指紋」兩欄從模板移除。** 它們現在是 `approvals/` 的唯讀投影，
  由 `devplan snapshot` 顯示。agent 編輯 `notes.md` 再也影響不到核准。
  `lib/hook.js:42-48` 的 `gateStatus()` 隨之刪除。

**Hook 側契約（S5 實作）：** deny 任何寫入 `.devplan/approvals/**` 或 `~/.devplan/approval.key`
的工具呼叫；deny 指令匹配 `devplan\s+approve` 或 `bin/devplan(\.js)?\s+approve` 的 shell。

### S4 — `P0-B`：fail-open 全部翻成 fail-closed

| 項目 | 現況 | 改法 |
| --- | --- | --- |
| 指紋豁免可自行觸發（`P0-B.1`） | `gate-guard.js` 認「不影響核准」 | 整段刪除。S3 之後核准直接綁指紋，豁免路徑沒有存在理由 |
| G1 只在 branch 選中時檢查 | `lib/hook.js:85` | item 可解析就檢查（per-repo 之後一定解析得到） |
| catch-all fail-open | `lib/hook.js:68`、`:97`、`:126` | 改 deny + 寫 `.devplan/local/.hook-log` |
| guard exit 3 當通過 | `lib/hook.js:92` 用 regex 解 stdout | guard 改成可 `require` 的函式回結構化結果，exit 3 → deny |
| `archive` 不驗 G3 | `scripts/archive.js` | 加 G3 有效核准檢查 |
| branch 子字串誤匹配 | `scripts/lib/project-detect.js:100`、`lib/hook.js:55` | 改邊界匹配，與同檔案第 30 行的 `matchesDeclaredPath` 一致 |
| `node` 找不到 | `scripts/check.js:46`、`:60` | 改 `process.execPath` |
| depth ≤3 靜默失效 | `scripts/lib/project-detect.js:67` | 放寬 + 超限時明確警告 |

同時：併掉重複的 `selectProject`（`lib/hook.js:50-63` 與 `project-detect.js:93-110`），
共用碼搬 `lib/core/`，解掉 `lib/` → `scripts/lib/` 的反向依賴。
checker 改成可 `require` 的函式時，前一份檢視第 1 節列的
「4 個 process、`schema-lint` 跑 3 次」一併解決，`render-html` 改成 opt-in `--html`。

S0 標記的 `TODO: currently passes` 測試在此階段全部翻成正式斷言。

### S5 — Core / adapter 分層 + Cursor adapter（D9）

`lib/core/hook.js` 改回傳中性結果，不再自己決定 exit code：

```js
{ verdict: 'allow' | 'deny' | 'ask', userMessage, agentMessage, updatedInput }
```

- `integrations/claude-code/`：序列化成 `hookSpecificOutput.permissionDecision`。
  比現在的 stderr + exit 2 好，`permissionDecisionReason` 至少會進 UI。
- `integrations/cursor/`：產 `.cursor/hooks.json`。
  `preToolUse` matcher `Write|Delete`；
  `beforeShellExecution` matcher `git\s+(commit|push|merge)|gh\s+pr|devplan\s+approve`；
  兩者 `failClosed: true`。輸出 `{ permission: 'deny', user_message, agent_message }`
  + **exit 0**（用 exit 2 會導致 JSON 不被採用）。
- `parsePayload` 同時吃 `payload.command`（Cursor `beforeShellExecution`）
  與 `payload.tool_input.command`（Claude `Bash`、Cursor `preToolUse`）；
  檔案目標 fallback 鏈 `file_path ?? path ?? target_file ?? filePath`。
- **`hookMode: 'warn'` 重新定義，落地前一份檢視的 `D2` 三模式 `audit / confirm / enforce`：**
  Cursor 的 `beforeShellExecution` 有第三態 `ask`（會真的停下來問人），比現在的 warn 有用；
  `preToolUse` 的 `ask` 無效，退回 `allow` + `postToolUse` 的 `additional_context` 把訊息餵回模型。
- `devplan install --host claude|cursor|both`。
- ⚠️ Cursor 的 `Write` / `Delete` 的 `tool_input` 欄位名**無官方文件**。
  本階段第一步先掛純 log hook 抓一輪真實 payload，不要猜。見附錄 A。

### S6 — 英文化 + 模板瘦身（D8 + 原 `D3`，合併執行）

`templates/` 共 18.8k chars，前一份檢視估 40–50% 是說明散文。
**不要先翻譯再刪。**

- prose 抽進 `integrations/*/skills/devplan/SKILL.md`。
  Claude Code 與 Cursor 的 skill 格式相容，同一份可共用。
- 模板只留 anchor + 表格骨架 + 一行提示。
- `templates/en/` 與 `templates/zh-TW/`。S1 之後兩者 anchor id 相同，checker 零變更。
  `config.json` 的 `locale` 決定 `devplan new` 複製哪一份。
- 程式碼註解與 CLI 輸出訊息轉英文。`docs/` 主版本英文，`docs/zh-TW/` 保留現有繁中四份。

### S7 — Packaging 與 OSS 門面

- **命名**：建議 package 名 `sdd-dev`（已確認 npm 可用）、bin 名 `sdd`。
  `devplan` 這個 bin 名如果和 npm 上既有的 `devplan` 套件同時全域安裝會衝突。
  這會一次解掉 OS-4 的三名並存問題。
- README 重寫：前 20 行要能回答「這是什麼／為什麼要用／Gate 是什麼」，
  加 30 秒 quickstart 與一張 asciinema。補上 detail docs 一直引用但不存在的
  〈對 Claude 的規則〉〈失效鏈表〉，或把那些引用改掉。
- 第 3 節「文件承諾但實作不存在」清單逐項處理：實作或從 docs 移除。
  既然要做 Cursor adapter，五個 subagent 定義檔 `.cursor/agents/*.md` 與
  `.claude/agents/*.md` 格式接近，一起產。
- `.gitignore` 補 `.env`、`.env.*`、`node_modules/`。
- `CONTRIBUTING.md`、`CHANGELOG.md`、issue / PR templates、`SECURITY.md`、
  ESLint + Prettier + EditorConfig。
- LICENSE holder 考慮從 handle 換成本名或組織名。法律上 handle 也有效，
  但貢獻者歸屬會比較清楚。

## 9. 刻意延後的項目

| 項目 | 理由 |
| --- | --- |
| 前一份檢視第 1 節的 30–50ms 效能浪費 | S4 把 checker 改成可 `require` 的函式時順帶解決，不單獨排階段 |
| Plugin 化（原 `D1-A`） | Cursor plugin 要走 marketplace 流程，Claude plugin 也還在演進。先讓 `install --host` 這條路能用比較實在。排在 S7 之後 |
| `devplan add-doc` / `set-tier` / `new --tier` | Tier 生命週期是獨立的功能題，不是開源阻礙。S7 先從 docs 移除承諾 |
| 多語言擴充（日文、簡中…） | D11 之後是零 code 變更，社群可自行 PR locale pack |

## 10. 驗收條件

延續前一份檢視的三個 milestone，補上開源專屬的：

| # | 條件 | 對應階段 |
| --- | --- | --- |
| 1 | 所有已知 bypass 都有 fixture，且從「通過」翻成「被擋」 | S0 → S4 |
| 2 | 核准只能經 `devplan approve` 寫入；手改 `approvals.json` 會讓 Gate 失效 | S3 |
| 3 | hook 結果可觀測 —— 任何 deny 與任何 fail-closed 都寫進 `.devplan/local/.hook-log` | S4 |
| 4 | `npx sdd-dev init` 在一個全新的單一 repo 上可完整跑完 G1 → G3 → archive | S2、S7 |
| 5 | 把模板表頭全部翻成英文後，所有 Gate 測試仍然全綠 | S1、S6 |
| 6 | CI 在 Node 18／20／22 × 三個 OS 上綠 | S0 |
| 7 | README 宣稱的強度與 D10 的誠實邊界一致，無超賣 | S7 |

## 11. 未解項目

1. **Package 與 bin 命名**：`sdd-dev` + bin `sdd` 是建議，未拍板。
2. **Cursor 的 `Write` / `Delete` payload 欄位名無官方文件**，S5 需先實測。
3. **LICENSE holder** 是否從 `iamvince24` 換成本名或組織名。
4. **`privacy-check` 是否保留一個重新定義的使用者版本**（commit `.devplan/` 前掃 credential），
   或純粹降為維護者 CI job。

---

## 附錄 A：Cursor hooks 關鍵事實

影響 S5 設計的部分，其餘見 Cursor 官方文件 `cursor.com/docs/hooks`。

| 項目 | 事實 |
| --- | --- |
| 阻擋主通道 | stdout JSON `{ permission: 'deny', user_message, agent_message }` + **exit 0**。exit 2 也會擋（Claude Code 相容），但沒有文件保證 stderr 會餵給模型 |
| 餵回模型的欄位 | `agent_message`。這是 `P1`（warn 對 agent 隱形）的直接解法 |
| 走 Claude 格式時 | `permissionDecisionReason` 映射到 `user_message`，**不是** `agent_message` —— 拿不到專門餵模型的通道 |
| 檔案寫入前 | **沒有** `beforeFileEdit`。`afterFileEdit` 是事後、不能擋。要在寫入前擋路徑必須用 `preToolUse` + `matcher: "Write"` |
| shell 執行前 | 有專屬 `beforeShellExecution`，payload 的指令在**頂層 `command`**，不是 `tool_input.command` |
| fail-closed | `failClosed: true` 讓 crash／timeout／非零 exit／無輸出改成阻擋。安全型 hook 必開 |
| 第三態 | `ask` 在 `beforeShellExecution` / `beforeMCPExecution` 有效；`preToolUse` 收但不強制執行 |
| 環境變數 | `CURSOR_PROJECT_DIR`，且 `CLAUDE_PROJECT_DIR` 是保證存在的相容 alias |
| Claude 相容層 | Cursor 可直接讀 `.claude/settings.json` 的 hooks（需開設定），但只支援 8 個事件、**沒有** `beforeShellExecution`、拿不到 `agent_message` |
| tool 名稱映射 | `Bash`→`Shell`、`Edit`→`Write`。`NotebookEdit` 無對應 —— 影響 `integrations/claude-code/settings.js:10` 的 `GATE_MATCHER` |

**結論（S5 的路線選擇）：** 產原生 `.cursor/hooks.json`，不靠 Claude 相容層。
理由是本工具的核心價值（擋下之後把原因餵回模型，讓 agent 自己去補文件）完全依賴 `agent_message`，
走相容層等於把 self-correct 能力砍掉。

## 附錄 B：本次檢視的證據

| 檢查 | 指令 | 結果 |
| --- | --- | --- |
| 測試 | `npm test` | 10 passed |
| 健檢 | `node bin/devplan.js doctor` | exit 1，`fewer than two repositories are registered` |
| 隱私 | `npm run privacy-check` | pass，51 個檔案，無發現 |
| Node | `node -v` | v20.20.0 |
| npm 名稱 | `npm view devplan version` | 1.0.1（已被佔用） |
| npm 名稱 | `npm view sdd-dev version` | 404（可用） |
| 中文耦合 | ripgrep 掃 `scripts/` 內字串常數與 regex 字面值中的漢字 | 判定層 13 支檔案、數十處字面值 |

未建立任何 fixture，未留下任何檔案。
