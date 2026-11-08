// Engine options of the Rules view: relation skip, ifc-lite narrow phase,
// touch reporting.

import type { Project } from "@clash-tester/core/types";
import { setNarrowPhase, setReportTouch, setSkipRelatedElements } from "../../state";

export function EngineOptions({
  project,
  updateProject,
}: {
  project: Project;
  updateProject: (fn: (p: Project) => Project) => void;
}) {
  return (
    <section className="space-y-2 rounded border border-neutral-800 bg-neutral-900/50 p-4">
      <label className="flex items-start gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={project.settings.skipRelatedElements !== false}
          onChange={(e) =>
            updateProject((p) => setSkipRelatedElements(p, e.target.checked))
          }
        />
        <span>
          <span className="font-semibold text-neutral-100">
            Skip elements that belong together in the IFC
          </span>
          <br />
          Door/window in its wall, opening in its host, parts of the same
          assembly. Applies to every rule, within one file.
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={project.settings.narrowPhase === "ifclite"}
          onChange={(e) =>
            updateProject((p) => setNarrowPhase(p, e.target.checked ? "ifclite" : "parry"))
          }
        />
        <span>
          <span className="font-semibold text-neutral-100">
            Use the ifc-lite narrow phase (trial)
          </span>
          <br />
          Faces that only touch are not clashes; clashes aim at the real
          contact point. Off = the current engine.
        </span>
      </label>
      {project.settings.narrowPhase === "ifclite" && (
        <label className="ml-5 flex items-start gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={project.settings.reportTouch === true}
            onChange={(e) => updateProject((p) => setReportTouch(p, e.target.checked))}
          />
          <span>
            List touching and unconfirmed pairs too (marked in the results;
            they still aren't clashes)
          </span>
        </label>
      )}
    </section>
  );
}
