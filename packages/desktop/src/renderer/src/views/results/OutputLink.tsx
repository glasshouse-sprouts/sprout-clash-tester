// One output file row: path, Show in folder, Export.

import { Download, FolderOpen } from "lucide-react";

export function OutputLink({
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
