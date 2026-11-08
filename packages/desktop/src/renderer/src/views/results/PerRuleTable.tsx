// Per-rule table of the Results view.

import type { LastRun } from "../../state";

export function PerRuleTable({
  perRule,
  ifclite,
}: {
  perRule: LastRun["perRule"];
  ifclite: boolean;
}) {
  return (
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
          {perRule.map((r) => (
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
  );
}
