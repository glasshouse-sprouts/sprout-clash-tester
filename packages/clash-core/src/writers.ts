// Output writers — JSON and CSV side-files written alongside the BCF.
//
// JSON: the full RunResult, pretty-printed. Lossless. Agents and scripts
//   should read this.
// CSV:  one row per clash with the fields most users want in a spreadsheet
//   (rule, IFC types, GUIDs, position). Header row included.

import { writeFile } from "node:fs/promises";

import { isLikelyDuplicate } from "./grouping.js";
import type { ClashEntry, RunResult } from "./types.js";

/** Write the full result as pretty-printed JSON. */
export async function writeResultJson(result: RunResult, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
}

/**
 * Build a CSV string for the result. Columns:
 *   no, rule, fileA, ifcTypeA, guidA, fileB, ifcTypeB, guidB,
 *   posX, posY, posZ,
 *   mode, depthM, gapM, aabbDx, aabbDy, aabbDz, aabbVolumeM3,
 *   aabbMatch, volumeAM3, volumeBM3, centroidDistM, likelyDuplicate,
 *   status, distanceKind, typeClassA, predefinedTypeA, typeClassB,
 *   predefinedTypeB
 *
 * `no` is the clash's 1-based number — the prefix of its BCF topic title
 * (`clash.number`, or row position + 1 for results without it).
 * Position is in metres. `mode` is "intersection" or "clearance".
 * `depthM` is set in intersection mode (approximate, AABB-min-dim proxy).
 * `gapM` is set in clearance mode (real distance). AABB extents and
 * volume are bounding-box overlap (not true geometric volume).
 * `aabbMatch` is bounding-box similarity 0..1 (informational). Volumes
 * and centre distance are what double modelling is decided on;
 * `likelyDuplicate` is "yes" when the clash sits in a `duplicate` group
 * (or, for results without groups, passes `isLikelyDuplicate` with
 * default thresholds) — SPEC §13b.
 *
 * `status` / `distanceKind` come from the ifc-lite narrow phase only
 * (SPEC §13g; empty with parry) and sit last so existing column positions
 * don't move.
 *
 * `typeClassA/B` is the class read off the type object for generic
 * IFC2X3-style occurrences (`ifcTypeA` stays the occurrence class), and
 * `predefinedTypeA/B` the element's PredefinedType — SPEC §6. Appended
 * last for the same reason.
 *
 * Values are quoted with RFC 4180 rules. Missing optional fields
 * become empty cells.
 */
export function csvForResult(result: RunResult): string {
  const header = [
    "no",
    "rule",
    "fileA",
    "ifcTypeA",
    "guidA",
    "fileB",
    "ifcTypeB",
    "guidB",
    "posX",
    "posY",
    "posZ",
    "mode",
    "depthM",
    "gapM",
    "aabbDx",
    "aabbDy",
    "aabbDz",
    "aabbVolumeM3",
    "aabbMatch",
    "volumeAM3",
    "volumeBM3",
    "centroidDistM",
    "likelyDuplicate",
    "status",
    "distanceKind",
    "typeClassA",
    "predefinedTypeA",
    "typeClassB",
    "predefinedTypeB",
  ];
  const rows: string[] = [header.join(",")];
  // Use the run's own grouping (respects project thresholds) when present.
  const dupRows = result.groups
    ? new Set(result.groups.filter((g) => g.kind === "duplicate").flatMap((g) => g.clashIndices))
    : null;
  for (const [i, c] of result.clashes.entries()) {
    const dup = dupRows ? dupRows.has(i) : isLikelyDuplicate(c);
    rows.push(
      [
        String(c.number ?? i + 1),
        csvCell(c.rule),
        csvCell(c.fileA),
        csvCell(c.ifcTypeA),
        csvCell(c.guidA),
        csvCell(c.fileB),
        csvCell(c.ifcTypeB),
        csvCell(c.guidB),
        csvCell(numberToString(c.position[0])),
        csvCell(numberToString(c.position[1])),
        csvCell(numberToString(c.position[2])),
        csvCell(c.mode),
        csvCell(optNumberToString(c.depthMetres)),
        csvCell(optNumberToString(c.gapMetres)),
        csvCell(optNumberToString(c.aabbOverlapExtents?.[0] ?? null)),
        csvCell(optNumberToString(c.aabbOverlapExtents?.[1] ?? null)),
        csvCell(optNumberToString(c.aabbOverlapExtents?.[2] ?? null)),
        csvCell(optNumberToString(c.aabbOverlapVolume)),
        csvCell(optNumberToString(c.aabbMatch ?? null)),
        csvCell(optNumberToString(c.volumeA ?? null)),
        csvCell(optNumberToString(c.volumeB ?? null)),
        csvCell(optNumberToString(c.centroidDistanceMetres ?? null)),
        csvCell(dup ? "yes" : ""),
        csvCell(c.status ?? ""),
        csvCell(c.distanceKind ?? ""),
        csvCell(c.typeClassA ?? ""),
        csvCell(c.predefinedTypeA ?? ""),
        csvCell(c.typeClassB ?? ""),
        csvCell(c.predefinedTypeB ?? ""),
      ].join(","),
    );
  }
  // Trailing newline so cat'ing the file in a terminal looks right.
  return rows.join("\n") + "\n";
}

/** Like `numberToString` but renders `null/undefined` as an empty cell. */
function optNumberToString(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : numberToString(n);
}

/** Convenience wrapper: build CSV then write to disk. */
export async function writeResultCsv(result: RunResult, filePath: string): Promise<void> {
  await writeFile(filePath, csvForResult(result), "utf-8");
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

/**
 * Quote a CSV cell per RFC 4180 — wrap in double quotes if the value
 * contains a comma, newline, or double quote, and double-up any embedded
 * double quotes.
 */
function csvCell(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format a number for CSV output. Avoids JavaScript's default
 * `toString()` behaviour of writing very small/large values in exponential
 * form, which spreadsheets sometimes mis-parse.
 *
 * Six decimal places (≈ µm precision in metres) is plenty for clash
 * positions and keeps the file readable.
 */
function numberToString(n: number): string {
  if (!Number.isFinite(n)) return "";
  // toFixed(6) then strip trailing zeros except the leading one before the
  // decimal point. E.g. 3.140000 → "3.14", 3.000000 → "3".
  return n
    .toFixed(6)
    .replace(/\.?0+$/, "")
    .replace(/^-0$/, "0");
}

// Type re-export so consumers can pull both halves from one place.
export type { ClashEntry };
