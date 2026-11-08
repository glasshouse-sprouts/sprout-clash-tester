// Desktop MCP server (docs/MCP.md#desktop-live-ui--clash-tester-ui) with a fake `callTool` — real
// HTTP on a free port, real MCP client. No Electron.

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { routeUiTool } from "./route";
import { isAllowedHost, startUiMcpServer, UI_TOOLS, type UiMcpServer } from "./server";

/** Raw GET with an explicit Host / Origin, for the security checks. */
function rawGet(port: number, pathName: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, method: "GET", headers, setHost: !("Host" in headers) },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("desktop MCP server", () => {
  let srv: UiMcpServer;
  let client: Client;
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    calls.length = 0;
    srv = await startUiMcpServer({
      port: 0,
      version: "9.9.9",
      log: () => {},
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "ui_select_clash" && args.number === 99) throw new Error("No clash number 99");
        if (name === "ui_list_presets") return "Built-in presets (0):";
        return { echoed: name, args };
      },
    });
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await srv.close();
  });

  it("lists the ui_ tools (phase 1 + 2), each saying it acts on the open app", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      // phase 1
      "ui_get_state",
      "ui_get_results",
      "ui_show_view",
      "ui_select_clash",
      "ui_select_group",
      "ui_run",
      "ui_list_presets",
      // phase 2
      "ui_add_file",
      "ui_remove_file",
      "ui_add_preset_rule",
      "ui_auto_add_presets",
      "ui_add_self_check",
      "ui_add_custom_rule",
      "ui_update_custom_rule",
      "ui_toggle_rule",
      "ui_remove_rule",
      "ui_set_settings",
    ]);
    expect(tools.some((t) => /save/i.test(t.name))).toBe(false); // no silent save
    for (const t of tools) {
      expect(t.description).toMatch(/^Acts on the Clash Tester desktop app that is open on screen/);
    }
    expect(client.getInstructions()).toMatch(/clash-tester-ui when the user talks about what they see/);
  });

  it("routes a call with its arguments and returns JSON text", async () => {
    const r = await client.callTool({ name: "ui_select_clash", arguments: { number: 3 } });
    expect(calls).toEqual([{ name: "ui_select_clash", args: { number: 3 } }]);
    expect(r.isError).toBeFalsy();
    const text = (r.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({ echoed: "ui_select_clash", args: { number: 3 } });
  });

  it("passes plain-text results through as-is", async () => {
    const r = await client.callTool({ name: "ui_list_presets", arguments: {} });
    expect((r.content as { text: string }[])[0]!.text).toBe("Built-in presets (0):");
  });

  it("turns a thrown error into a tool error with the same message", async () => {
    const r = await client.callTool({ name: "ui_select_clash", arguments: { number: 99 } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toBe("No clash number 99");
  });

  it("refuses unknown tools without calling through", async () => {
    const r = await client.callTool({ name: "ui_delete_everything", arguments: {} });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("answers /health with app, version and pid", async () => {
    const r = await rawGet(srv.port, "/health");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ app: "clash-tester", version: "9.9.9", pid: process.pid });
  });

  it("rejects a foreign Host header (DNS rebinding) and browser Origins", async () => {
    expect((await rawGet(srv.port, "/health", { Host: `evil.example:${srv.port}` })).status).toBe(403);
    expect((await rawGet(srv.port, "/health", { Host: "127.0.0.1:1" })).status).toBe(403);
    expect((await rawGet(srv.port, "/health", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await rawGet(srv.port, "/health", { Host: `localhost:${srv.port}` })).status).toBe(200);
  });

  it("404s other paths", async () => {
    expect((await rawGet(srv.port, "/sse")).status).toBe(404);
  });
});

describe("isAllowedHost", () => {
  it("accepts only loopback names with the right port", () => {
    expect(isAllowedHost("127.0.0.1:7712", 7712)).toBe(true);
    expect(isAllowedHost("localhost:7712", 7712)).toBe(true);
    expect(isAllowedHost("127.0.0.1", 7712)).toBe(false);
    expect(isAllowedHost(undefined, 7712)).toBe(false);
    expect(isAllowedHost("192.168.1.5:7712", 7712)).toBe(false);
  });
});

describe("routeUiTool", () => {
  const deps = (hasWindow = true) => {
    const seen: { op: string; timeout: number | undefined }[] = [];
    return {
      seen,
      deps: {
        hasWindow: () => hasWindow,
        presetText: () => "PRESETS",
        callRenderer: async (op: string, _a: Record<string, unknown>, timeout?: number) => {
          seen.push({ op, timeout });
          return "ok";
        },
      },
    };
  };

  it("answers ui_list_presets in main, even without a window", async () => {
    const d = deps(false);
    expect(await routeUiTool("ui_list_presets", {}, d.deps)).toBe("PRESETS");
    expect(d.seen).toEqual([]);
  });

  it("forwards UI ops to the renderer; ui_run gets the long timeout", async () => {
    const d = deps();
    await routeUiTool("ui_get_state", {}, d.deps);
    await routeUiTool("ui_run", {}, d.deps);
    expect(d.seen).toEqual([
      { op: "ui_get_state", timeout: undefined },
      { op: "ui_run", timeout: UI_TOOLS.find((t) => t.name === "ui_run")!.timeoutMs },
    ]);
    expect(d.seen[1]!.timeout).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("explains a closed window instead of hanging", async () => {
    await expect(routeUiTool("ui_get_state", {}, deps(false).deps)).rejects.toThrow(/window is closed/);
  });
});
