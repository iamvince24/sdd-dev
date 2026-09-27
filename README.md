# sdd-dev

sdd-dev 是給 coding agent 使用的 spec-driven development（SDD）流程工具。它把需求來源、驗收條件、執行計畫、核准、驗證證據與執行狀態放進同一份可追溯的紀錄；人確認需求、限制與核准，agent 在已確認的範圍內完成工作。

適合用在需要留下決策與驗證紀錄的功能開發、跨模組修改、介面調整或需要多人／多 agent 協作的任務。它不是專案腳手架，也不會自行修改產品程式碼。

流程規格請看 [`docs/SDD規劃.md`](docs/SDD規劃.md)，開發計畫與決策請看 [`docs/開發計劃.md`](docs/開發計劃.md)。

## 你需要準備什麼

- Node.js 16 以上
- Git（目標專案是 Git repo 時需要）
- 一份 sdd-dev 的 checkout

目前套件不發佈到 npm。最穩定的執行方式是直接呼叫 checkout 裡的 `bin/sdd.js`，不依賴 shell 的 `PATH` 或全域安裝。

```bash
git clone https://github.com/iamvince24/sdd-dev.git
cd sdd-dev
node bin/sdd.js
```

不帶命令時，工具會印出所有指令並以 exit code `3` 結束；這可用來確認 checkout 能正常執行。

## 快速開始

以下示範將 sdd-dev 裝進既有 Git 專案，並建立第一個 `direct` run。請把 `TARGET_REPO` 改成你的目標專案絕對路徑。

```bash
export SDD_TOOL="$PWD"
export TARGET_REPO="/absolute/path/to/your-project"

node "$SDD_TOOL/bin/sdd.js" init \
  --repo "$TARGET_REPO" \
  --mode repo-local \
  --tracking ignore \
  --yes
```

這會把工具複製到目標專案的 `.sdd-dev/tool/`，設定與每次執行的產物會放在 `.sdd-dev/config/` 和 `.sdd-dev/runs/`。 `--tracking ignore` 會讓 Git 忽略 `.sdd-dev/`；若要把設定納入版控，改成 `--tracking track`。後續示範會從 repo-local 的工具位置執行：

```bash
function sdd() {
  node "$TARGET_REPO/.sdd-dev/tool/bin/sdd.js" "$@"
}

sdd workspace add \
  --repo "$TARGET_REPO" \
  --id app \
  --path . \
  --stack "Node.js"
```

`workspace add` 會掃描專案可用的驗證指令與常見規範檔。 `--path .` 代表目標 repo 根目錄；monorepo 可改成像 `apps/web` 的相對路徑。

接著準備需求來源並建立 run：

```bash
printf '%s\n' \
  '# 新增設定頁' \
  '' \
  '使用者可以在設定頁變更通知偏好。' \
  > "$TARGET_REPO/spec.md"

sdd run start \
  --repo "$TARGET_REPO" \
  --workspace app \
  --source spec.md \
  --route direct \
  --platform codex
```

指令會印出 `run <id>`。該 run 的 Spec、Plan、審查與驗證證據都在 `.sdd-dev/runs/<id>/`。要將對應路線的指令安裝到 agent 平台，可執行：

```bash
sdd instructions install \
  --repo "$TARGET_REPO" \
  --route direct \
  --platform codex
```

Codex 使用此指令時會提示將 `sandbox_mode` 設成 `workspace-write`。這只允許 workspace 寫入，不代表可阻擋所有破壞性 Git 操作或連網，詳情請看[平台支援與限制](#平台支援與限制)。

## 選擇流程路線

| 路線 | 何時使用 | 重點 |
| --- | --- | --- |
| `direct` | 需求明確、影響局部、容易回復，且有足夠驗證方法 | 用精簡 Spec、Plan 與證據完成工作；預設不要求獨立 Spec 核准。 |
| `full_pipeline` | 涉及重要介面、資料遷移、安全邊界、緊密相依模組，或驗證能力不足 | 需要完整 Spec、獨立計畫審查、使用者核准與結果審查。 |
| `selected_advisors` | 只需要釐清需求、架構或安全問題，尚未授權實作 | 只產生諮詢結論，不允許修改產品程式碼。 |

`ag` 與 `agentflow` 是 `full_pipeline` 的別名，不是額外路線。你可以先取得建議，但建議不會自行變更 run 的路線：

```bash
sdd route suggest --repo "$TARGET_REPO" --run <run_id> --risk feature
```

需要換路線時，由使用者明確決定後執行：

```bash
sdd run route \
  --repo "$TARGET_REPO" \
  --run <run_id> \
  --route full_pipeline \
  --reason "涉及對外 API 變更" \
  --by user
```

## 基本教學

### 使用 `direct`

`direct` 適用於已確認的小範圍工作。建立 run 後，agent 先記錄精簡的 Execution Spec，再記錄任務與驗收對應的 Plan；實作及驗證完成後，為每個驗收條件寫入證據，最後再標記完成。

```bash
sdd spec write --repo "$TARGET_REPO" --run <run_id> --file execution-spec.md
sdd check --repo "$TARGET_REPO" --run <run_id> --stage spec
sdd plan write --repo "$TARGET_REPO" --run <run_id> --file plan.md
sdd verify --repo "$TARGET_REPO" --run <run_id> --ac AC-1
sdd evidence write --repo "$TARGET_REPO" --run <run_id> --ac AC-1 --file evidence.md
sdd run done --repo "$TARGET_REPO" --run <run_id>
```

`direct` 不會因為建立 run 就授權超出使用者要求的修改。若發現需求不清楚、影響範圍變大、涉及安全邊界或無法有效驗證，應停下來請使用者改選路線。

### 使用 `full_pipeline`

`full_pipeline` 把使用者核准與獨立審查放在必要關卡。建立 run 後，順序如下：

1. 寫入並檢查 Execution Spec。
2. 使用者核准目前的 Spec revision。
3. 寫入並檢查 Plan。
4. 由獨立 reviewer 對 Plan 寫入 `READY` 審查結果。
5. 使用者核准目前的 Plan revision。
6. 實作、驗證、記錄證據，再由獨立 reviewer 寫入結果審查。
7. 所有必要驗收與結果審查通過後，執行 `sdd run done`。

使用者核准是使用者自己的操作，agent 不應代為執行 `sdd spec approve`、 `sdd plan approve`、 `sdd approval revoke` 或 `sdd review carry`。 `--plan-only` 會在計畫通過審查後停下，等待使用者核准才進入實作。

### 遇到阻塞或問題

只阻塞受影響的工作，不要把缺少資訊、權限或驗證結果的工作寫成完成：

```bash
sdd block add \
  --repo "$TARGET_REPO" \
  --run <run_id> \
  --id B-1 \
  --affects R-1,AC-1,T-1 \
  --condition "等待 API 權限確認"

sdd block resolve \
  --repo "$TARGET_REPO" \
  --run <run_id> \
  B-1 \
  --evidence docs/api-permission.md
```

## 安裝模式

| 模式 | 工具位置 | 專案資料 | 適用情況 |
| --- | --- | --- | --- |
| `repo-local` | 目標 repo 的 `.sdd-dev/tool/` | 目標 repo 的 `.sdd-dev/` | 要讓每個 repo 自帶一份工具時使用。 |
| `shared-sibling` | 多個 repo 同層的一份 sdd-dev checkout | 各 repo 自己的 `.sdd-dev/` | 多個相鄰 repo 要共用同一份工具時使用。 |

初始化時的 `--tracking track|ignore` 決定 `.sdd-dev/` 是否由目標 repo 的 Git 追蹤。會寫檔或刪檔的確認一律需要 `--yes`；不帶時，工具只印出預計動作。 `update` 不帶 `--apply` 時只顯示差異， `uninstall` 預設保留 `.sdd-dev/config/` 與 `.sdd-dev/runs/`。

## 常用操作

```bash
# 檢查目標 repo 的安裝與設定
sdd doctor --repo "$TARGET_REPO"

# 專案腳本或規範改變後，重新掃描 workspace
sdd workspace refresh --repo "$TARGET_REPO" --id app

# 比對 run 建立時與目前 workspace 的差異
sdd run baseline --repo "$TARGET_REPO" --run <run_id>

# 恢復既有 run，並重新檢查來源、核准與證據是否過期
sdd run resume --repo "$TARGET_REPO" <run_id>

# 匯出一個 run
sdd run export --repo "$TARGET_REPO" <run_id> --out /tmp/<run_id>.tar

# 預覽工具更新；確認後才套用
node "$SDD_TOOL/bin/sdd.js" update --repo "$TARGET_REPO"
node "$SDD_TOOL/bin/sdd.js" update --repo "$TARGET_REPO" --apply

# 在兩種安裝模式間切換
node "$SDD_TOOL/bin/sdd.js" mode switch repo-local --repo "$TARGET_REPO" --yes

# 解除安裝但保留設定與 run；加上 --purge --yes 才刪除整個 .sdd-dev/
sdd uninstall --repo "$TARGET_REPO"
```

repo-local 模式更新或切換工具時，請從較新的 sdd-dev checkout 執行 `node "$SDD_TOOL/bin/sdd.js"`，不要從目標 repo 已複製的舊工具執行。

## 平台支援與限制

平台實際能攔截的操作以 [`docs/platforms.md`](docs/platforms.md) 的實測紀錄為準。沒有實測結果的格子是能力缺口，不應視為支援；文件或功能表上的宣稱也不算實測。

- Claude Code 與 Cursor 可使用 `sdd hook install` 安裝目前支援的 hook。
- Codex 不安裝 hook。 `workspace-write` 會限制某些 Git 寫入，但不會擋住全部破壞性操作，也不會阻擋連網。
- 未傳 `--platform` 且未設定 `SDD_PLATFORM` 時，平台會記為 `unknown`，每一項能力都會視為缺口。
- `policy.json` 的 `required_enforcement` 若要求只有流程約定、沒有實測強制能力的操作，受影響工作會維持 `blocked`。

## 完整命令參考

指令成功時使用 exit code `0`；工作受阻時為 `1`；用法錯誤時為 `3`。 `sdd` 不帶命令也會回傳 `3`。

### 安裝、設定與平台整合

```bash
sdd privacy-check
sdd init --mode repo-local|shared-sibling --tracking track|ignore [--repo <path>] [--yes]
sdd config tracking track|ignore [--repo <path>] [--yes]
sdd doctor [--repo <path>]
sdd update [--repo <path>] [--apply]
sdd mode switch repo-local|shared-sibling [--repo <path>] [--yes]
sdd uninstall [--repo <path>] [--purge [--yes]]
sdd workspace add --id <id> --path <rel> --stack <text> [--repo <path>]
sdd workspace refresh --id <id> [--repo <path>]
sdd hook install [--platform <claude-code|cursor>] [--repo <path>]
sdd hook uninstall [--platform <claude-code|cursor>] [--repo <path>]
sdd instructions render --route direct --platform <claude-code|cursor|codex>
sdd instructions install --route direct --platform <claude-code|cursor|codex> [--repo <path>]
sdd instructions uninstall --route direct --platform <claude-code|cursor|codex> [--repo <path>]
```

### Run 與路線

```bash
sdd run start --workspace <id> (--source <path> | --source-stdin) --route <route> [--platform <claude-code|cursor|codex>] [--fast-lane] [--cross-check] [--no-delegation] [--plan-only] [--repo <path>]
sdd run baseline [--run <id>] [--repo <path>]
sdd run resume <run_id> [--repo <path>]
sdd run export <run_id> --out <path> [--repo <path>]
sdd run done [--run <id>] [--repo <path>]
sdd run stop --reason <text> [--run <id>] [--repo <path>]
sdd run route [--route <route>] --reason <text> --by <user|auto> [--risk <feature>] [--fast-lane true|false] [--cross-check true|false] [--no-delegation true|false] [--plan-only true|false] [--run <id>] [--repo <path>]
sdd route suggest --risk <feature> [--run <id>] [--repo <path>]
```

`--route` 可用 `direct`、 `selected_advisors`、 `full_pipeline`、 `ag` 或 `agentflow`；後兩者會轉成 `full_pipeline`。 `--fast-lane`、 `--cross-check`、 `--no-delegation` 與 `--plan-only` 是修飾詞，不是獨立路線。

### Spec、Plan、核准與審查

```bash
sdd spec write (--file <path> | stdin) [--run <id>] [--repo <path>]
sdd spec approve [--carry-from <revision>] [--changed <requirement,design,risk>] [--run <id>] [--repo <path>]
sdd plan write (--file <path> | stdin) [--run <id>] [--repo <path>]
sdd plan approve [--auto-commit] [--carry-from <revision>] [--run <id>] [--repo <path>]
sdd plan revise [--run <id>] [--repo <path>]
sdd approval revoke --artifact <spec|plan> --reason <text> [--run <id>] [--repo <path>]
sdd check [--stage spec|plan|dev] [--run <id>] [--repo <path>]
sdd review write --kind <plan|result> --verdict <READY|REVISE|BLOCKED> --reviewer-kind <human|agent> [--independent] [--context-id <id>] [--revision <n>] [--file <findings>] [--run <id>] [--repo <path>]
sdd review carry --kind <plan|result> --from <revision> [--run <id>] [--repo <path>]
sdd context --role <role> [--task <T-n>] [--run <id>] [--repo <path>]
```

### 驗證、問題、授權與提交

```bash
sdd block add --id <B-n> --affects <R-n,AC-n,T-n> --condition <text> [--run <id>] [--repo <path>]
sdd block resolve <B-n> --evidence <path|sha> [--run <id>] [--repo <path>]
sdd problem add --impact <text> --handling <text> --reason <text> [--blocks-downstream] [--affects <R-n,AC-n,T-n>] [--run <id>] [--repo <path>]
sdd problem resolve <P-n> --result <text> --evidence <path|sha> [--run <id>] [--repo <path>]
sdd metrics [--run <id>] [--repo <path>]
sdd metrics outcome --kind <rework|reopen|revert> --basis <text> [--run <id>] [--repo <path>]
sdd evidence write --ac <id> [--file <path>] [--run <id>] [--repo <path>]
sdd verify --ac <id> [--run <id>] [--repo <path>]
sdd grant add --op <op> --scope <scope> --source <Q-n> [--run <id>] [--repo <path>]
sdd grant check --op <op> --scope <scope> [--run <id>] [--repo <path>]
sdd commit --task <T-n> [--run <id>] [--repo <path>]
```

## 開發與隱私檢查

專案沒有 npm 依賴；執行測試與隱私檢查：

```bash
npm test
npm run privacy-check
```

`privacy-check` 會掃描 repo 內已追蹤與未忽略的檔案，攔下個人絕對路徑、憑證、NUL byte，以及被追蹤的本機檔（`.env*`、 `*.local.json`、 `.sdd-dev/runs/`）。要加入專案私有標記，請在被忽略的 `sdd-dev.local.json` 設定：

```json
{
  "privacy": {
    "privateMarkers": ["company-name"],
    "privateEmailDomains": ["company.example"]
  }
}
```

建議在 commit 前的 stage 前、stage 後各執行一次 `privacy-check`。

## License

MIT
