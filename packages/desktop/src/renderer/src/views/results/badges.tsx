// Small badges and the header stat of the Results view.

import { groupKindLabel } from "../../state";

export function DuplicateBadge() {
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

export function KindBadge({ kind }: { kind: string }) {
  const cls = KIND_CLASS[kind] ?? "bg-neutral-800 text-neutral-200";
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] ${cls}`}>
      {groupKindLabel(kind)}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
