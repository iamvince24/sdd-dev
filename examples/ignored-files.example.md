# Ignored local-file examples

This directory contains a safe, fictional counterpart for every entry in
`.gitignore`, without including a real project, path, log, generated artifact,
or machine-specific file. Copy an example only into its ignored destination;
do not commit the copied file.

| Ignore rule | Safe example | Intended local destination |
| --- | --- | --- |
| `/state/` | `state.example/README.md` | `state/` |
| `/devplan.local.json` | `../devplan.local.example.json` | `devplan.local.json` |
| `*.local.json` | `settings.local.example.json` | `settings.local.json` |
| `.hook-log` | `.hook-log.example` | `state/projects/<repo-id>/.hook-log` |
| `.pipeline-hook-log` | `.pipeline-hook-log.example` | `state/projects/<repo-id>/.pipeline-hook-log` |
| `*.html` | `generated-report.html.example` | any generated `*.html` report |
| `.DS_Store` | `.DS_Store.example` | Finder-created `.DS_Store` files |

`state.example/README.md` shows the initial state layout. Use
`node bin/devplan.js init` and `node bin/devplan.js register <path> --id
<repo-id>` to create the real local structure.

Finder creates `.DS_Store` as binary, machine-specific metadata. Its text
placeholder only documents the ignored artifact; it is not meant to be copied.
