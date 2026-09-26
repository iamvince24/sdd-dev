# sdd-dev

給 coding agent 用的 spec-driven development 流程工具。需求、限制與驗收條件由人確認；實作方法由 agent 在約束內決定；完成與否以可檢查的證據判定。

流程規格見 [`docs/SDD規劃.md`](docs/SDD規劃.md)，開發計劃與決策見 [`docs/開發計劃.md`](docs/開發計劃.md)。

## 狀態

重寫中。目前只有 `sdd privacy-check`；安裝、run、計畫、驗證等命令依開發計劃的 P1～P10 逐步加入。

## 規劃中的安裝模式

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
