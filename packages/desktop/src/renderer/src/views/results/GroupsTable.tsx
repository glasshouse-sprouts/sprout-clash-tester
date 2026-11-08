// Groups table of the Results view (docs/HOW-IT-WORKS.md#grouping).

import type { AppState, LastRun } from "../../state";
import { KindBadge } from "./badges";

export function GroupsTable({
  groups,
  selectedGroup,
  select,
}: {
  groups: NonNullable<LastRun["groups"]>;
  selectedGroup: string | null;
  select: (sel: Partial<AppState["selection"]>) => void;
}) {
  return (
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
  );
}
