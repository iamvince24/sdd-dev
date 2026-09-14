# devplan (local shadow migration)

Public shared tooling for multiple sibling Git repositories. Clone this repository; keep project
specs, internal references, screenshots, evidence, generated HTML, and hook logs in ignored local
storage — they must never be committed.

```bash
node bin/devplan.js init
node bin/devplan.js register ../example-repo --id example-repo
node bin/devplan.js snapshot --repo example-repo --item release/item
node bin/devplan.js check --repo example-repo --item release/item --gate G2
node bin/devplan.js doctor
```

Private data lives below `state/projects/<repo-id>/` and is ignored by Git. `devplan.local.json` maps
stable repository IDs to paths relative to this tool root. See `docs/local-migration.md` for cutover and
rollback rules.

`devplan.local.example.json` and `examples/ignored-files.example.md` provide fictional, safe examples for
every ignored local artifact. Copy them into the corresponding ignored paths only after replacing the
placeholders with local values.

Before staging or committing public tooling changes, run `npm run privacy-check`. Project names, company
identifiers, repository paths, codebase conventions, specs, evidence, and generated artifacts must stay in
ignored local storage. See `docs/privacy-boundary.md`.
