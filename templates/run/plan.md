---
artifact: plan
run_id: ""
revision: 1
status: draft
change_summary: 初版
based_on:
  artifact: execution-spec
  revision: 1
  content_hash: ""
---

<!-- sec:goals -->

<!-- sec:scope -->

<!-- sec:constraints -->

<!-- sec:decisions -->

<!-- sec:interfaces -->

<!-- sec:paths -->

<!-- sec:dependencies -->

<!-- sec:tasks -->
- id: T-1
  purpose: 本次要做的事
  paths:
  integrator:
  depends:
  acceptance: AC-1
  commit:
  preexisting_overlap:
  reason:
  status: pending

<!-- sec:verification -->
- id: AC-1
  method:

<!-- sec:notes -->
任務路徑與 baseline dirty 相交時，preexisting_overlap 填 separable 或 blocked。
