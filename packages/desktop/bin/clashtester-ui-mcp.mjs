#!/usr/bin/env node
// clash-tester-ui — stdio bridge to the Clash Tester desktop app's MCP
// server (docs/MCP.md#desktop-live-ui--clash-tester-ui). This is what Claude Desktop / Cowork /
// Claude Code spawn; they only load stdio servers.
//
// Adapted from Sprout · Fragments (`bin/mv-mcp.mjs`), Copyright
// 2025-2026 3DBYGGERI DANMARK ApS, licensed under the Apache License,
// Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0
// Differences: Streamable HTTP upstream, no auto-launch yet (comes with
// packaged installers), and the bridge stays up when the app is not running:
// it lists the tools from `ui-tools.json` and answers every call with a
// clear "start the app" error, so the agent can tell the user.
//
// Per call it opens a short-lived client to http://127.0.0.1:<port>/mcp,
// so restarting the app between calls just works.
//
// stdout is the JSON-RPC stream — log to stderr only.
//
//   { "mcpServers": { "clash-tester-ui": {
//       "command": "/absolute/path/to/node",
//       "args": ["/absolute/path/to/packages/desktop/bin/clashtester-ui-mcp.mjs"] } } }

import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_TOOLS = JSON.parse(
  readFileSync(path.join(HERE, "..", "src", "shared", "mcp", "ui-tools.json"), "utf-8"),
);

const PORT = Number(process.env.CLASHTESTER_UI_PORT ?? 7712);
const HOST = "127.0.0.1";
const MCP_URL = new URL(`http://${HOST}:${PORT}/mcp`);
const HEALTH_TIMEOUT_MS = 800;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

const NOT_RUNNING =
  "Clash Tester desktop isn't running (nothing answers on " +
  `${HOST}:${PORT}). Start it, then retry. ` +
  "For work without the app, use the clash-tester tools instead.";

const log = (...args) => console.error("[clash-tester-ui]", ...args);

/** True when the desktop app's MCP server answers /health. */
function isAppRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Run `fn` with a client connected to the app; always closes it. */
async function withUpstream(fn) {
  const client = new Client({ name: "clash-tester-ui-bridge", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(MCP_URL));
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const staticTools = UI_TOOLS.tools.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

const server = new Server(
  { name: "clash-tester-ui", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: UI_TOOLS.instructions },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!(await isAppRunning())) return { tools: staticTools };
  try {
    return await withUpstream((c) => c.listTools());
  } catch (err) {
    log("tools/list upstream failed, using the static list:", err?.message ?? err);
    return { tools: staticTools };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!(await isAppRunning())) {
    return { content: [{ type: "text", text: NOT_RUNNING }], isError: true };
  }
  const timeout =
    UI_TOOLS.tools.find((t) => t.name === req.params.name)?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  try {
    return await withUpstream((c) =>
      c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }, undefined, {
        timeout,
      }),
    );
  } catch (err) {
    return {
      content: [{ type: "text", text: `Clash Tester desktop didn't answer: ${err?.message ?? err}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
log(`bridge up — forwarding to ${MCP_URL}`);
