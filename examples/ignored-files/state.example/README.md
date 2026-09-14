# Example local state layout

```text
state/
└── projects/
    └── example-repo/
        ├── active/
        ├── done/
        └── refs/
```

This layout contains no project data. Create the real ignored `state/` with
`node bin/devplan.js init`, then register a repository to create its folders.
