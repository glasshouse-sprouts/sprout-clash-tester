# MCP servers

Clash Tester has two [MCP](https://modelcontextprotocol.io) servers, so an
AI agent can work with it. Add both to Claude (or another MCP client); the
agent picks the right one from the tool names and descriptions.

| Server | What it acts on | Use when |
|---|---|---|
| `clash-tester` | Its own working project (a `.clashproj` state file), no app needed | Background runs, Claude Code, scripted checks |
| `clash-tester-ui` | The Clash Tester desktop app that is open on screen | "What do I have open?", "run it", "show me clash 3" |

## Claude Desktop / Cowork

1. Build what the servers need (once, and after pulling changes):
   ```bash
   npm run build --workspaces --if-present
   ```
   ```bash
   cd engine && cargo build --release
   ```
2. Print the config block (absolute paths, current `node`):
   ```bash
   npm run mcp:config
   ```
3. Merge the printed `mcpServers` entries into
   `~/Library/Application Support/Claude/claude_desktop_config.json` and
   restart Claude.

Logs: `~/Library/Logs/Claude/mcp-server-clash-tester.log`,
`…/mcp-server-clash-tester-ui.log` and `…/mcp.log`.

## When it doesn't work — top 5 causes

Read the log first (paths above). The headless server writes one line to
stderr on start: `clash-tester MCP <version> ready — engine <path>; state
<path>`; an engine marked MISSING explains failing runs.

1. **`node` not found.** Claude starts servers with a minimal `PATH`, so
   `"command": "node"` fails when Node comes from Homebrew/nvm. Use the
   absolute path — `npm run mcp:config` does.
2. **Path typos.** Paste the paths `npm run mcp:config` prints; don't
   retype them (paths with spaces are easy to get wrong).
3. **Not built / stale build.** `packages/mcp-server/dist` or
   `packages/clash-core/dist` missing or old → rebuild (step 1).
4. **`CLASH_BINARY` points at a missing engine.** The server starts but
   every run fails → `cargo build --release` in `engine/`.
5. **`clash-tester-ui` says the app isn't running.** Start the desktop
   app (`npm run dev` in `packages/desktop`); check
   `curl http://127.0.0.1:7712/health`. Port taken by something else →
   set `CLASHTESTER_UI_PORT` for both the app and the bridge.

**Test without Claude** — MCP Inspector (opens a browser UI that lists
and calls the tools):

```bash
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
```

```bash
npx @modelcontextprotocol/inspector node packages/desktop/bin/clashtester-ui-mcp.mjs
```

## Claude Code

```bash
claude mcp add clash-tester -e CLASH_BINARY="$PWD/engine/target/release/clash" -- node "$PWD/packages/mcp-server/dist/index.js"
```

```bash
claude mcp add clash-tester-ui -- node "$PWD/packages/desktop/bin/clashtester-ui-mcp.mjs"
```

Run both from the repo root.

## Headless — `clash-tester`

`packages/mcp-server`, stdio. Works without the app, on its own project
file: `~/.clashtester/state.clashproj` (override with `CLASHTESTER_STATE`,
or a `project_path` argument per call). Outputs go to `outputs/` next to
that file unless `output_dir` is given.

| Tool | Does |
|---|---|
| `list_models` | Registered IFC files; optionally scan a folder and auto-register what it finds |
| `register_model` | Add an IFC with a discipline tag |
| `remove_model` | Remove a file |
| `list_clash_rules` | The saved rules |
| `save_clash_rules` | Replace the rules (presets and custom rules, incl. `exclude`) |
| `list_presets` | The shipped presets |
| `auto_add_presets` | Add every preset whose two disciplines are both present |
| `run_clash_detection` | Run; write BCF + JSON + CSV; return counts, groups, warnings (`bcf_topics`: clash / group) |
| `get_results` | A run's full JSON: an explicit `json_path`, else this server's last run, else the desktop app's last run (`~/.clashtester/last-desktop-run.json`) |
| `open_in_viewer` | The latest BCF's path, to open in a BIM viewer |

On start it writes one line to stderr (version, engine path and whether it
exists, state file), which ends up in the client's MCP log.

## Desktop (live UI) — `clash-tester-ui`

The desktop app runs an MCP server in its main process on
`http://127.0.0.1:7712/mcp` (Streamable HTTP; override the port with
`CLASHTESTER_UI_PORT`, set for both the app and the bridge). Claude only
loads stdio servers, so it starts the bridge
`packages/desktop/bin/clashtester-ui-mcp.mjs`, which forwards each call.

- **App not running:** the tools are still listed, and every call
  answers "Clash Tester desktop isn't running … Start it, then retry."
  Start it with `npm run dev` in `packages/desktop` (auto-launch will
  come with packaged installers).
- **Health check:** `curl http://127.0.0.1:7712/health` →
  `{ "app": "clash-tester", "version": …, "pid": … }`.
- **Security:** loopback only; requests with another `Host` header or
  any `Origin` header (web pages) are refused. No token (single-user
  desktop).
- **One app at a time:** a second launch focuses the first window.

Tools to see, navigate and run:

| Tool | Does |
|---|---|
| `ui_get_state` | Open project, files, rules, view, run progress, last-run summary, current selection (what the user clicked) |
| `ui_get_results` | Last run, paged: `kind` = clashes / groups / warnings, `offset`, `limit` |
| `ui_show_view` | Files / Rules / Results |
| `ui_select_clash` | Highlight clash `number` (the # column / BCF title prefix) and open its detail |
| `ui_select_group` | Highlight a group (`key`, or `number` = Groups table #) and its clashes |
| `ui_run` | Press Run, wait, return the summary (refuses with the Run button's reason) |
| `ui_list_presets` | Built-in preset rule sets |

Tools to edit, visibly and undoably:

| Tool | Does |
|---|---|
| `ui_add_file` | Add an .ifc by absolute path (discipline guessed unless given); starts a new project if none is open |
| `ui_remove_file` | Remove a file and the custom rules using it |
| `ui_add_preset_rule` | Add a preset rule |
| `ui_auto_add_presets` | Add every preset matching the files' disciplines |
| `ui_add_self_check` | Self check for one file (spaces, zones, openings ignored unless `ignoreSpacesAndOpenings: false`) |
| `ui_add_custom_rule` / `ui_update_custom_rule` | Custom rule: per side `fileId`, `selector`, `mode`, `exclude` |
| `ui_toggle_rule` / `ui_remove_rule` | Enable / disable / remove a rule |
| `ui_set_settings` | `toleranceMeters`, `minPenetrationMeters`, `grouping`, `bcfTopics` |

Every edit shows at once, marks the project unsaved and puts a violet
"AI changed: … — Undo" bar in the app (one step; it disappears once the
user edits further, so Undo never removes their own work). There is no
save tool — the user saves.

The desktop server edits the project through the same functions as the
UI, so an agent's edit behaves exactly like the same click in the app.
