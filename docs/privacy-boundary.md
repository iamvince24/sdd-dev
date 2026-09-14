# Public tool and local project boundary

The Git repository contains only reusable tooling, neutral templates, generic documentation, integrations,
and tests built from fictional examples. Anything learned from a real company, repository, product, ticket,
API, user, or codebase stays local.

## Storage boundary

| Data | Location | Git |
| --- | --- | --- |
| Reusable CLI, generic rules, neutral templates and tests | `bin/`, `lib/`, `scripts/`, `docs/`, `templates/`, `tests/` | public |
| Repository IDs, repository paths, company markers and private email domains | `devplan.local.json` | ignored |
| Specs, plans, tasks, evidence, screenshots, API documents and hook logs | `state/projects/<repo-id>/` | ignored |
| Codebase paths, subsystem detection rules and repository-specific gotchas | `state/projects/<repo-id>/refs/` | ignored |

Do not solve a project-specific need by adding its name, path, source layout, endpoint, screenshot, ticket,
exact UI wording, record count, or business rule to a public template, test fixture, comment, or default.
Extract only the reusable mechanism; keep its data in local state.

## Local codebase profile

Optional path-based Tier hints belong in
`state/projects/<repo-id>/refs/codebase-profile.json`, never in `scripts/coverage-lint.js`:

```json
{
  "tierPathTriggers": [
    {
      "label": "multiple local subsystems",
      "groups": [
        ["^src/presentation/"],
        ["^src/application/", "^src/infrastructure/"]
      ]
    }
  ]
}
```

A rule is triggered when at least one task path matches a regular expression in every group. The example is
fictional; replace it only in the ignored local profile.

## Local privacy markers

Add identifiers that must never enter the public tree to the ignored `devplan.local.json`:

```json
{
  "privacy": {
    "privateMarkers": ["company-name", "internal-repository-prefix", "private-product-name"],
    "privateEmailDomains": ["company.example"]
  }
}
```

Repository IDs and configured repository directory names are included automatically as private markers.
The privacy check reports locations but does not print the configured marker value.

## Before the first commit and every release

1. Run `npm run privacy-check` before staging.
2. Stage only the intended public files, then inspect `git diff --cached --stat` and `git diff --cached`.
3. Run `npm run privacy-check` again; forced-added ignored files are detected once tracked.
4. Confirm `git config user.email` is a deliberately public identity and does not match a configured private domain.
5. Run the test suite. Do not commit or publish while any privacy check is failing.

The scanner is a guardrail, not permission to skip review. Unknown company vocabulary cannot be inferred
automatically, so each installation must maintain its local markers.
