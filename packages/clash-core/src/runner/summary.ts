// Reading the JSON summary `clash detect --summary` writes (snake_case)
// into the runner's camelCase types.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ClashEntry, EngineWarning, OpeningCuts, RuleCount, RunOptions } from "../types.js";

/** What `readSummary` returns: the parts of a `RunResult` from the summary. */
export interface SummaryData {
  totalClashes: number;
  perRule: RuleCount[];
  clashes: ClashEntry[];
  warnings: EngineWarning[];
  openingCuts: OpeningCuts | undefined;
}

/**
 * Parse the summary if it exists. If the engine crashed before writing
 * it, fall back to "no clashes, no rules, surface stderr".
 */
export async function readSummary(
  summaryPath: string,
  narrowPhase: RunOptions["narrowPhase"],
): Promise<SummaryData> {
  let totalClashes = 0;
  let perRule: RuleCount[] = [];
  let clashes: ClashEntry[] = [];
  let warnings: EngineWarning[] = [];
  let openingCuts: OpeningCuts | undefined;
  if (existsSync(summaryPath)) {
    try {
      const raw = await readFile(summaryPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        total_clashes: number;
        per_rule: {
          name: string;
          clashes: number;
          skipped_by_relations?: number;
          touch_count?: number;
          unconfirmed_count?: number;
        }[];
        clashes: {
          rule: string;
          ifc_type_a: string;
          ifc_type_b: string;
          guid_a: string;
          guid_b: string;
          file_a?: string;
          file_b?: string;
          position: [number, number, number];
          mode?: string;
          depth_metres?: number | null;
          gap_metres?: number | null;
          aabb_overlap_extents?: [number, number, number] | null;
          aabb_overlap_volume?: number | null;
          aabb_match?: number | null;
          volume_a?: number | null;
          volume_b?: number | null;
          centroid_distance?: number | null;
          status?: ClashEntry["status"] | null;
          distance_kind?: ClashEntry["distanceKind"] | null;
          type_class_a?: string | null;
          type_class_b?: string | null;
          predefined_type_a?: string | null;
          predefined_type_b?: string | null;
        }[];
        warnings: EngineWarning[];
        bcf_path?: string;
        opening_cuts?: {
          hosts_cut: number;
          openings: number;
          failed: string[];
          not_cut?: string[];
          open_mesh?: string[];
        } | null;
      };
      totalClashes = parsed.total_clashes ?? 0;
      perRule = (parsed.per_rule ?? []).map((r) => ({
        name: r.name,
        clashes: r.clashes,
        ...(typeof r.skipped_by_relations === "number"
          ? { skippedByRelations: r.skipped_by_relations }
          : {}),
        // Only the ifc-lite phase can touch / leave pairs unconfirmed.
        ...(narrowPhase === "ifclite"
          ? { touchCount: r.touch_count ?? 0, unconfirmedCount: r.unconfirmed_count ?? 0 }
          : {}),
      }));
      warnings = parsed.warnings ?? [];
      if (parsed.opening_cuts) {
        openingCuts = {
          hostsCut: parsed.opening_cuts.hosts_cut,
          openings: parsed.opening_cuts.openings,
          failed: parsed.opening_cuts.failed ?? [],
          notCut: parsed.opening_cuts.not_cut ?? [],
          openMesh: parsed.opening_cuts.open_mesh ?? [],
        };
      }
      // Engine uses snake_case; map to our camelCase ClashEntry.
      // Older engine builds may not emit the depth/gap/AABB fields —
      // fall back to defaults so the runner stays backwards compatible.
      // `number` = list position + 1, matching the engine's BCF titles.
      clashes = (parsed.clashes ?? []).map((c, i) => ({
        number: i + 1,
        rule: c.rule,
        ifcTypeA: c.ifc_type_a,
        ifcTypeB: c.ifc_type_b,
        guidA: c.guid_a,
        guidB: c.guid_b,
        fileA: c.file_a ?? "",
        fileB: c.file_b ?? "",
        position: c.position,
        mode: (c.mode as "intersection" | "clearance" | undefined) ?? "",
        depthMetres: c.depth_metres ?? null,
        gapMetres: c.gap_metres ?? null,
        aabbOverlapExtents: c.aabb_overlap_extents ?? null,
        aabbOverlapVolume: c.aabb_overlap_volume ?? null,
        aabbMatch: c.aabb_match ?? null,
        volumeA: c.volume_a ?? null,
        volumeB: c.volume_b ?? null,
        centroidDistanceMetres: c.centroid_distance ?? null,
        ...(c.status ? { status: c.status } : {}),
        ...(c.distance_kind ? { distanceKind: c.distance_kind } : {}),
        ...(c.type_class_a ? { typeClassA: c.type_class_a } : {}),
        ...(c.type_class_b ? { typeClassB: c.type_class_b } : {}),
        ...(c.predefined_type_a ? { predefinedTypeA: c.predefined_type_a } : {}),
        ...(c.predefined_type_b ? { predefinedTypeB: c.predefined_type_b } : {}),
      }));
    } catch (e) {
      // Don't throw — surface as a synthetic warning so the caller knows
      // the summary file existed but couldn't be parsed.
      warnings.push({
        kind: "summary_parse_failed",
        message: `Could not parse engine summary file: ${(e as Error).message}`,
        files: [],
      });
    }
  }
  return { totalClashes, perRule, clashes, warnings, openingCuts };
}
