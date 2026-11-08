// Number formatting for the Results view.

export function fmtPct(fraction: number): string {
  const p = fraction * 100;
  return `${p < 10 && p !== Math.round(p) ? p.toFixed(1) : p.toFixed(0)} %`;
}

export function fmtCm(metres: number): string {
  const cm = metres * 100;
  return `${cm < 10 ? cm.toFixed(1) : cm.toFixed(0)} cm`;
}

export function fmtM3(v: number | null): string {
  if (v === null) return "flat";
  return v < 0.01 ? v.toExponential(2) : v.toFixed(3);
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtPos(p: [number, number, number]): string {
  return `${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}`;
}

/**
 * Format the depth-or-gap of a clash as a short human-readable string.
 *
 * Uses mm for sub-metre values (more familiar in BIM) and m above. An
 * arrow prefix indicates the mode at a glance:
 *   ↕  intersection (one element penetrating the other)
 *   ↔  clearance (elements close but not touching)
 *
 * Caveat: the parry depth is the engine's AABB-min-dim proxy, not
 * true geometric penetration. See SPEC §14. With the ifc-lite narrow
 * phase (SPEC §13g) a box-estimated depth gets "≈", and listed touching /
 * unconfirmed pairs say so instead of a severity.
 */
export function fmtSeverity(c: {
  mode: string;
  depthMetres: number | null;
  gapMetres: number | null;
  status?: string;
  distanceKind?: string;
}): string {
  if (c.status === "touch") return "touch (not a clash)";
  if (c.status === "unconfirmed") return "unconfirmed (not a clash)";
  const v = c.depthMetres ?? c.gapMetres;
  if (v === null || v === undefined) return "";
  const prefix = (c.mode === "clearance" ? "↔ " : "↕ ") + (c.distanceKind === "estimate" ? "≈" : "");
  const text =
    v < 1 ? `${(v * 1000).toFixed(0)} mm` : `${v.toFixed(2)} m`;
  return prefix + text;
}
