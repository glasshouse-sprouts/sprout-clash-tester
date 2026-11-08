// stdio bridge `bin/clashtester-ui-mcp.mjs` end to end
// (docs/MCP.md#desktop-live-ui--clash-tester-ui): spawn it like Claude does and talk MCP over
// stdio, with the desktop server (a) not running and (b) running (real server, fake renderer).

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startUiMcpServer, type UiMcpServer } from "./server";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/clashtester-ui-mcp.mjs");

/** A port nothing listens on (bound then released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function bridgeClient(port: number): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...(process.env as Record<string, string>), CLASHTESTER_UI_PORT: String(port) },
      stderr: "ignore",
    }),
  );
  return client;
}

describe("clashtester-ui-mcp bridge", () => {
  let client: Client | null = null;
  let srv: UiMcpServer | null = null;

  afterEach(async () => {
    await client?.close().catch(() => {});
    await srv?.close();
    client = null;
    srv = null;
  });

  it("app not running: still lists the tools, every call says to start the app", async () => {
    client = await bridgeClient(await freePort());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ui_select_clash");
    expect(tools).toHaveLength(17);
    const r = await client.callTool({ name: "ui_get_state", arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(
      /Clash Tester desktop isn't running .* Start it, then retry/,
    );
  });

  it("app running: proxies tools/list and tool calls", async () => {
    srv = await startUiMcpServer({
      port: await freePort(),
      version: "1.2.3",
      log: () => {},
      callTool: async (name, args) => ({ from: "app", name, args }),
    });
    client = await bridgeClient(srv.port);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ui_get_state", "ui_run"]));
    const r = await client.callTool({ name: "ui_select_group", arguments: { number: 1 } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({
      from: "app",
      name: "ui_select_group",
      args: { number: 1 },
    });
  });
});
