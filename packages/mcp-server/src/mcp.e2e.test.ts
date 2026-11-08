// End-to-end test for the MCP server via stdio.
//
// We spawn the *built* `dist/index.js`, speak JSON-RPC line-delimited
// (newline-delimited messages), and confirm:
//   - tools/list returns the expected tool names
//   - register_model adds an entry that list_models can read back
//   - list_presets surfaces all 7 shipped presets
//   - run_clash_detection on the tiny-project produces results
//
// Each test uses a temp state file via CLASHTESTER_STATE so they don't
// touch the user's real ~/.clashtester.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "dist", "index.js");
const ENGINE = process.env.CLASH_BINARY ?? "/tmp/cargo-target/release/clash";
const ENGINE_AVAILABLE = existsSync(ENGINE);

function workspaceRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "engine", "Cargo.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate workspace root");
}
const ROOT = workspaceRoot();

// ─── Minimal JSON-RPC client over stdio ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private buf = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) break;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const resolve = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    });
    child.stderr.setEncoding("utf-8");
    // child.stderr.on("data", (d) => process.stderr.write(`[mcp stderr] ${d}`));
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    // Send the `notifications/initialized` notification (no id, no response).
    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
    };
    this.child.stdin.write(JSON.stringify(notification) + "\n");
  }

  async send(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const wait = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.child.stdin.write(JSON.stringify(req) + "\n");
    return wait;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    text: string;
    isError: boolean;
  }> {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`MCP error ${r.error.code}: ${r.error.message}`);
    const result = r.result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = result.content.map((c) => c.text).join("\n");
    return { text, isError: result.isError === true };
  }

  close(): void {
    this.child.kill();
  }
}

function spawnServer(env: Record<string, string>): McpClient {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new McpClient(child);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MCP server — tool discovery", () => {
  let client: McpClient;
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "mcp-e2e-"));
    client = spawnServer({
      CLASHTESTER_STATE: path.join(stateDir, "state.clashproj"),
    });
    await client.initialize();
  });
  afterEach(() => client.close());

  it("tools/list returns every expected tool", async () => {
    const r = await client.send("tools/list");
    const tools = (r.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "auto_add_presets",
        "get_results",
        "list_clash_rules",
        "list_models",
        "list_presets",
        "open_in_viewer",
        "register_model",
        "remove_model",
        "run_clash_detection",
        "save_clash_rules",
      ].sort(),
    );
  });
});

describe("MCP server — model registry round trip", () => {
  let client: McpClient;
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "mcp-e2e-"));
    client = spawnServer({
      CLASHTESTER_STATE: path.join(stateDir, "state.clashproj"),
    });
    await client.initialize();
  });
  afterEach(() => client.close());

  it("register_model adds an entry list_models reports", async () => {
    const reg = await client.callTool("register_model", {
      name: "vent",
      path: "/abs/VENT.ifc",
      discipline: "HVAC",
    });
    expect(reg.isError).toBe(false);
    expect(reg.text).toContain("Registered");

    const list = await client.callTool("list_models", {});
    expect(list.isError).toBe(false);
    expect(list.text).toContain("HVAC");
    expect(list.text).toContain("VENT.ifc");
  });

  it("list_presets reports all shipped presets", async () => {
    const r = await client.callTool("list_presets", {});
    expect(r.isError).toBe(false);
    for (const name of [
      // Original seven (kept for backwards compat in CSV / agents)
      "MEPxSTR",
      "HVACxSTR",
      "HVACxARCH",
      "MEPxARCH",
      "HVACxMEP",
      "ELECxMEP",
      "FIRExSTR",
      // Added in this iteration
      "STRxARCH",
      "ELECxSTR",
      "ELECxARCH",
      "FIRExARCH",
      "FIRExMEP",
      "STAIRxSTR",
    ]) {
      expect(r.text).toContain(name);
    }
  });
});

describe.skipIf(!ENGINE_AVAILABLE)("MCP server — full run flow", () => {
  let client: McpClient;
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "mcp-e2e-"));
    client = spawnServer({
      CLASHTESTER_STATE: path.join(stateDir, "state.clashproj"),
      CLASH_BINARY: ENGINE,
    });
    await client.initialize();
  });
  afterEach(() => client.close());

  it("register → save_rules → run_clash_detection happy path", async () => {
    const hvac = path.join(ROOT, "engine", "tests", "models", "Building-Hvac.ifc");
    const str = path.join(ROOT, "engine", "tests", "models", "Building-Structural.ifc");

    await client.callTool("register_model", { name: "hvac", path: hvac, discipline: "HVAC" });
    await client.callTool("register_model", { name: "str", path: str, discipline: "STR" });

    const rules = await client.callTool("save_clash_rules", {
      rules: [
        {
          name: "HVACxSTR",
          preset: null,
          enabled: true,
          a: { fileId: "hvac", selector: "*", mode: "i" },
          b: { fileId: "str", selector: "*", mode: "i" },
        },
      ],
    });
    expect(rules.isError, rules.text).toBe(false);

    const run = await client.callTool("run_clash_detection", {});
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toMatch(/Total clashes: \d+/);
    expect(run.text).toMatch(/Grouped into: \d+ groups?/);

    const last = await client.callTool("get_results", {});
    expect(last.isError).toBe(false);
    expect(last.text).toContain("Total clashes");

    const viewer = await client.callTool("open_in_viewer", {});
    expect(viewer.isError).toBe(false);
    expect(viewer.text).toContain("report.bcf");
  });

  it("run summary shows pairs skipped by IFC relations (SPEC §13e)", async () => {
    const haus = path.join(ROOT, "engine", "tests", "models", "AC20-FZK-Haus.ifc");
    await client.callTool("register_model", { name: "haus", path: haus, discipline: "ARCH" });
    await client.callTool("save_clash_rules", {
      rules: [
        {
          name: "DOORxWALL",
          preset: null,
          a: { fileId: "haus", selector: "IfcDoor" },
          b: { fileId: "haus", selector: "IfcWall*" },
        },
      ],
    });
    const run = await client.callTool("run_clash_detection", {});
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toMatch(/Total clashes: 0/);
    expect(run.text).toContain("DOORxWALL: 0 (5 related pair(s) skipped)");
  });

  it("save_clash_rules accepts a per-side exclude and validates it (T3)", async () => {
    const haus = path.join(ROOT, "engine", "tests", "models", "AC20-FZK-Haus.ifc");
    await client.callTool("register_model", { name: "haus", path: haus, discipline: "ARCH" });

    const exclude = "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase";
    const saved = await client.callTool("save_clash_rules", {
      rules: [
        {
          name: "SELF-haus",
          preset: null,
          a: { fileId: "haus", selector: "*", mode: "i", exclude },
          b: { fileId: "haus", selector: "*", mode: "i", exclude },
        },
      ],
    });
    expect(saved.isError, saved.text).toBe(false);

    const listed = await client.callTool("list_clash_rules", {});
    expect(listed.text).toContain(`haus (*, not ${exclude}) vs haus (*, not ${exclude})`);

    const bad = await client.callTool("save_clash_rules", {
      rules: [
        {
          name: "SELF-haus",
          preset: null,
          a: { fileId: "haus", selector: "*", exclude: "" },
          b: { fileId: "haus", selector: "*" },
        },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/exclude must be a non-empty string/);
  });
});

describe.skipIf(ENGINE_AVAILABLE)("MCP server (engine missing)", () => {
  it("skipped — set CLASH_BINARY or build the engine to run e2e", () => {
    expect(true).toBe(true);
  });
});
