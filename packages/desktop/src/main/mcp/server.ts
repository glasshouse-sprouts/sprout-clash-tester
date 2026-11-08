// Embedded MCP server — "clash-tester-ui" (docs/MCP.md#desktop-live-ui--clash-tester-ui). Runs in
// the Electron main process and lets AI clients see and drive the open app.
//
// Pattern adapted from Model Viewer (`src/main/mcp/server.ts`),
// Copyright 2025-2026 3DBYGGERI DANMARK ApS, licensed under the Apache
// License, Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0
// Differences: Streamable HTTP (stateless) instead of SSE, Host/Origin
// checks, tool list from `ui-tools.json`, and no Electron import here —
// the caller injects `callTool`, so this module is unit-testable.
//
// Endpoints (loopback only):
//   POST /mcp     MCP over Streamable HTTP, one Server per request.
//   GET  /health  { app, version, pid } — the stdio bridge probes this.
//
// Security (single-user desktop; cheap parts from day one): bind
// 127.0.0.1; reject a Host header other than 127.0.0.1:<port> /
// localhost:<port> (DNS rebinding from a web page); reject any request
// carrying an Origin header (browsers send one, MCP clients don't).

import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import uiTools from "../../shared/mcp/ui-tools.json";
import type { UiToolDef } from "../../shared/mcp/protocol";

export const UI_TOOLS = uiTools.tools as UiToolDef[];
export const UI_INSTRUCTIONS: string = uiTools.instructions;

const HOST = "127.0.0.1";

export interface UiMcpServerOptions {
  /** 0 = pick a free port (tests). */
  port: number;
  /** App version, reported by `/health` and the MCP handshake. */
  version: string;
  /**
   * Run one tool. Resolve with the tool's data (string = text as-is,
   * anything else is JSON-encoded); reject with an Error whose message
   * becomes the tool error the agent sees.
   */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Optional logger (main process console by default). */
  log?: (msg: string) => void;
}

export interface UiMcpServer {
  port: number;
  close: () => Promise<void>;
}

/** True when the Host header names this loopback server. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

function newMcpServer(opts: UiMcpServerOptions): Server {
  const server = new Server(
    { name: "clash-tester-ui", version: opts.version },
    { capabilities: { tools: {} }, instructions: UI_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: UI_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!UI_TOOLS.some((t) => t.name === name)) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const data = await opts.callTool(name, (req.params.arguments ?? {}) as Record<string, unknown>);
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });
  return server;
}

/** Start listening. Rejects when the port is taken (EADDRINUSE etc.). */
export function startUiMcpServer(opts: UiMcpServerOptions): Promise<UiMcpServer> {
  const log = opts.log ?? ((m: string) => console.log(`[ui-mcp] ${m}`));
  let port = opts.port;

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, port)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden host");
        return;
      }
      if (req.headers.origin !== undefined) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Browser requests are not allowed");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ app: "clash-tester", version: opts.version, pid: process.pid }));
        return;
      }

      if (url.pathname === "/mcp") {
        // Stateless: a fresh Server + transport per request (the SDK
        // refuses to connect one Server to two transports).
        const server = newMcpServer(opts);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, HOST, () => {
      httpServer.removeListener("error", reject);
      httpServer.on("error", (err) => log(`runtime error: ${err.message}`));
      const address = httpServer.address();
      if (address && typeof address === "object") port = address.port;
      log(`listening on http://${HOST}:${port}/mcp`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => done());
          }),
      });
    });
  });
}
