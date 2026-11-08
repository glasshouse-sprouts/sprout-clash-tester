// Clash table of the Results view; a click opens the double-modelling
// breakdown under the row.

import { Fragment } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { duplicateVerdict, type DuplicateOptions } from "@clash-tester/core/grouping";
import { formatIfcClass } from "@clash-tester/core/types";
import type { AppState, LastRun } from "../../state";
import { DuplicateBadge } from "./badges";
import { DuplicateDetail } from "./DuplicateDetail";
import { fmtPos, fmtSeverity } from "./format";

export function ClashesTable({
  clashes,
  selectedClash,
  groupRows,
  duplicateRows,
  duplicateOptions,
  select,
}: {
  clashes: LastRun["clashes"];
  selectedClash: number | null;
  groupRows: Set<number>;
  duplicateRows: Set<number>;
  duplicateOptions: DuplicateOptions;
  select: (sel: Partial<AppState["selection"]>) => void;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Clashes ({clashes.length})</h3>
      <div className="max-h-96 overflow-auto rounded border border-neutral-800">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-neutral-900 text-left">
            <tr className="border-b border-neutral-800 text-neutral-400">
              <th
                className="px-2 py-2 font-normal"
                title="Clash number in this run — the BCF topic title starts with it (CSV column 'no')"
              >
                #
              </th>
              <th className="px-2 py-2 font-normal">Rule</th>
              <th className="px-2 py-2 font-normal">File A</th>
              <th className="px-2 py-2 font-normal">Type A</th>
              <th className="px-2 py-2 font-normal">File B</th>
              <th className="px-2 py-2 font-normal">Type B</th>
              <th className="px-2 py-2 font-normal" title="Position of the AABB-overlap midpoint, in metres">
                Position
              </th>
              <th
                className="px-2 py-2 font-normal"
                title="Penetration depth (intersection mode) or clearance gap (clearance mode), in metres"
              >
                Severity
              </th>
            </tr>
          </thead>
          <tbody>
            {clashes.map((c, i) => {
              const n = c.number ?? i + 1;
              const open = selectedClash === n;
              return (
              <Fragment key={i}>
              <tr
                data-clash-number={n}
                className={`cursor-pointer border-b border-neutral-900 ${
                  open ? "bg-blue-950" : groupRows.has(i) ? "bg-blue-950/50" : "hover:bg-neutral-900"
                }`}
                onClick={() => select({ clashNumber: open ? null : n })}
                title="Click to see the double-modelling check for this clash"
              >
                <td className="px-2 py-1 font-mono text-neutral-400 whitespace-nowrap">
                  {open ? (
                    <ChevronDown className="mr-0.5 inline size-3" />
                  ) : (
                    <ChevronRight className="mr-0.5 inline size-3" />
                  )}
                  {n}
                </td>
                <td className="px-2 py-1 font-mono">{c.rule}</td>
                <td className="px-2 py-1 font-mono">{c.fileA}</td>
                <IfcClassCell
                  ifcType={c.ifcTypeA}
                  typeClass={c.typeClassA}
                  predefinedType={c.predefinedTypeA}
                />
                <td className="px-2 py-1 font-mono">{c.fileB}</td>
                <IfcClassCell
                  ifcType={c.ifcTypeB}
                  typeClass={c.typeClassB}
                  predefinedType={c.predefinedTypeB}
                />
                <td className="px-2 py-1 font-mono">
                  {fmtPos(c.position)}
                </td>
                <td className="px-2 py-1 font-mono">
                  {fmtSeverity(c)}
                  {duplicateRows.has(i) && (
                    <>
                      {" "}
                      <DuplicateBadge />
                    </>
                  )}
                </td>
              </tr>
              {open && (
                <tr className="border-b border-neutral-900 bg-neutral-900/60">
                  <td colSpan={8} className="px-3 py-2">
                    <DuplicateDetail
                      clash={c}
                      verdict={duplicateVerdict(c, duplicateOptions)}
                      flaggedInRun={duplicateRows.has(i)}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** IFC class cell: `IFCFLOWSEGMENT → IfcDuctSegment` for generic
 * occurrences classified by their type object, plus the PredefinedType
 * when there is one (docs/PROJECT-FILE.md#ifc2x3-type-objects). */
function IfcClassCell({
  ifcType,
  typeClass,
  predefinedType,
}: {
  ifcType: string;
  typeClass?: string;
  predefinedType?: string;
}) {
  return (
    <td className="px-2 py-1">
      {formatIfcClass(ifcType, typeClass)}
      {predefinedType && <span className="text-neutral-500"> · {predefinedType}</span>}
    </td>
  );
}
