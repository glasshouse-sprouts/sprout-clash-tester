import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTools } from "../tools.js";
import { checkProjectPath, readRunResult } from "./guards.js";

let dir: string;
const RESULT = JSON.stringify({ totalClashes: 1, clashes: [{ number: 1 }] });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mcp-guards-"));
  await writeFile(path.join(dir, "clashes.json"), RESULT);
  await writeFile(path.join(dir, "secret.json"), JSON.stringify({ token: "abc" }));
  await writeFile(path.join(dir, "id_rsa"), "-----BEGIN PRIVATE KEY-----");
});

function tool(name: string) {
  const t = buildTools().find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
}

describe("checkProjectPath", () => {
  it("accepts .clashproj and .json, any case", () => {
    expect(checkProjectPath("/a/p.clashproj")).toBe("/a/p.clashproj");
    expect(checkProjectPath("/a/P.JSON")).toBe("/a/P.JSON");
  });
  it("refuses other files", () => {
    expect(() => checkProjectPath("/home/u/.zshrc")).toThrow(/\.clashproj or \.json/);
    expect(() => checkProjectPath("/a/p.clashproj.sh")).toThrow();
  });
});

describe("readRunResult", () => {
  it("returns a run result", () => {
    expect(readRunResult(path.join(dir, "clashes.json"))).toEqual({ ok: true, text: RESULT });
  });
  it("refuses non-JSON files, other JSON and missing files", () => {
    expect(readRunResult(path.join(dir, "id_rsa"))).toMatchObject({ ok: false });
    const other = readRunResult(path.join(dir, "secret.json"));
    expect(other).toMatchObject({ ok: false });
    expect(JSON.stringify(other)).not.toContain("abc");
    expect(readRunResult(path.join(dir, "missing.json"))).toMatchObject({ ok: false });
  });
});

describe("tools refuse paths they aren't meant for", () => {
  it("get_results does not return an arbitrary file", async () => {
    for (const f of ["id_rsa", "secret.json"]) {
      const r = await tool("get_results").handler({ json_path: path.join(dir, f) });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).not.toMatch(/PRIVATE KEY|abc/);
    }
    const good = await tool("get_results").handler({ json_path: path.join(dir, "clashes.json") });
    expect(good.isError).toBeUndefined();
    expect(good.content[0]!.text).toContain(RESULT);
  });

  it("a project_path with another extension creates no file", async () => {
    const target = path.join(dir, "autostart.plist");
    await expect(tool("list_models").handler({ project_path: target })).rejects.toThrow(
      /\.clashproj or \.json/,
    );
    expect(existsSync(target)).toBe(false);
  });
});
