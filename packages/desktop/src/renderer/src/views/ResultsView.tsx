// Results view — summary of the last run + clash table + output paths.

import { useEffect, useRef } from "react";
// Browser-safe sub-path: pure grouping helpers only (no Node modules).
import { checkDuplicateOptions, type DuplicateOptions } from "@clash-tester/core/grouping";
import { formatOpeningCuts } from "@clash-tester/core/types";
import { noSelection, type AppState } from "../state";
import { Stat } from "./results/badges";
import { ClashesTable } from "./results/ClashesTable";
import { fmtCm, fmtMs, fmtPct } from "./results/format";
import { GroupsTable } from "./results/GroupsTable";
import {
  AlignmentNotice,
  DuplicateNotice,
  WarningsNotice,
  ZeroClashesNotice,
} from "./results/Notices";
import { OutputLink } from "./results/OutputLink";
import { PerRuleTable } from "./results/PerRuleTable";

export function ResultsView({
  state,
  patch,
}: {
  state: AppState;
  patch: (fn: (prev: AppState) => AppState) => void;
}) {
  // Selection lives in AppState: a click here and the desktop MCP's
  // ui_select_* tools set the same thing (docs/MCP.md#desktop-live-ui--clash-tester-ui).
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
  // Thresholds the "double?" verdict is made against (docs/HOW-IT-WORKS.md#double-modelling).
  const duplicateOptions: DuplicateOptions = state.project?.settings.grouping?.duplicate ?? {};
  const thresholds = checkDuplicateOptions(duplicateOptions);
  const thresholdsFromProject = Object.keys(duplicateOptions).length > 0;
  // Clash rows of the selected group are highlighted too.
  const groupRows = new Set(groups.find((g) => g.key === selectedGroup)?.clashIndices ?? []);
  // The runner sets touch counts only for the ifc-lite narrow phase
  // (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase).
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

      {lr.warnings.length > 0 && <WarningsNotice warnings={lr.warnings} />}

      {lr.warnings.some((w) => w.kind === "placement_mismatch") && <AlignmentNotice />}

      {lr.totalClashes === 0 && <ZeroClashesNotice />}

      {duplicateGroups.length > 0 && (
        <DuplicateNotice count={duplicateGroups.length} thresholds={thresholds} />
      )}

      {groups.length > 0 && (
        <GroupsTable groups={groups} selectedGroup={selectedGroup} select={select} />
      )}

      <PerRuleTable perRule={lr.perRule} ifclite={ifclite} />

      <ClashesTable
        clashes={lr.clashes}
        selectedClash={selectedClash}
        groupRows={groupRows}
        duplicateRows={duplicateRows}
        duplicateOptions={duplicateOptions}
        select={select}
      />

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
