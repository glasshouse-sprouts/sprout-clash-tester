// The per-clash double-modelling breakdown.

import { normaliseIfcType, type DuplicateVerdict } from "@clash-tester/core/grouping";
import type { LastRun } from "../../state";
import { fmtCm, fmtM3, fmtPct } from "./format";

/**
 * Why a clash is / isn't "double?" — each criterion with its measured
 * value, the threshold and ✓/✗. Read-only; the rule itself is
 * `duplicateVerdict` in clash-core.
 */
export function DuplicateDetail({
  clash: c,
  verdict: v,
  flaggedInRun,
}: {
  clash: LastRun["clashes"][number];
  verdict: DuplicateVerdict;
  flaggedInRun: boolean;
}) {
  const t = v.thresholds;
  const size = v.size;
  const sizeValue =
    size.method === "volume"
      ? `${fmtM3(size.volumeA)} vs ${fmtM3(size.volumeB)} m³ — ${fmtPct(size.volumeDifference ?? 0)} apart`
      : size.method === "flatBoxes"
        ? `both flat — box match ${size.aabbMatch === null ? "n/a" : fmtPct(size.aabbMatch)}`
        : `one flat, one solid (${fmtM3(size.volumeA)} vs ${fmtM3(size.volumeB)} m³)`;
  const sizeLimit =
    size.method === "volume" ? `≤ ${fmtPct(t.maxVolumeDifference)}` : size.method === "flatBoxes" ? "≥ 95 %" : "never";
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-neutral-200">Double-modelling check</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${v.likelyDuplicate ? "bg-amber-800 text-amber-50" : "bg-neutral-800 text-neutral-300"}`}
        >
          {v.likelyDuplicate ? "double?" : "not a duplicate"}
        </span>
        {flaggedInRun !== v.likelyDuplicate && (
          <span className="text-[10px] text-neutral-500">
            (the run used other thresholds — re-run to update the badge)
          </span>
        )}
      </div>
      <table className="text-xs">
        <tbody>
          <CriterionRow
            ok={v.sameType.ok}
            name="Same IFC type"
            value={`${c.ifcTypeA} / ${c.ifcTypeB} → ${normaliseIfcType(c.ifcTypeA)} / ${normaliseIfcType(c.ifcTypeB)}`}
            limit={v.sameType.ok ? "yes" : "no"}
          />
          <CriterionRow
            ok={v.centre.ok}
            name="Centre distance"
            value={v.centre.distanceMetres === null ? "not reported" : fmtCm(v.centre.distanceMetres)}
            limit={`≤ ${fmtCm(t.maxCentroidDistanceMetres)}`}
          />
          <CriterionRow ok={size.ok} name="Same size" value={sizeValue} limit={sizeLimit} />
          <tr>
            <td />
            <td className="pr-3 text-neutral-500">Box match (info)</td>
            <td className="pr-3 font-mono text-neutral-400">
              {size.aabbMatch === null ? "n/a" : fmtPct(size.aabbMatch)}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CriterionRow({ ok, name, value, limit }: { ok: boolean; name: string; value: string; limit: string }) {
  return (
    <tr>
      <td className={`pr-2 ${ok ? "text-emerald-400" : "text-red-400"}`}>{ok ? "✓" : "✗"}</td>
      <td className="pr-3 text-neutral-300">{name}</td>
      <td className="pr-3 font-mono text-neutral-200">{value}</td>
      <td className="font-mono text-neutral-500">{limit}</td>
    </tr>
  );
}
