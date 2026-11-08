# @clash-tester/cli

The `clashtester` command-line tool.

| Command | What it does |
|---|---|
| `clashtester init <path>` | Write a sample `.clashproj` to edit (`--preset` to pre-fill one). |
| `clashtester validate <project>` | Check a project file without running detection. |
| `clashtester run <project>` | Run clash detection; writes BCF + JSON + CSV to `outputs/` next to the project (`--out` to change). |

`clashtester run --help` lists the options (`--json`, `--bcf-topics`,
`--narrow-phase`, `--no-relation-skip`, `--compare-narrow-phase`, …).

From a clone, after building (see the main README):

```bash
node packages/cli/dist/index.js run examples/tiny-project/sample.clashproj
```
