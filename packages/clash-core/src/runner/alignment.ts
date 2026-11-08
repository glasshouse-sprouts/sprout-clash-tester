// Reading the JSON `clash check-alignment` writes (snake_case) into
// `AlignmentResult`.

import { readFile } from "node:fs/promises";
import type { AlignmentResult, EngineWarning } from "../types.js";

/** Read the engine's alignment output after a successful run. */
export async function readAlignmentOutput(
  outputPath: string,
  exitCode: number,
  stderr: string,
): Promise<AlignmentResult> {
  const raw = await readFile(outputPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    files: {
      path: string;
      origin: [number, number, number];
      effective_origin: [number, number, number];
      cluster: string;
      length_unit: string;
      map_conversion: {
        eastings: number;
        northings: number;
        orthogonal_height: number;
      } | null;
    }[];
    clusters: {
      label: string;
      centre: [number, number, number];
      files: string[];
    }[];
    warnings: EngineWarning[];
  };

  return {
    ok: true,
    exitCode,
    // Map engine snake_case → our camelCase, same pattern as `run`.
    files: parsed.files.map((f) => ({
      path: f.path,
      origin: f.origin,
      effectiveOrigin: f.effective_origin,
      cluster: f.cluster,
      lengthUnit: f.length_unit,
      mapConversion: f.map_conversion
        ? {
            eastings: f.map_conversion.eastings,
            northings: f.map_conversion.northings,
            orthogonalHeight: f.map_conversion.orthogonal_height,
          }
        : null,
    })),
    clusters: parsed.clusters,
    warnings: parsed.warnings,
    stderr,
  };
}
