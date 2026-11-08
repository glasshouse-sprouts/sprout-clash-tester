// Results view — summary of the last run + clash table + output paths.

import { Fragment, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Download, FolderOpen } from "lucide-react";
// Browser-safe sub-path: pure grouping helpers only (no Node modules).
import {
  checkDuplicateOptions,
  duplicateVerdict,
  normaliseIfcType,
  type DuplicateOptions,
  type DuplicateVerdict,
} from "@clash-tester/core/grouping";
import { formatIfcClass, formatOpeningCuts } from "@clash-tester/core/types";
import { groupKindLabel, noSelection, type AppState, type LastRun } from "../state";

export function ResultsView({
  state,
  patch,
}: {
  state: AppState;
  patch: (fn: (prev: AppState) => AppState) => void;
}) {
  // Selection lives in AppState: a click here and the desktop MCP's
  // ui_select_* tools set the same thing (SPEC §13d).
  const { clashNumber: selectedClash, groupKey: selectedGroup } = state.selection;
  const rootRef = useRef<HTMLDivElement>(null);
  // Bring the selected row into view (group first, then clash).
  useEffect(() => {
    const target = selectedClash !== null
      ? `[data-clash-number="${selectedClash}"]`
      : selectedGroup !== null
        ? `[data-group-key="${CSS.escape(selectedGroup)}"]`
        : null;
    if (!target) return;
    rootRef.current?.querySelector(target)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedClash, selectedGroup]);
  const select = (sel: Partial<AppState["selection"]>) =>
    patch((s) => ({ ...s, selection: { ...noSelection, ...sel } }));

  if (!state.lastRun) {
    return (
      <div className="rounded border border-dashed border-neutral-700 px-6 py-12 text-center text-sm text-neutral-400">
        No results yet. Click <strong>Run</strong> in the top bar after adding
        files and rules.
      </div>
    );
  }
  const lr = state.lastRun;
  const groups = lr.groups ?? [];
  const duplicateGroups = groups.filter((g) => g.kind === "duplicate");
  // Clash rows that belong to a "possible double modelling" group.
  const duplicateRows = new Set(duplicateGroups.flatMap((g) => g.clashIndices));
  // Thresholds the "double?" verdict is made against (SPEC §13b).
  const duplicateOptions: DuplicateOptions = state.project?.settings.grouping?.duplicate ?? {};
  const thresholds = checkDuplicateOptions(duplicateOptions);
  const thresholdsFromProject = Object.keys(duplicateOptions).length > 0;
  // Clash rows of the selected group are highlighted too.
  const groupRows = new Set(groups.find((g) => g.key === selectedGroup)?.clashIndices ?? []);
  // The runner sets touch counts only for the ifc-lite narrow phase (SPEC §13g).
  const ifclite = lr.perRule.some((r) => r.touchCount !== undefined);
  return (
    <div ref={rootRef} className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Results</h2>
        <div className="flex gap-4 text-sm text-neutral-300">
          <Stat label="Total clashes" value={String(lr.totalClashes)} />
          <Stat label="Groups" value={String(groups.length)} />
          <Stat label="Time" value={fmtMs(lr.durationMs)} />
          <Stat label="Rules fired" value={String(lr.perRule.length)} />
          <Stat label="Warnings" value={String(lr.warnings.length)} />
        </div>
        {lr.openingCuts && (
          <div className="text-xs text-neutral-400">
            Geometry: {formatOpeningCuts(lr.openingCuts)}
          </div>
        )}
        <div className="text-xs text-neutral-400">
          Double modelling = same IFC type, volumes within{" "}
          <span className="font-mono text-neutral-200">{fmtPct(thresholds.maxVolumeDifference)}</span>,
          centres within{" "}
          <span className="font-mono text-neutral-200">
            {fmtCm(thresholds.maxCentroidDistanceMetres)}
          </span>{" "}
          ({thresholdsFromProject ? "project settings" : "defaults"}). Click a clash to see why
          it is or isn't flagged.
        </div>
      </header>

      {lr.warnings.length > 0 && (
        <section className="space-y-1 rounded border border-yellow-800 bg-yellow-950/40 p-3 text-xs">
          <h3 className="font-semibold text-yellow-200">Warnings</h3>
          {lr.warnings.map((w, i) => (
            <div key={i} className="text-yellow-100">
              <span className="font-mono">[{w.kind}]</span>{" "}
              <span className="whitespace-pre-line">{w.message}</span>
            </div>
          ))}
        </section>
      )}

      {/* Special-case nudge for the placement-mismatch warning — the
          single most common cause of zero clashes on real Danish/Nordic
          projects (Revit export-origin mismatch). See Model Viewer's
          docs/coord-frames-and-federation.md. */}
      {lr.warnings.some((w) => w.kind === "placement_mismatch") && (
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
            <li>Open all the IFCs in <strong>Model Viewer</strong>.</li>
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
      )}

      {lr.totalClashes === 0 && (
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
              per-file translation override (SPEC §4).
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
      )}

      {duplicateGroups.length > 0 && (
        <section className="space-y-1 rounded border border-amber-800 bg-amber-950/40 p-3 text-xs text-amber-100">
          <h3 className="font-semibold text-amber-200">
            Possible double modelling ({duplicateGroups.length})
          </h3>
          <p>
            Same IFC type, same volume (within {fmtPct(thresholds.maxVolumeDifference)}) and the
            same centre point (within {fmtCm(thresholds.maxCentroidDistanceMetres)}) — very likely
            the same element modelled twice. Usually one of the two should be deleted. They are
            marked <DuplicateBadge />{" "}
            in the clash table below.
          </p>
        </section>
      )}

      {groups.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Groups ({groups.length})</h3>
          <p className="text-xs text-neutral-400">
            Clashes grouped into issues: a clash group per element that
            clashes with many others, one per remaining element pair, and
            possible double modelling separately.
          </p>
          <div className="max-h-64 overflow-auto rounded border border-neutral-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-900 text-left">
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th
                    className="px-2 py-2 font-normal"
                    title="Group number — with 'BCF topics: per group' the BCF topic title starts with it"
                  >
                    #
                  </th>
                  <th className="px-2 py-2 font-normal">Kind</th>
                  <th className="px-2 py-2 font-normal">Group</th>
                  <th className="px-2 py-2 font-normal">Clashes</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr
                    key={g.key}
                    data-group-key={g.key}
                    onClick={() => select({ groupKey: selectedGroup === g.key ? null : g.key })}
                    className={`cursor-pointer border-b border-neutral-900 ${
                      selectedGroup === g.key ? "bg-blue-950" : "hover:bg-neutral-900"
                    }`}
                    title="Click to highlight this group's clashes"
                  >
                    <td className="px-2 py-1 font-mono text-neutral-400">{i + 1}</td>
                    <td className="px-2 py-1">
                      <KindBadge kind={g.kind} />
                    </td>
                    <td className="px-2 py-1" title={g.key}>
                      {g.title}
                    </td>
                    <td className="px-2 py-1 font-mono">{g.clashIndices.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Per rule</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="py-2 font-normal">Rule</th>
              <th className="py-2 font-normal">Clashes</th>
              <th
                className="py-2 font-normal"
                title="Overlapping pairs not reported because they belong together in the IFC: door/window in its wall, opening in its host, parts of the same assembly"
              >
                Skipped (belong together)
              </th>
              {ifclite && (
                <th
                  className="py-2 font-normal"
                  title="ifc-lite: pairs whose faces only touch, and hard-by-box-estimate pairs the surface test could not confirm. Not clashes."
                >
                  Not clashes (touch / unconfirmed)
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {lr.perRule.map((r) => (
              <tr key={r.name} className="border-b border-neutral-900">
                <td className="py-2 font-mono text-xs">{r.name}</td>
                <td className="py-2">{r.clashes}</td>
                <td className="py-2 text-neutral-400">{r.skippedByRelations ?? "–"}</td>
                {ifclite && (
                  <td className="py-2 text-neutral-400">
                    {r.touchCount ?? 0} / {r.unconfirmedCount ?? 0}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Clashes ({lr.clashes.length})</h3>
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
              {lr.clashes.map((c, i) => {
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

      <section className="space-y-2 rounded border border-neutral-800 bg-neutral-900/50 p-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Output files</h3>
          <span className="text-[10px] text-neutral-500">
            Files live in a temp directory until you export them.
          </span>
        </div>
        <OutputLink
          label="BCF"
          path={lr.outputs.bcf}
          defaultExportName="report.bcf"
        />
        <OutputLink
          label="JSON"
          path={lr.outputs.json}
          defaultExportName="clashes.json"
        />
        <OutputLink
          label="CSV"
          path={lr.outputs.csv}
          defaultExportName="clashes.csv"
        />
      </section>
    </div>
  );
}

/**
 * Why a clash is / isn't "double?" — each criterion with its measured
 * value, the threshold and ✓/✗ (TASKS T5). Read-only; the rule itself is
 * `duplicateVerdict` in clash-core.
 */
function DuplicateDetail({
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

/** IFC class cell: `IFCFLOWSEGMENT → IfcDuctSegment` for generic
 * occurrences classified by their type object, plus the PredefinedType
 * when there is one (SPEC §6). */
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

function fmtPct(fraction: number): string {
  const p = fraction * 100;
  return `${p < 10 && p !== Math.round(p) ? p.toFixed(1) : p.toFixed(0)} %`;
}

function fmtCm(metres: number): string {
  const cm = metres * 100;
  return `${cm < 10 ? cm.toFixed(1) : cm.toFixed(0)} cm`;
}

function fmtM3(v: number | null): string {
  if (v === null) return "flat";
  return v < 0.01 ? v.toExponential(2) : v.toFixed(3);
}

function DuplicateBadge() {
  return (
    <span
      className="rounded bg-amber-800 px-1.5 py-0.5 font-sans text-[10px] text-amber-50"
      title="Possible double modelling — click the row to see each criterion"
    >
      double?
    </span>
  );
}

const KIND_CLASS: Record<string, string> = {
  duplicate: "bg-amber-800 text-amber-50",
  clashGroup: "bg-blue-900 text-blue-100",
  element: "bg-blue-900 text-blue-100", // old name of clashGroup
  pair: "bg-neutral-800 text-neutral-200",
  area: "bg-purple-900 text-purple-100",
};

function KindBadge({ kind }: { kind: string }) {
  const cls = KIND_CLASS[kind] ?? "bg-neutral-800 text-neutral-200";
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] ${cls}`}>
      {groupKindLabel(kind)}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function OutputLink({
  label,
  path,
  defaultExportName,
}: {
  label: string;
  path?: string;
  defaultExportName: string;
}) {
  if (!path) return null;
  async function onExport() {
    const r = await window.api.exportFile(path!, defaultExportName);
    // We don't surface a toast on success — the OS save dialog already
    // gave the user feedback. Errors flow through the app-level error
    // banner.
    if (!r.ok) {
      console.error("Export failed:", r.error);
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 font-semibold">{label}</span>
      <span className="flex-1 truncate font-mono text-neutral-400" title={path}>
        {path}
      </span>
      <button
        onClick={() => window.api.revealInFolder(path)}
        className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-neutral-200 hover:bg-neutral-700"
        title="Show in Finder / Explorer"
      >
        <FolderOpen className="size-3" />
        Show
      </button>
      <button
        onClick={onExport}
        className="flex items-center gap-1 rounded bg-emerald-800 px-2 py-1 text-emerald-100 hover:bg-emerald-700"
        title="Export to a permanent location"
      >
        <Download className="size-3" />
        Export…
      </button>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtPos(p: [number, number, number]): string {
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
function fmtSeverity(c: {
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
