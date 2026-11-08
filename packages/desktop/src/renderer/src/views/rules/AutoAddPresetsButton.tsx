// "Auto-add presets" button of the Rules view.

import { useState } from "react";
import type { Project } from "@clash-tester/core/types";

/**
 * "Auto-add presets" button. Calls the clash-core helper via the IPC
 * bridge (so the renderer doesn't import value-side `@clash-tester/core`,
 * which would pull Node modules into the bundle). The result is a new
 * project with applicable presets appended; we apply it through the
 * regular updateProject patch so dirty state is flagged correctly.
 *
 * Inline status text below the button reports what happened:
 *   - "Added N presets: ..."
 *   - "All applicable presets are already in your rules."
 *   - "No applicable presets — tag more files with distinct disciplines."
 */
export function AutoAddPresetsButton({
  project,
  updateProject,
}: {
  project: Project;
  updateProject: (fn: (p: Project) => Project) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await window.api.autoAddPresets(project);
      if (!r.ok) {
        setStatus(`Error: ${r.error}`);
        return;
      }
      const { project: next, added, disciplinesSeen } = r.value;
      if (added.length > 0) {
        updateProject(() => next);
        setStatus(`Added ${added.length} preset${added.length === 1 ? "" : "s"}: ${added.join(", ")}`);
        return;
      }
      // Nothing added — distinguish "nothing applicable" from "all already present".
      if (disciplinesSeen.length < 2) {
        setStatus(
          `No applicable presets — only one discipline tagged so far (${disciplinesSeen.join(", ") || "none"}).`,
        );
      } else {
        setStatus(`All applicable presets are already in your rules.`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status && (
        <span className="text-[10px] text-neutral-400" title={status}>
          {status}
        </span>
      )}
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded bg-blue-700 px-2.5 py-1 text-xs text-white hover:bg-blue-600 disabled:bg-neutral-800 disabled:text-neutral-500"
        title="Add every shipped preset whose disciplines match your project's tagged files."
      >
        {busy ? "Adding…" : "Auto-add presets"}
      </button>
    </div>
  );
}
