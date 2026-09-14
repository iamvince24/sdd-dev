# 進度維護節奏與規格偏離

只在需要查細節時載入這份文件；日常規則摘要見 `../README.md`。

## 進度維護節奏

Gate 之間怎麼維護狀態。這是為了**中斷可恢復** —— session 掛掉或 context 被壓縮時，
下一個 session 讀檔案就知道停在哪，不必從 `git diff` 去猜（或跑 `snapshot.js`）。

| 檔案 | 更新時機 | 更新什麼 |
| --- | --- | --- |
| `02-tasks.md` | **開始動一個任務** | 該列狀態 → `wip` |
| `02-tasks.md` | **每做完一個任務** | 該列狀態 → `done`（做不下去用 `blocked` 並在 `notes.md` 說明） |
| `notes.md`「進行中」 | 標 `wip` 的當下 | 一行「做到哪、下一步是什麼」 |
| `notes.md` 問答／審查表 | **當場** | 使用者一回答就填；subagent 一回報就填。這兩項不能等到階段結束 |
| `00-spec.md` 第 9 節 | 使用者回答時 | 狀態改 `answered` + 回答原文；對應 AC 的 `[C]` 改成 `[U]` |
| `notes.md` 其餘 | 每個階段完成 | Gate 狀態表（含核准版本）、已完成／進行中／待辦 |
| `03-verify.md` | G3 階段一次填完 | 每條 AC 的狀態與證據 |

兩個例外要知道：

- **由 subagent 批次完成的任務會一次跳好幾格 `done`。** 狀態欄屬主 session 的整合責任，
  subagent 不擁有 `02-tasks.md`；那幾格是主 session 收到結果、驗過之後一起更新的。
- **`devplan-v2/state/` 不進版控，與 git 是兩套獨立紀錄。** `git diff --staged` 是「程式碼做到哪」，
  `02-tasks.md` 是「任務做到哪」。兩者不一致時**以 git 為準** ——
  檔案可能忘了更新，程式碼不會。

## 規格偏離

實作跟規格不一致的情形一定會發生（規格寫錯、mock 與正文衝突、技術上做不到、
使用者當場改主意）。規則是：

> **任何知情偏離規格，必須登記在 `00-spec.md` 的「規格偏離登記」表，
> 並修正對應的 AC 本文。只寫在 `notes.md` 不算。**

因為下一個 session 讀的是 `00-spec.md`。偏離沒回寫，spec 就開始騙人，
第 1 條原則就破了。`notes.md` 只留「為什麼這樣決定」的過程。

## Commit 與 staging

- **Claude 不執行 `git commit`**，除非使用者明確要求。
- **每完成一個階段，就把該階段的變更 `git add` 進 staged 區**，然後繼續下一個階段。
  這樣 `git diff` 是「還沒做完的」、`git diff --staged` 是「已完成的階段」，隨時分得開，
  歷史上也不會出現半成品 commit。
- 「一個階段」是 `01-plan.md` / `02-tasks.md` 裡一塊能獨立成立的切片
  （例如「先立起回歸保護」、「頁面本體」、「掛上入口」），**通常涵蓋數個任務**，
  不是一個任務一個階段。
- 使用者要 commit 時，粒度對應**需求切片**而非單一任務，
  message 帶需求編號，例如 `feat(ui): add item list (R2, R3)`，
  方便 review 時對回 `00-spec.md`。
- **commit message 不加 `Co-Authored-By` 共同作者行**：
  無論是列 message 草稿，或使用者要求實際執行 `git commit`，都不附共同作者資訊。
