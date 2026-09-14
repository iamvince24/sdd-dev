# CLI automation

All commands resolve repositories and private state through `devplan.local.json`; callers do not calculate
relative paths to scripts.

```bash
devplan snapshot --repo <repo-id> --item <release/item>
devplan fingerprint --repo <repo-id> --item <release/item>
devplan check --repo <repo-id> --item <release/item> --gate G1
devplan check --repo <repo-id> --item <release/item> --gate G2
devplan check --repo <repo-id> --item <release/item> --gate G3
devplan archive --repo <repo-id> --item <release/item>
devplan privacy-check
devplan doctor
```

Exit codes are `0` for pass, `1` for a workflow blocker, and `3` for invalid usage or structure. Claude Code
uses exit `2` only when an integration hook is configured in blocking mode. The default hook mode is `warn`.

`privacy-check` scans tracked and unignored public candidates. It also reads private markers, repository IDs,
and private author-email domains from ignored local configuration. Run it before staging and again after
staging so a force-added local artifact is detected.
