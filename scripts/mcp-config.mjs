#!/usr/bin/env node
// `npm run mcp:config` — print a ready-to-paste `mcpServers` block for
// Claude Desktop / Cowork with both Clash Tester servers:
//   clash-tester     headless stdio server (packages/mcp-server)
//   clash-tester-ui  bridge to the open desktop app (docs/MCP.md#desktop-live-ui--clash-tester-ui)
// Uses absolute paths (Claude starts servers with a minimal PATH, and
// paths may contain spaces) and warns about missing builds.
// Warnings go to stderr so stdout stays pasteable JSON.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const headless = path.join(ROOT, "packages", "mcp-server", "dist", "index.js");
const uiBridge = path.join(ROOT, "packages", "desktop", "bin", "clashtester-ui-mcp.mjs");
const engine = path.join(
  ROOT,
  "engine",
  "target",
  "release",
  process.platform === "win32" ? "clash.exe" : "clash",
);

const warn = (m) => console.error(`! ${m}`);
if (!existsSync(headless)) warn(`${headless} missing — run \`npm run build -w packages/mcp-server\`.`);
if (!existsSync(engine)) warn(`${engine} missing — run \`cargo build --release\` in engine/.`);
if (!existsSync(uiBridge)) warn(`${uiBridge} missing.`);

const config = {
  mcpServers: {
    "clash-tester": {
      command: node,
      args: [headless],
      env: { CLASH_BINARY: engine },
    },
    "clash-tester-ui": {
      command: node,
      args: [uiBridge],
    },
  },
};
console.log(JSON.stringify(config, null, 2));
console.error(
  "\nPaste into ~/Library/Application Support/Claude/claude_desktop_config.json " +
    "(merge with existing mcpServers), then restart Claude. " +
    "clash-tester-ui only works while the desktop app is open (npm run dev in packages/desktop).",
);
