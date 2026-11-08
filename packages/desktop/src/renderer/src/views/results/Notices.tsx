// The callouts above the Results tables: engine warnings, the alignment
// nudge, "why zero clashes?" and possible double modelling.

import type { checkDuplicateOptions } from "@clash-tester/core/grouping";
import type { LastRun } from "../../state";
import { DuplicateBadge } from "./badges";
import { fmtCm, fmtPct } from "./format";

export function WarningsNotice({ warnings }: { warnings: LastRun["warnings"] }) {
  return (
    <section className="space-y-1 rounded border border-yellow-800 bg-yellow-950/40 p-3 text-xs">
      <h3 className="font-semibold text-yellow-200">Warnings</h3>
      {warnings.map((w, i) => (
        <div key={i} className="text-yellow-100">
          <span className="font-mono">[{w.kind}]</span>{" "}
          <span className="whitespace-pre-line">{w.message}</span>
        </div>
      ))}
    </section>
  );
}

/** Special-case nudge for the placement-mismatch warning — the single most
 * common cause of zero clashes on real Danish/Nordic projects (Revit
 * export-origin mismatch). Same check as Sprout · Fragments' federation
 * view. */
export function AlignmentNotice() {
  return (
    <section className="space-y-1 rounded border border-blue-800 bg-blue-950/40 p-3 text-xs text-blue-100">
      <h3 className="font-semibold text-blue-200">Fix the alignment first</h3>
      <p>
        Your IFCs are in different placement groups, which usually means
        they were exported with different Revit "Export Origin" settings
        (Shared Coordinates vs Project Base Point).
      </p>
      <p className="mt-1">
        <strong>Recommended workflow:</strong>
      </p>
      <ol className="ml-4 list-decimal space-y-0.5">
        <li>Open all the IFCs in <strong>Sprout · Fragments</strong>.</li>
        <li>
          Use its <em>Placement comparison</em> table to pick a reference
          model, then <em>auto-align</em> the others to it.
        </li>
        <li>
          Read off each non-reference model's net translation from Model
          Viewer's diagnostic.
        </li>
        <li>
          Back in Clash Tester, set each file's <code>translation</code>{" "}
          field in the <code>.clashproj</code> JSON and re-run.
        </li>
      </ol>
      <p className="mt-1 text-blue-200/80">
        The proper long-term fix is to re-export the IFCs from Revit with
        consistent Shared Coordinates — but the workflow above unblocks
        you immediately.
      </p>
    </section>
  );
}

export function ZeroClashesNotice() {
  return (
    <section className="space-y-1 rounded border border-neutral-700 bg-neutral-900/60 p-3 text-xs text-neutral-300">
      <h3 className="font-semibold text-neutral-100">Why zero clashes?</h3>
      <p>
        If you expected clashes, check:
      </p>
      <ul className="ml-4 list-disc space-y-0.5">
        <li>
          <strong>Discipline tags.</strong> Preset rules expand against
          files by discipline. If no project file matches a side's
          discipline, the rule is silently skipped — look for{" "}
          <span className="font-mono">[rule_expansion]</span> warnings above.
        </li>
        <li>
          <strong>File alignment.</strong> If the files were authored with
          different coordinate origins, the engine fires{" "}
          <span className="font-mono">[no_aabb_overlap]</span>. Fix with a
          per-file translation override (docs/HOW-IT-WORKS.md#coordinates-and-units).
        </li>
        <li>
          <strong>Selectors.</strong> Make sure the selectors actually
          match elements present in your IFCs (e.g.{" "}
          <span className="font-mono">IfcDuct*</span> matches{" "}
          <span className="font-mono">IfcDuctSegment</span>).
        </li>
        <li>
          <strong>Tolerance.</strong> Default is hard intersection. If you
          want elements that are close but not overlapping, raise{" "}
          <span className="font-mono">settings.toleranceMeters</span>.
        </li>
      </ul>
    </section>
  );
}

export function DuplicateNotice({
  count,
  thresholds,
}: {
  count: number;
  thresholds: ReturnType<typeof checkDuplicateOptions>;
}) {
  return (
    <section className="space-y-1 rounded border border-amber-800 bg-amber-950/40 p-3 text-xs text-amber-100">
      <h3 className="font-semibold text-amber-200">
        Possible double modelling ({count}){" "}
        <span className="font-normal text-amber-300/80">· experimental</span>
      </h3>
      <p>
        Same IFC type, same volume (within {fmtPct(thresholds.maxVolumeDifference)}) and the
        same centre point (within {fmtCm(thresholds.maxCentroidDistanceMetres)}) — very likely
        the same element modelled twice. Usually one of the two should be deleted. They are
        marked <DuplicateBadge />{" "}
        in the clash table below.
      </p>
    </section>
  );
}
