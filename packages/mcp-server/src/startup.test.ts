import { describe, expect, it } from "vitest";
import { startupLine } from "./startup.js";

describe("startupLine", () => {
  const base = { version: "0.0.1", engine: "/e/clash", engineExists: true, statePath: "/h/.clashtester/state.clashproj" };

  it("names version, engine and state file on one line", () => {
    const line = startupLine(base);
    expect(line).toBe("clash-tester MCP 0.0.1 ready — engine /e/clash; state /h/.clashtester/state.clashproj");
    expect(line).not.toContain("\n");
  });

  it("says so when the engine binary is missing", () => {
    expect(startupLine({ ...base, engineExists: false })).toMatch(/MISSING — runs will fail; set CLASH_BINARY/);
  });
});
