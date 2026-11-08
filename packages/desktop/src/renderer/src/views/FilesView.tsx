// Files view — list of registered IFCs with discipline + remove buttons.
// Drag-and-drop is handled at the App level so it works on any view.

import { Trash2 } from "lucide-react";
import type { Project } from "@clash-tester/core/types";
import { removeFileFromProject, setFileDiscipline } from "../state";
import type { AppState } from "../state";
import { AlignmentPanel } from "./AlignmentPanel";

const DISCIPLINES = [
  "ARCH",
  "STR",
  "MEP",
  "HVAC",
  "ELEC",
  "FIRE",
  "GEO",
  "UNKNOWN",
];

interface Props {
  state: AppState;
  patch: (fn: (prev: AppState) => AppState) => void;
}

export function FilesView({ state, patch }: Props) {
  if (!state.project) return null;
  const files = state.project.files.filter((f) => f.id !== "placeholder");

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Files</h2>
        <span className="text-xs text-neutral-400">
          {files.length} IFC{files.length === 1 ? "" : "s"}
        </span>
      </header>

      {/* Early-warning alignment check. Auto-runs ~500 ms after the
          file list changes. Hides itself when there are <2 files. */}
      <AlignmentPanel project={state.project} />

      {files.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-700 px-6 py-12 text-center text-sm text-neutral-400">
          Drop one or more <code>.ifc</code> files anywhere on the window to add
          them.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="py-2 pr-2 font-normal">Id</th>
              <th className="py-2 pr-2 font-normal">Discipline</th>
              <th className="py-2 pr-2 font-normal">Path</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="border-b border-neutral-900">
                <td className="py-2 pr-2 font-mono text-xs">{f.id}</td>
                <td className="py-2 pr-2">
                  <select
                    value={f.discipline ?? "UNKNOWN"}
                    onChange={(e) =>
                      patch((s) => updateFiles(s, (p) =>
                        setFileDiscipline(p, f.id, e.target.value),
                      ))
                    }
                    className="rounded bg-neutral-800 px-2 py-1 text-xs"
                  >
                    {DISCIPLINES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </td>
                <td
                  className="py-2 pr-2 truncate font-mono text-xs text-neutral-400"
                  title={f.path}
                >
                  {f.path}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() =>
                      patch((s) => updateFiles(s, (p) => removeFileFromProject(p, f.id)))
                    }
                    className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="rounded border border-neutral-800 bg-neutral-900/50 px-4 py-3 text-xs text-neutral-400">
        <strong className="text-neutral-300">Tip:</strong> Discipline tags
        connect files to preset rules. For example, a <code>HVACxSTR</code>{" "}
        preset will use every file tagged <code>HVAC</code> on side A and every
        file tagged <code>STR</code> on side B.
      </div>
    </div>
  );
}

function updateFiles(s: AppState, fn: (p: Project) => Project): AppState {
  if (!s.project) return s;
  return { ...s, project: fn(s.project), dirty: true };
}
