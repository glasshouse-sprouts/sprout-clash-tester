// CLI end-to-end tests.
//
// We spawn the *built* `dist/index.js` rather than re-importing the
// command source — that's the closest thing to what a real user does and
// catches issues that purely-imported tests miss (commander wiring,
// process.exit codes, etc.).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "dist", "index.js");
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

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn the CLI and collect stdio. Always resolves (never rejects). */
function runCli(args: string[], env: Record<string, string> = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("clashtester --help", () => {
  it("lists the three commands and exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("validate");
    expect(r.stdout).toContain("run");
  });

  it("shows version with --version", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });
});

describe("clashtester init", () => {
  it("creates a valid .clashproj that survives validate", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-init-"));
    const proj = path.join(work, "test.clashproj");
    const init = await runCli(["init", proj]);
    expect(init.exitCode).toBe(0);
    expect(existsSync(proj)).toBe(true);
    const validate = await runCli(["validate", proj]);
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("OK");
  });

  it("refuses to overwrite without --force", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-init-"));
    const proj = path.join(work, "exists.clashproj");
    await writeFile(proj, "{}");
    const r = await runCli(["init", proj]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("already exists");
  });

  it("overwrites with --force", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-init-"));
    const proj = path.join(work, "exists.clashproj");
    await writeFile(proj, "{}");
    const r = await runCli(["init", "--force", proj]);
    expect(r.exitCode).toBe(0);
  });

  it("--preset wires up the project for that preset", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-init-"));
    const proj = path.join(work, "preset.clashproj");
    const r = await runCli(["init", "--preset", "HVACxSTR", proj]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("HVACxSTR");
    const contents = await readFile(proj, "utf-8");
    const parsed = JSON.parse(contents) as {
      files: { discipline: string }[];
      rules: { preset: string | null }[];
    };
    const disciplines = parsed.files.map((f) => f.discipline).sort();
    expect(disciplines).toEqual(["HVAC", "STR"]);
    expect(parsed.rules[0]?.preset).toBe("HVACxSTR");
  });

  it("--preset with unknown name errors clearly", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-init-"));
    const proj = path.join(work, "bad.clashproj");
    const r = await runCli(["init", "--preset", "NotARealPreset", proj]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("NotARealPreset");
  });
});

describe("clashtester validate", () => {
  it("rejects an invalid .clashproj with actionable errors", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cli-validate-"));
    const proj = path.join(work, "bad.clashproj");
    // Missing required fields, wrong types.
    await writeFile(
      proj,
      JSON.stringify({
        version: 99,
        name: "",
        createdAt: 0,
        files: [],
        rules: "",
        settings: { toleranceMeters: -1, minPenetrationMeters: 0.005 },
      }),
    );
    const r = await runCli(["validate", proj]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Project file is invalid");
    expect(r.stderr).toContain("version must be");
  });
});

describe.skipIf(!ENGINE_AVAILABLE)("clashtester run — tiny-project", () => {
  it("runs end-to-end and writes BCF, JSON, CSV", async () => {
    const sample = path.join(ROOT, "examples", "tiny-project", "sample.clashproj");
    expect(existsSync(sample), `Missing fixture: ${sample}`).toBe(true);
    const outDir = await mkdtemp(path.join(tmpdir(), "cli-run-"));
    const r = await runCli(
      ["run", "--out", outDir, sample],
      { CLASH_BINARY: ENGINE },
    );
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Total clashes");
    expect(r.stdout).toMatch(/Grouped into\s+: \d+ groups?/);
    expect(existsSync(path.join(outDir, "report.bcf"))).toBe(true);
    expect(existsSync(path.join(outDir, "clashes.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "clashes.csv"))).toBe(true);

    // JSON should match what the runner returned.
    const json = JSON.parse(
      await readFile(path.join(outDir, "clashes.json"), "utf-8"),
    ) as { totalClashes: number; groups?: unknown[]; clashes: { number?: number }[] };
    expect(json.totalClashes).toBeGreaterThan(0);
    expect(Array.isArray(json.groups)).toBe(true);
    // Every clash carries its 1-based number, in array order (T2).
    expect(json.clashes.map((c) => c.number)).toEqual(json.clashes.map((_, i) => i + 1));

    // CSV should have a header + at least one data row, numbered 1..N.
    const csv = await readFile(path.join(outDir, "clashes.csv"), "utf-8");
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe(
      "no,rule,fileA,ifcTypeA,guidA,fileB,ifcTypeB,guidB,posX,posY,posZ,mode,depthM,gapM,aabbDx,aabbDy,aabbDz,aabbVolumeM3,aabbMatch,volumeAM3,volumeBM3,centroidDistM,likelyDuplicate,status,distanceKind,typeClassA,predefinedTypeA,typeClassB,predefinedTypeB",
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).map((row) => row.split(",")[0])).toEqual(
      json.clashes.map((_, i) => String(i + 1)),
    );
  });

  it("--bcf-topics group writes one BCF topic per group (SPEC §13c)", async () => {
    const sample = path.join(ROOT, "examples", "tiny-project", "sample.clashproj");
    const outDir = await mkdtemp(path.join(tmpdir(), "cli-run-groups-"));
    const r = await runCli(
      ["run", "--bcf-topics", "group", "--out", outDir, sample],
      { CLASH_BINARY: ENGINE },
    );
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("BCF topics: one per group");

    const json = JSON.parse(await readFile(path.join(outDir, "clashes.json"), "utf-8")) as {
      groups: { title: string }[];
    };
    expect(json.groups.length).toBeGreaterThan(0);
    // The engine stores BCF entries uncompressed, so markup XML is
    // readable straight from the zip bytes: one <Markup> per topic.
    const bcf = (await readFile(path.join(outDir, "report.bcf"))).toString("utf-8");
    expect(bcf.match(/<Markup>/g)?.length).toBe(json.groups.length);
    const titles = [...bcf.matchAll(/<Title>([^<]*)<\/Title>/g)].map((m) => m[1]);
    expect(titles).toEqual(json.groups.map((g, i) => `${i + 1} - ${g.title}`));
  });

  it("skips doors in their own walls by IFC relations; --no-relation-skip reports them (SPEC §13e)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-rel-"));
    const proj = path.join(dir, "fzk.clashproj");
    const fzk = path.join(ROOT, "engine", "tests", "models", "AC20-FZK-Haus.ifc");
    await writeFile(
      proj,
      JSON.stringify({
        version: 1,
        name: "FZK doors",
        createdAt: "2026-10-30T00:00:00Z",
        files: [{ id: "fzk", path: fzk, discipline: "ARCH" }],
        rules: [
          {
            name: "DOORxWALL",
            preset: null,
            a: { fileId: "fzk", selector: "IfcDoor" },
            b: { fileId: "fzk", selector: "IfcWall*" },
          },
        ],
        settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
      }),
    );
    const on = await runCli(["run", "--no-bcf", "--json", "--out", path.join(dir, "on"), proj], { CLASH_BINARY: ENGINE });
    expect(on.exitCode, on.stderr).toBe(0);
    const onJson = JSON.parse(on.stdout) as { totalClashes: number; perRule: { name: string; skippedByRelations?: number }[] };
    expect(onJson.totalClashes).toBe(0);
    expect(onJson.perRule).toEqual([{ name: "DOORxWALL", clashes: 0, skippedByRelations: 5 }]);

    const pretty = await runCli(["run", "--no-bcf", "--out", path.join(dir, "p"), proj], { CLASH_BINARY: ENGINE });
    expect(pretty.stdout).toMatch(/DOORxWALL\s+0\s+\(5 related pair\(s\) skipped\)/);

    const off = await runCli(
      ["run", "--no-bcf", "--json", "--no-relation-skip", "--out", path.join(dir, "off"), proj],
      { CLASH_BINARY: ENGINE },
    );
    const offJson = JSON.parse(off.stdout) as { totalClashes: number };
    expect(offJson.totalClashes).toBe(5);
  });

  it("reports the run's opening cuts; a duct through a wall opening is no clash (SPEC §13f)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-cut-"));
    const proj = path.join(dir, "cut.clashproj");
    const ifc = path.join(ROOT, "engine", "tests", "models", "opening-cut.ifc");
    await writeFile(
      proj,
      JSON.stringify({
        version: 1,
        name: "Opening cut",
        createdAt: "2026-10-31T00:00:00Z",
        files: [{ id: "m", path: ifc, discipline: "ARCH" }],
        rules: [
          {
            name: "DUCTxWALL",
            preset: null,
            a: { fileId: "m", selector: "IfcDuctSegment" },
            b: { fileId: "m", selector: "IfcWall" },
          },
        ],
        settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
      }),
    );
    const r = await runCli(["run", "--no-bcf", "--json", "--out", path.join(dir, "j"), proj], { CLASH_BINARY: ENGINE });
    expect(r.exitCode, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as { totalClashes: number; openingCuts?: unknown };
    expect(json.totalClashes).toBe(1);
    expect(json.openingCuts).toEqual({
      hostsCut: 1,
      openings: 1,
      failed: [],
      notCut: [],
      openMesh: [],
    });

    const pretty = await runCli(["run", "--no-bcf", "--out", path.join(dir, "p"), proj], { CLASH_BINARY: ENGINE });
    expect(pretty.stdout).toContain("opening cuts: 1 hosts cut, 1 openings, 0 failed, 0 not cut");
  });

  it("--narrow-phase ifclite and --compare-narrow-phase (SPEC §13g)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-narrow-"));
    const proj = path.join(dir, "cut.clashproj");
    const ifc = path.join(ROOT, "engine", "tests", "models", "opening-cut.ifc");
    await writeFile(
      proj,
      JSON.stringify({
        version: 1,
        name: "Narrow phase",
        createdAt: "2026-10-31T00:00:00Z",
        files: [{ id: "m", path: ifc, discipline: "ARCH" }],
        rules: [
          {
            name: "DUCTxWALL",
            preset: null,
            a: { fileId: "m", selector: "IfcDuctSegment" },
            b: { fileId: "m", selector: "IfcWall" },
          },
        ],
        settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
      }),
    );
    const r = await runCli(
      ["run", "--no-bcf", "--json", "--narrow-phase", "ifclite", "--out", path.join(dir, "j"), proj],
      { CLASH_BINARY: ENGINE },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as {
      totalClashes: number;
      perRule: { touchCount?: number; unconfirmedCount?: number }[];
      clashes: { status?: string; distanceKind?: string }[];
    };
    expect(json.totalClashes).toBe(1);
    expect(json.perRule[0]).toMatchObject({ touchCount: 0, unconfirmedCount: 0 });
    expect(json.clashes[0]).toMatchObject({ status: "hard", distanceKind: "estimate" });

    const cmp = await runCli(["run", "--compare-narrow-phase", "--json", proj], { CLASH_BINARY: ENGINE });
    expect(cmp.exitCode, cmp.stderr).toBe(0);
    expect(JSON.parse(cmp.stdout).rules).toEqual([
      { rule: "DUCTxWALL", both: 1, onlyParry: 0, onlyIfclite: 0, touch: 0, unconfirmed: 0 },
    ]);
    const pretty = await runCli(["run", "--compare-narrow-phase", proj], { CLASH_BINARY: ENGINE });
    expect(pretty.stdout).toMatch(/DUCTxWALL\s+1\s+0\s+0\s+0\s+0/);

    const bad = await runCli(["run", "--narrow-phase", "fast", proj], { CLASH_BINARY: ENGINE });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/--narrow-phase must be "parry" or "ifclite"/);
  });

  it("rejects an unknown --bcf-topics value", async () => {
    const sample = path.join(ROOT, "examples", "tiny-project", "sample.clashproj");
    const r = await runCli(["run", "--bcf-topics", "groups", sample], { CLASH_BINARY: ENGINE });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/--bcf-topics must be "clash" or "group"/);
  });

  it("--no-bcf writes JSON + CSV but skips BCF", async () => {
    const sample = path.join(ROOT, "examples", "tiny-project", "sample.clashproj");
    const outDir = await mkdtemp(path.join(tmpdir(), "cli-run-"));
    const r = await runCli(
      ["run", "--no-bcf", "--out", outDir, sample],
      { CLASH_BINARY: ENGINE },
    );
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(path.join(outDir, "report.bcf"))).toBe(false);
    expect(existsSync(path.join(outDir, "clashes.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "clashes.csv"))).toBe(true);
  });

  it("--json emits machine-readable RunResult on stdout", async () => {
    const sample = path.join(ROOT, "examples", "tiny-project", "sample.clashproj");
    const outDir = await mkdtemp(path.join(tmpdir(), "cli-run-"));
    const r = await runCli(
      ["run", "--json", "--out", outDir, sample],
      { CLASH_BINARY: ENGINE },
    );
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    // stdout should be valid JSON.
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      totalClashes: number;
      durationMs: number;
      clashes: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.totalClashes).toBeGreaterThan(0);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(parsed.clashes)).toBe(true);
    // Pretty-summary tokens should NOT be in stdout.
    expect(r.stdout).not.toContain("Clash detection — summary");
  });
});

describe.skipIf(ENGINE_AVAILABLE)("clashtester run (engine missing)", () => {
  it("skipped — set CLASH_BINARY or build the engine to run", () => {
    expect(true).toBe(true);
  });
});
