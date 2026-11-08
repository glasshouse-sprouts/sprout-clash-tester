// Project settings validation — pure and browser-safe, so the desktop
// renderer can check live edits (desktop MCP `ui_set_settings`, SPEC
// §13d) with exactly the messages a .clashproj load gives.

import type { GroupingOptions } from "./grouping.js";

export interface ProjectSettings {
  /** Clearance tolerance in metres. Default `0` = hard intersection. */
  toleranceMeters: number;
  /** Minimum penetration in metres (hard-intersection mode). Default `0.005`. */
  minPenetrationMeters: number;
  /**
   * Clash grouping (SPEC §13a). Optional — omitted means levels A + B with
   * defaults and no proximity grouping.
   */
  grouping?: GroupingOptions;
  /**
   * BCF export: one topic per clash (`"clash"`, default when omitted) or
   * per clash group (`"group"`). SPEC §13c.
   */
  bcfTopics?: "clash" | "group";
  /**
   * Skip element pairs that belong together by IFC relations: opening in
   * its host, door/window in its wall, parts of the same assembly
   * (SPEC §13e). Default true when omitted.
   */
  skipRelatedElements?: boolean;
  /**
   * Narrow phase that decides a clash (SPEC §13g): `"parry"` (default
   * when omitted) or `"ifclite"` (ifc-lite-clash: touch is not a clash,
   * real contact points, measured vs estimated depth).
   */
  narrowPhase?: "parry" | "ifclite";
  /**
   * ifc-lite only: also list touching pairs and unconfirmed box estimates
   * (status `touch` / `unconfirmed`). Default false.
   */
  reportTouch?: boolean;
}

/**
 * Validate a `settings` object. Returns the cleaned settings (defaults
 * where a field is invalid) and the list of problems — empty when valid.
 */
export function validateSettings(raw: unknown): { settings: ProjectSettings; issues: string[] } {
  const issues: string[] = [];
  const settings: ProjectSettings = {
    toleranceMeters: 0,
    minPenetrationMeters: 0.005,
  };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const s = raw as Record<string, unknown>;
    if (typeof s.toleranceMeters !== "number" || !Number.isFinite(s.toleranceMeters)) {
      issues.push("settings.toleranceMeters must be a finite number");
    } else if (s.toleranceMeters < 0) {
      issues.push("settings.toleranceMeters must be >= 0");
    } else {
      settings.toleranceMeters = s.toleranceMeters;
    }
    if (
      typeof s.minPenetrationMeters !== "number" ||
      !Number.isFinite(s.minPenetrationMeters)
    ) {
      issues.push("settings.minPenetrationMeters must be a finite number");
    } else if (s.minPenetrationMeters < 0) {
      issues.push("settings.minPenetrationMeters must be >= 0");
    } else {
      settings.minPenetrationMeters = s.minPenetrationMeters;
    }
    if (s.grouping !== undefined) {
      const grouping = validateGrouping(s.grouping, issues);
      if (grouping) settings.grouping = grouping;
    }
    if (s.skipRelatedElements !== undefined) {
      if (typeof s.skipRelatedElements === "boolean") {
        settings.skipRelatedElements = s.skipRelatedElements;
      } else {
        issues.push("settings.skipRelatedElements must be true or false");
      }
    }
    if (s.narrowPhase !== undefined) {
      if (s.narrowPhase === "parry" || s.narrowPhase === "ifclite") {
        settings.narrowPhase = s.narrowPhase;
      } else {
        issues.push('settings.narrowPhase must be "parry" or "ifclite"');
      }
    }
    if (s.reportTouch !== undefined) {
      if (typeof s.reportTouch === "boolean") {
        settings.reportTouch = s.reportTouch;
      } else {
        issues.push("settings.reportTouch must be true or false");
      }
    }
    if (s.bcfTopics !== undefined) {
      if (s.bcfTopics === "clash" || s.bcfTopics === "group") {
        settings.bcfTopics = s.bcfTopics;
      } else {
        issues.push('settings.bcfTopics must be "clash" or "group"');
      }
    }
  } else {
    issues.push("settings must be an object");
  }

  return { settings, issues };
}

/**
 * Validate `settings.grouping`. Both fields are optional; whatever is
 * present must be well-formed. Pushes messages onto `issues` and returns
 * null when anything is wrong.
 */
function validateGrouping(raw: unknown, issues: string[]): GroupingOptions | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push("settings.grouping must be an object");
    return null;
  }
  const g = raw as Record<string, unknown>;
  const out: GroupingOptions = {};
  let ok = true;
  if (g.minElementClashes !== undefined) {
    if (
      typeof g.minElementClashes !== "number" ||
      !Number.isInteger(g.minElementClashes) ||
      g.minElementClashes < 2
    ) {
      issues.push("settings.grouping.minElementClashes must be an integer >= 2");
      ok = false;
    } else {
      out.minElementClashes = g.minElementClashes;
    }
  }
  if (g.proximity !== undefined) {
    const p = g.proximity as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      issues.push("settings.grouping.proximity must be an object");
      ok = false;
    } else if (typeof p.enabled !== "boolean") {
      issues.push("settings.grouping.proximity.enabled must be true or false");
      ok = false;
    } else if (
      typeof p.radiusMetres !== "number" ||
      !Number.isFinite(p.radiusMetres) ||
      p.radiusMetres <= 0
    ) {
      issues.push("settings.grouping.proximity.radiusMetres must be a number > 0");
      ok = false;
    } else {
      out.proximity = { enabled: p.enabled, radiusMetres: p.radiusMetres };
    }
  }
  if (g.duplicate !== undefined) {
    const d = g.duplicate as Record<string, unknown> | null;
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      issues.push("settings.grouping.duplicate must be an object");
      ok = false;
    } else {
      const dup: NonNullable<GroupingOptions["duplicate"]> = {};
      const v = d.maxVolumeDifference;
      if (v !== undefined) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
          issues.push("settings.grouping.duplicate.maxVolumeDifference must be between 0 and 1");
          ok = false;
        } else {
          dup.maxVolumeDifference = v;
        }
      }
      const c = d.maxCentroidDistanceMetres;
      if (c !== undefined) {
        if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
          issues.push("settings.grouping.duplicate.maxCentroidDistanceMetres must be a number >= 0");
          ok = false;
        } else {
          dup.maxCentroidDistanceMetres = c;
        }
      }
      out.duplicate = dup;
    }
  }
  return ok ? out : null;
}

