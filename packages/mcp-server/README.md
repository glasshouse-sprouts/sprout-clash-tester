# @clash-tester/mcp-server — `clash-tester`

Headless MCP server (stdio) that lets an AI agent run Clash Tester without
the desktop app. Works on its own working project,
`~/.clashtester/state.clashproj` (override: `CLASHTESTER_STATE`, or a
`project_path` argument per call). For driving the open desktop app use
`clash-tester-ui` instead.

**Setup, logs and troubleshooting:** [`docs/MCP_SETUP.md`](../../docs/MCP_SETUP.md)
— `npm run mcp:config` at the repo root prints the config block.

| Tool | Does |
|---|---|
| `list_models` | Files in the working project |
| `register_model` | Add an IFC (path, name, optional discipline) |
| `remove_model` | Remove a file |
| `list_clash_rules` | Rules in the working project |
| `save_clash_rules` | Replace the rules (presets and custom, incl. `exclude`) |
| `list_presets` | Built-in preset rule sets |
| `auto_add_presets` | Add presets matching the files' disciplines |
| `run_clash_detection` | Run; writes BCF + JSON + CSV (`bcf_topics`: clash / group) |
| `get_results` | A run's full result (this server's or the desktop's last run) |
| `open_in_viewer` | Latest BCF path, to open in Model Viewer or any BIM viewer |

On start it writes one line to stderr — version, engine path (and whether
it exists), state file — which ends up in Claude's MCP log.
