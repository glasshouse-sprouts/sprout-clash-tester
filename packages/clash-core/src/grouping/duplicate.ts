// "Possible double modelling" — when two clashing elements are probably
// the same element modelled twice (docs/HOW-IT-WORKS.md#double-modelling).

import type { ClashEntry } from "../types.js";

/**
 * When is a clash "possible double modelling"? All of:
 *  1. same IFC type (IfcWall = IfcWallStandardCase, etc.);
 *  2. mesh centres at most `maxCentroidDistanceMetres` apart;
 *  3. mesh volumes differ by at most `maxVolumeDifference` (relative to
 *     the larger). If BOTH meshes are flat (no volume), their bounding
 *     boxes must match >= 95 % instead. One flat + one solid ⇒ never.
 */
export interface DuplicateOptions {
  /** 0..1. Default 0.05 (5 %). */
  maxVolumeDifference?: number;
  /** Metres, >= 0. Default 0.02 (2 cm). */
  maxCentroidDistanceMetres?: number;
}

export const DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE = 0.05;
export const DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES = 0.02;
/** Box-match fallback used only when both meshes are flat. */
export const FLAT_DUPLICATE_AABB_MATCH = 0.95;

/**
 * IFC type with the `…StandardCase` / `…ElementedCase` suffix removed and
 * upper-cased, so IfcWall and IFCWALLSTANDARDCASE compare equal.
 */
export function normaliseIfcType(t: string): string {
  return t.toUpperCase().replace(/(STANDARDCASE|ELEMENTEDCASE)$/, "");
}

/** Validate duplicate options; throws `RangeError` when out of range. */
export function checkDuplicateOptions(o: DuplicateOptions = {}): Required<DuplicateOptions> {
  const maxVolumeDifference = o.maxVolumeDifference ?? DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE;
  const maxCentroidDistanceMetres =
    o.maxCentroidDistanceMetres ?? DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES;
  if (!Number.isFinite(maxVolumeDifference) || maxVolumeDifference < 0 || maxVolumeDifference > 1) {
    throw new RangeError("duplicate.maxVolumeDifference must be between 0 and 1");
  }
  if (!Number.isFinite(maxCentroidDistanceMetres) || maxCentroidDistanceMetres < 0) {
    throw new RangeError("duplicate.maxCentroidDistanceMetres must be a number >= 0");
  }
  return { maxVolumeDifference, maxCentroidDistanceMetres };
}

/** The clash fields the double-modelling decision looks at. */
export type DuplicateInput = Pick<
  ClashEntry,
  "ifcTypeA" | "ifcTypeB" | "aabbMatch" | "volumeA" | "volumeB" | "centroidDistanceMetres"
>;

/**
 * Why a clash is / isn't "possible double modelling", criterion by
 * criterion. `likelyDuplicate` is true only when all three
 * criteria pass.
 */
export interface DuplicateVerdict {
  likelyDuplicate: boolean;
  /** Thresholds the verdict was made against. */
  thresholds: Required<DuplicateOptions>;
  /** 1. Same IFC type after `normaliseIfcType`. */
  sameType: { ok: boolean; typeA: string; typeB: string };
  /** 2. Mesh centres close enough. `distanceMetres` null when not reported. */
  centre: { ok: boolean; distanceMetres: number | null };
  /**
   * 3. Same size. `method`:
   *  - `"volume"`: both meshes have a volume; compares `volumeDifference`
   *    (relative to the larger) with `maxVolumeDifference`;
   *  - `"flatBoxes"`: both meshes flat; compares `aabbMatch` with
   *    `FLAT_DUPLICATE_AABB_MATCH`;
   *  - `"mixed"`: one flat, one solid — never the same thing.
   */
  size: {
    ok: boolean;
    method: "volume" | "flatBoxes" | "mixed";
    volumeA: number | null;
    volumeB: number | null;
    volumeDifference: number | null;
    aabbMatch: number | null;
  };
}

/** Per-criterion double-modelling breakdown — see `DuplicateOptions`. */
export function duplicateVerdict(c: DuplicateInput, options: DuplicateOptions = {}): DuplicateVerdict {
  const thresholds = checkDuplicateOptions(options);

  const sameType =
    !!c.ifcTypeA && normaliseIfcType(c.ifcTypeA) === normaliseIfcType(c.ifcTypeB);

  const d = typeof c.centroidDistanceMetres === "number" ? c.centroidDistanceMetres : null;
  const centreOk = d !== null && d <= thresholds.maxCentroidDistanceMetres;

  const va = c.volumeA ?? null;
  const vb = c.volumeB ?? null;
  const aabbMatch = typeof c.aabbMatch === "number" ? c.aabbMatch : null;
  let size: DuplicateVerdict["size"];
  if (va !== null && vb !== null && va > 0 && vb > 0) {
    const diff = Math.abs(va - vb) / Math.max(va, vb);
    size = {
      ok: diff <= thresholds.maxVolumeDifference,
      method: "volume",
      volumeA: va,
      volumeB: vb,
      volumeDifference: diff,
      aabbMatch,
    };
  } else if (va === null && vb === null) {
    // Both flat (e.g. surfaces): fall back to near-identical boxes.
    size = {
      ok: aabbMatch !== null && aabbMatch >= FLAT_DUPLICATE_AABB_MATCH,
      method: "flatBoxes",
      volumeA: null,
      volumeB: null,
      volumeDifference: null,
      aabbMatch,
    };
  } else {
    size = { ok: false, method: "mixed", volumeA: va, volumeB: vb, volumeDifference: null, aabbMatch };
  }

  return {
    likelyDuplicate: sameType && centreOk && size.ok,
    thresholds,
    sameType: { ok: sameType, typeA: c.ifcTypeA, typeB: c.ifcTypeB },
    centre: { ok: centreOk, distanceMetres: d },
    size,
  };
}

/** True when a clash looks like double modelling — see `DuplicateOptions`. */
export function isLikelyDuplicate(c: DuplicateInput, options: DuplicateOptions = {}): boolean {
  return duplicateVerdict(c, options).likelyDuplicate;
}
