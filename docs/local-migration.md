# Local shadow migration

This tool is a public Git repository. Each clone keeps project content in ignored local storage
(`state/`, `devplan.local.json`); do not commit those artifacts.

1. During shadow migration, keep the repository-local legacy `.devplan-v2` authoritative. After a verified
   cutover, the workspace `devplan-v2/state` becomes authoritative and the legacy directory is rollback-only.
2. Register repositories, then run `devplan import-state --repo <id> --from <old-root>`.
3. Imports are one-way. Each import uses a new staging directory, verifies a SHA-256 manifest, and retains
   the previous shadow state below `state/.previous/`.
4. Compare fingerprints, snapshots, checks, and exit codes before installing hooks.
5. Install with `devplan hook install --repo-root <repo>`. The installer backs up settings and preserves
   unrelated hooks. Use `disable` or `uninstall` to remove only devplan entries.
6. Keep the old state until the migrated real item archives successfully and seven days pass without rollback.
   Deletion always requires a separately verified private backup and explicit approval.
