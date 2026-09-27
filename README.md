# sdd-dev

給 coding agent 用的 spec-driven development 流程工具。需求、限制與驗收條件由人確認；實作方法由 agent 在約束內決定；完成與否以可檢查的證據判定。

流程規格見 [`docs/SDD規劃.md`](docs/SDD規劃.md)，開發計劃與決策見 [`docs/開發計劃.md`](docs/開發計劃.md)。

## 命令

`sdd` 不帶命令會印出同一份清單並以 exit 3 結束。exit 0 是通過，1 是工作受阻，3 是用法錯誤。

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
sdd run start --workspace <id> (--source <path> | --source-stdin) --route <route> [--platform <claude-code|cursor|codex>] [--fast-lane] [--cross-check] [--no-delegation] [--plan-only] [--repo <path>]
sdd run baseline [--run <id>] [--repo <path>]
sdd run resume <run_id> [--repo <path>]
sdd run export <run_id> --out <path> [--repo <path>]
sdd run done [--run <id>] [--repo <path>]
sdd run stop --reason <text> [--run <id>] [--repo <path>]
sdd run route [--route <route>] --reason <text> --by <user|auto> [--risk <feature>] [--fast-lane true|false] [--cross-check true|false] [--no-delegation true|false] [--plan-only true|false] [--run <id>] [--repo <path>]
sdd route suggest --risk <feature> [--run <id>] [--repo <path>]
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
sdd spec write (--file <path> | stdin) [--run <id>] [--repo <path>]
sdd spec approve [--carry-from <revision>] [--changed <requirement,design,risk>] [--run <id>] [--repo <path>]
sdd plan write (--file <path> | stdin) [--run <id>] [--repo <path>]
sdd plan approve [--auto-commit] [--carry-from <revision>] [--run <id>] [--repo <path>]
sdd plan revise [--run <id>] [--repo <path>]
sdd approval revoke --artifact <spec|plan> --reason <text> [--run <id>] [--repo <path>]
sdd check [--stage spec|plan|dev] [--run <id>] [--repo <path>]
sdd review write --kind <plan|result> --verdict <READY|REVISE|BLOCKED> --reviewer-kind <human|agent> [--independent] [--context-id <id>] [--revision <n>] [--file <findings>] [--run <id>] [--repo <path>]
sdd review carry --kind <plan|result> --from <revision> [--run <id>] [--repo <path>]
sdd commit --task <T-n> [--run <id>] [--repo <path>]
sdd context --role <role> [--task <T-n>] [--run <id>] [--repo <path>]
sdd hook install [--platform <claude-code|cursor>] [--repo <path>]
sdd hook uninstall [--platform <claude-code|cursor>] [--repo <path>]
sdd instructions render --route direct --platform <claude-code|cursor|codex>
sdd instructions install --route direct --platform <claude-code|cursor|codex> [--repo <path>]
sdd instructions uninstall --route direct --platform <claude-code|cursor|codex> [--repo <path>]
```

會寫檔或刪檔的確認一律用 `--yes`，不帶就只印出清單。`update` 不帶 `--apply` 只顯示差異；`uninstall` 保留 `.sdd-dev/config/` 與 `.sdd-dev/runs/`。

## 平台缺口

每個平台實際擋得住哪些操作，記在 [`docs/platforms.md`](docs/platforms.md)。格子沒實測是缺口：`capability_limits` 裡 `layer` 為 `convention`、`measured` 為 false。實測做不到的同一層，`measured` 為 true。`run start` 沒給 `--platform`、也沒有 `SDD_PLATFORM` 時，平台是 `unknown`，每一格都是缺口。

`policy.json` 的 `required_enforcement` 若列入某個落在 `convention` 的 op，受影響的工作會停在 `blocked`。沒列入的照流程約定繼續，report 仍會寫出缺口。

Claude Code 的 hook 擋 shell 與寫入工具；Cursor 只掛 `beforeShellExecution` 與 `stop`。兩者都用 `sdd hook install`。Codex 不裝 hook，安裝指令時會提示把 `sandbox_mode` 設成 `workspace-write`。這三個平台的路線格（`direct`、`full_pipeline`、`selected_advisors`）要實際走完才算數，不進 `capability_limits`。

## 安裝模式

| 模式 | 工具位置 | 專案資料 |
| --- | --- | --- |
| `repo-local` | 目標 repo 的 `.sdd-dev/tool/` | 目標 repo 的 `.sdd-dev/` |
| `shared-sibling` | 多個 repo 同層的一份 sdd-dev | 各 repo 自己的 `.sdd-dev/` |

`.sdd-dev/` 是否納入目標 repo 的版控，由使用者在初始化時選擇。

## 與舊版 devplan 的關係

舊版 `devplan` 已移除，原始碼保留在 git 歷史（`b00edf7`）。舊版的 `state/projects/<repo-id>/` 與每個 item 的 `00-spec`／`01-plan`／`02-tasks`／`03-verify`／`notes` 四件套，和新版的 `.sdd-dev/runs/<run_id>/` 沒有一對一對應，v1 不提供匯入。

## 開發

需要 Node.js 16 以上與 `git`，沒有 npm 依賴。

```bash
npm test
npm run privacy-check
```

`privacy-check` 掃描 repo 內已追蹤與未忽略的檔案，擋下個人絕對路徑、憑證、NUL byte，以及被追蹤的本機檔（`.env*`、`*.local.json`、`.sdd-dev/runs/`）。要擋特定公司名稱或網域，寫進被忽略的 `sdd-dev.local.json`：

```json
{
  "privacy": {
    "privateMarkers": ["company-name"],
    "privateEmailDomains": ["company.example"]
  }
}
```

Commit 前各跑一次 `privacy-check`：stage 前跑，stage 後再跑一次。

## License

MIT
