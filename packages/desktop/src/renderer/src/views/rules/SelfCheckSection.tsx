// "Self check" section of the Rules view (SPEC §13b).

import { useState } from "react";
import { selfCheckRuleName } from "../../state";

/**
 * "Self check" — a model tested against itself (SPEC §13b). Finds internal
 * clashes and double modelling. One click adds `SELF-<fileId>` with the
 * same file on both sides and all element types.
 */
export function SelfCheckSection({
  files,
  existingRuleNames,
  onAdd,
}: {
  files: { id: string; discipline?: string }[];
  existingRuleNames: string[];
  onAdd: (fileId: string, ignoreSpacesAndOpenings: boolean) => void;
}) {
  const [fileId, setFileId] = useState("");
  const [ignoreSpacesAndOpenings, setIgnoreSpacesAndOpenings] = useState(true);
  const chosen = fileId || files[0]?.id || "";
  const exists = existingRuleNames.includes(selfCheckRuleName(chosen));
  return (
    <section className="space-y-3 rounded border border-neutral-800 bg-neutral-900/50 p-4">
      <h3 className="text-sm font-semibold">Self check</h3>
      <p className="text-xs text-neutral-400">
        Check a model against itself to find internal clashes and elements
        that are modelled twice. Expect some noise from elements that are
        meant to touch (e.g. wall joins).
      </p>
      {files.length === 0 ? (
        <div className="text-xs text-neutral-400">Add a file in the Files view first.</div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={chosen}
              onChange={(e) => setFileId(e.target.value)}
              className="rounded bg-neutral-800 px-2 py-1 text-xs"
            >
              {files.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id} — {f.discipline ?? "UNKNOWN"}
                </option>
              ))}
            </select>
            <button
              onClick={() => chosen && onAdd(chosen, ignoreSpacesAndOpenings)}
              disabled={!chosen || exists}
              className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {exists ? "Already added" : "Add self check"}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={ignoreSpacesAndOpenings}
              onChange={(e) => setIgnoreSpacesAndOpenings(e.target.checked)}
            />
            Ignore spaces, zones and openings (IfcSpace, IfcSpatialZone, IfcOpeningElement)
          </label>
        </div>
      )}
    </section>
  );
}
