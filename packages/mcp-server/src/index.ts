#!/usr/bin/env node
// @clash-tester/mcp-server — MCP front door for Claude / AI agents.
//
// Stdio transport. Tools mirror Clashero (minus the dashboard) and all
// delegate to `@clash-tester/core`. State (the working `.clashproj`) lives
// at `~/.clashtester/state.clashproj` by default; override with the
// `CLASHTESTER_STATE` env var or a `project_path` argument on individual
// tool calls.
//
// See SPEC.md §8 for the toolset.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { getEnginePath, VERSION } from "@clash-tester/core";

import { startupLine } from "./startup.js";
import { defaultStatePath } from "./state.js";
import { buildTools } from "./tools.js";

async function main(): Promise<void> {
  const server = new Server(
    { name: "clash-tester", version: VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      // MCP SDK 1.29 types include async-task fields we don't use; the
      // runtime shape is `{ content, isError }` so we cast.
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      } as never;
    }
    try {
      return (await tool.handler(request.params.arguments)) as never;
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error in ${tool.name}: ${(e as Error).message}` }],
        isError: true,
      } as never;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // One line on stderr (stdout is JSON-RPC). Claude Desktop copies it into
  // ~/Library/Logs/Claude/mcp-server-clash-tester.log, so a misconfigured
  // engine path explains itself there.
  const engine = getEnginePath();
  process.stderr.write(
    startupLine({
      version: VERSION,
      engine,
      engineExists: existsSync(engine),
      statePath: defaultStatePath(),
    }) + "\n",
  );
}

main().catch((e) => {
  process.stderr.write(`MCP server fatal error: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
