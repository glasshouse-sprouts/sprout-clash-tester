// Clash Tester desktop — top-level layout.
//
// Single window. Left sidebar with three tabs (Files / Rules / Results).
// Top bar with Open / Save / Save As / Run.
// Drag-and-drop .ifc anywhere on the window adds to the project.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilePlus2,
  FolderOpen,
  Play,
  Save,
  Loader2,
  CircleAlert,
  Upload,
  ChevronDown,
  ChevronRight,
  Bot,
} from "lucide-react";
import {
  applyProgressLine,
  freshProgress,
  shortStatus,
  type RunProgress,
} from "./progress";
import { FilesView } from "./views/FilesView";
import { RulesView } from "./views/RulesView";
import { ResultsView } from "./views/ResultsView";
import { applyUiOp, isPureOp, runSummary } from "./mcpOps";
import {
  addFileChecked,
  applyAutoAddPresets,
  applyEditOp,
  canUndoAiEdit,
  isEditOp,
  undoAiEdit,
} from "./mcpEditOps";
import type { McpIpcRequest } from "../../shared/mcp/protocol";
import {
  addFileToProject,
  classifyDroppedPaths,
  dropPlaceholderIfRealFiles,
  emptyProject,
  initialAppState,
  noSelection,
  runBlockedReason,
  setBcfTopics,
  type AppState,
  type LastRun,
  type View,
} from "./state";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState>(initialAppState);
  /**
   * Drag-counter approach: dragenter/leave on the window fires for every
   * child element you cross. We bump a counter on enter, drop it on
   * leave, and only hide the overlay when it reaches zero. Otherwise
   * the overlay flickers off the moment the mouse enters a child node.
   */
  const dragCounterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  /** Update helper. Receives `(prev) => next`. */
  const patch = useCallback((fn: (prev: AppState) => AppState) => {
    setState((prev) => fn(prev));
  }, []);

  // ─── New / open / save ────────────────────────────────────────────────────

  const onNew = useCallback(() => {
    patch((s) => ({
      ...s,
      project: emptyProject(),
      projectPath: null,
      view: "files",
      dirty: true,
      lastRun: null,
      error: null,
      selection: noSelection,
    }));
  }, [patch]);

  const onOpen = useCallback(async () => {
    const r = await window.api.openProjectDialog();
    if (!r.ok) {
      patch((s) => ({ ...s, error: r.error }));
      return;
    }
    if (r.value === null) return; // user cancelled
    const { path: p, project } = r.value;
    patch((s) => ({
      ...s,
      project,
      projectPath: p,
      view: "files",
      dirty: false,
      lastRun: null,
      error: null,
      selection: noSelection,
    }));
  }, [patch]);

  /**
   * Save the project. Returns true when a save actually completed,
   * false otherwise (user cancelled the save-as dialog, or the save
   * failed). Used both by the toolbar Save button and by the
   * close-with-prompt handler so it can wait for the save to finish.
   */
  const onSave = useCallback(async (): Promise<boolean> => {
    if (!state.project) return false;
    if (state.projectPath) {
      const r = await window.api.saveProject(
        state.projectPath,
        dropPlaceholderIfRealFiles(state.project),
      );
      if (!r.ok) {
        patch((s) => ({ ...s, error: r.error }));
        return false;
      }
      patch((s) => ({ ...s, dirty: false, error: null }));
      return true;
    } else {
      // No path yet — do save-as.
      const r = await window.api.saveProjectAs(
        dropPlaceholderIfRealFiles(state.project),
      );
      if (!r.ok) {
        patch((s) => ({ ...s, error: r.error }));
        return false;
      }
      if (r.value === null) return false; // user cancelled
      patch((s) => ({
        ...s,
        projectPath: r.value,
        dirty: false,
        error: null,
      }));
      return true;
    }
  }, [state.project, state.projectPath, patch]);

  // Main shows the Save / Discard / Cancel prompt on close only when it
  // knows the project is unsaved (main/window.ts), so report every change.
  useEffect(() => {
    void window.api?.setDirty?.(state.dirty);
  }, [state.dirty]);

  // Listen for the "save before closing" event from the main process.
  // After we attempt the save (success or failure), tell main it's
  // safe to destroy the window — we already had the user's intent
  // when they clicked "Save" in the close prompt.
  useEffect(() => {
    if (!window.events || typeof window.events.onSaveBeforeClose !== "function") {
      return;
    }
    const handler = async () => {
      await onSave();
      if (window.api && typeof window.api.confirmCloseAfterSave === "function") {
        await window.api.confirmCloseAfterSave();
      }
    };
    window.events.onSaveBeforeClose(handler);
    return () => window.events.offSaveBeforeClose(handler);
  }, [onSave]);

  // ─── Run ──────────────────────────────────────────────────────────────────

  /**
   * Listen for streamed engine-progress lines. The reducer in
   * `progress.ts` turns each line into structured `RunProgress` state.
   * Defensive: if the preload didn't expose `window.events` (stale
   * after a restart, etc.) we log a warning instead of crashing.
   */
  useEffect(() => {
    if (!window.events || typeof window.events.onRunProgress !== "function") {
      console.warn(
        "[clash-tester] window.events.onRunProgress not available — " +
          "preload may not have reloaded. Restart `npm run dev`.",
      );
      return;
    }
    const handler = (line: string) => {
      console.debug("[clash-tester progress]", line);
      patch((s) =>
        s.runProgress
          ? { ...s, runProgress: applyProgressLine(s.runProgress, line) }
          : s,
      );
    };
    window.events.onRunProgress(handler);
    return () => window.events.offRunProgress(handler);
  }, [patch]);

  /**
   * Run detection on the in-memory project. Resolves when the run is
   * over with the new LastRun or the error shown to the user — the
   * desktop MCP's `ui_run` answers with it.
   */
  const onRun = useCallback(async (): Promise<
    { ok: true; lastRun: LastRun } | { ok: false; error: string }
  > => {
    if (!state.project) return { ok: false, error: "No project is open." };
    if (state.running) return { ok: false, error: "A run is already in progress." };
    // No longer requires a saved project — engine reads from the
    // in-memory state and writes outputs to a temp dir (or alongside
    // the project file when one exists). User can Export / Save
    // afterwards.
    if (state.dirty && state.projectPath) {
      // Keep on-disk project in sync when a path exists.
      await window.api.saveProject(
        state.projectPath,
        dropPlaceholderIfRealFiles(state.project),
      );
      patch((s) => ({ ...s, dirty: false }));
    }
    // Set up progress state BEFORE awaiting the engine, so the
    // ProgressBar renders the moment the user clicks Run.
    const enabledRules = state.project.rules.filter(
      (r) => r.enabled !== false,
    ).length;
    console.debug("[clash-tester] starting run, enabledRules =", enabledRules);
    patch((s) => ({
      ...s,
      running: true,
      runProgress: freshProgress(enabledRules),
      error: null,
    }));
    const r = await window.api.runDetection({
      project: dropPlaceholderIfRealFiles(state.project),
      projectPath: state.projectPath,
    });
    if (!r.ok) {
      patch((s) => ({
        ...s,
        running: false,
        runProgress: null,
        error: r.error,
        view: "results",
      }));
      return { ok: false, error: r.error };
    }
    const v = r.value;
    const last: LastRun = {
      totalClashes: v.totalClashes,
      durationMs: v.durationMs,
      perRule: v.perRule,
      warnings: v.warnings,
      openingCuts: v.openingCuts,
      clashes: v.clashes,
      groups: v.groups ?? [],
      outputs: v.outputs,
    };
    // Persist a summary of this run into the project itself, so saving
    // the project (or re-opening it later) carries the run history
    // along with the rule set. We only keep counts + output paths in
    // the project — the full clash list stays in the run JSON file
    // (avoids bloating .clashproj).
    const ranAt = new Date().toISOString();
    patch((s) => {
      const updatedProject = s.project
        ? {
            ...s.project,
            lastResults: {
              ranAt,
              totalClashes: v.totalClashes,
              outputs: {
                bcf: v.outputs.bcf,
                json: v.outputs.json,
                csv: v.outputs.csv,
              },
            },
          }
        : s.project;
      return {
        ...s,
        project: updatedProject,
        // The project changed (lastResults block); mark dirty so the
        // user is prompted to Save (or saves explicitly).
        dirty: true,
        running: false,
        runProgress: null,
        lastRun: last,
        view: "results",
        error: null,
        selection: noSelection,
      };
    });
    return { ok: true, lastRun: last };
  }, [state.project, state.projectPath, state.running, state.dirty, patch]);

  // ─── Desktop MCP (docs/MCP.md#desktop-live-ui--clash-tester-ui)
  // ──────────────────────────────────────────────

  // Tool calls arrive outside React's render cycle; read the latest
  // state and Run handler through refs.
  const stateRef = useRef(state);
  stateRef.current = state;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (!window.events || typeof window.events.onMcpRequest !== "function") return;
    const handler = async ({ id, op, args }: McpIpcRequest) => {
      const respond = (r: { ok: true; data: unknown } | { ok: false; error: string }) =>
        window.events.respondMcp({ id, ...r });
      try {
        // Apply an op result now: the ref first, so a second tool call
        // arriving before React re-renders already sees this one.
        const commit = (next: AppState) => {
          stateRef.current = next;
          patch(() => next);
        };
        if (isPureOp(op)) {
          const { state: next, result } = applyUiOp(stateRef.current, op, args);
          stateRef.current = next;
          // Re-apply to the freshest state so concurrent updates (run
          // progress) are not overwritten.
          patch((prev) => {
            try {
              return applyUiOp(prev, op, args).state;
            } catch {
              return prev;
            }
          });
          respond({ ok: true, data: result });
          return;
        }
        // Edits are refused while a run is in progress, so nothing else
        // changes the state concurrently — commit the computed state.
        if (isEditOp(op)) {
          const r = applyEditOp(stateRef.current, op, args);
          commit(r.state);
          respond({ ok: true, data: r.result });
          return;
        }
        if (op === "ui_add_file") {
          const filePath = typeof args.path === "string" ? args.path : "";
          const ping = await window.api.pingPaths([filePath]);
          if (!ping.ok) throw new Error(ping.error);
          const r = addFileChecked(stateRef.current, args, ping.value[0]!);
          commit(r.state);
          respond({ ok: true, data: r.result });
          return;
        }
        if (op === "ui_auto_add_presets") {
          if (!stateRef.current.project) throw new Error("No project is open in Clash Tester.");
          const auto = await window.api.autoAddPresets(stateRef.current.project);
          if (!auto.ok) throw new Error(auto.error);
          const r = applyAutoAddPresets(stateRef.current, auto.value);
          commit(r.state);
          respond({ ok: true, data: r.result });
          return;
        }
        if (op === "ui_run") {
          const blocked = stateRef.current.running
            ? "A run is already in progress."
            : runBlockedReason(stateRef.current.project);
          if (blocked) throw new Error(blocked);
          const outcome = await onRunRef.current();
          if (!outcome.ok) throw new Error(outcome.error);
          respond({ ok: true, data: runSummary(outcome.lastRun) });
          return;
        }
        throw new Error(`Unknown op: ${op}`);
      } catch (err) {
        respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    window.events.onMcpRequest(handler);
    return () => window.events.offMcpRequest(handler);
  }, [patch]);

  // ─── Drag-and-drop IFCs ───────────────────────────────────────────────────

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => {
      // Some browsers expose only `dataTransfer.types`. Look for "Files".
      const types = e.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
      }
      return false;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      // MUST preventDefault here for the browser to allow a drop event.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      // Electron 32+ removed File.path. Get the real path via the
      // preload bridge (webUtils.getPathForFile under the hood).
      const paths = files
        .map((f) => window.api.getPathForFile(f))
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length === 0) {
        patch((s) => ({
          ...s,
          error:
            "Couldn't read the dropped file paths. " +
            "If this keeps happening, please report it.",
        }));
        return;
      }
      const r = await window.api.pingPaths(paths);
      if (!r.ok) {
        patch((s) => ({ ...s, error: r.error }));
        return;
      }
      const { ifcs, ignored } = classifyDroppedPaths(r.value);
      if (ifcs.length === 0) {
        patch((s) => ({
          ...s,
          error:
            ignored.length > 0
              ? `No .ifc files in drop (${ignored.length} ignored)`
              : "No files dropped",
        }));
        return;
      }
      patch((s) => {
        let project = s.project ?? emptyProject();
        for (const p of ifcs) project = addFileToProject(project, p);
        project = dropPlaceholderIfRealFiles(project);
        return {
          ...s,
          project,
          view: "files",
          dirty: true,
          error: ignored.length > 0 ? `Skipped ${ignored.length} non-IFC item(s)` : null,
        };
      });
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [patch]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const ready = state.project !== null;
  return (
    <div className="relative flex h-full w-full flex-col">
      <TopBar
        state={state}
        onNew={onNew}
        onOpen={onOpen}
        onSave={onSave}
        onRun={onRun}
        onBcfTopics={(mode) =>
          patch((s) =>
            s.project ? { ...s, project: setBcfTopics(s.project, mode), dirty: true } : s,
          )
        }
      />
      {state.error && (
        <div className="flex items-center gap-2 border-b border-red-800 bg-red-950 px-4 py-2 text-red-200">
          <CircleAlert className="size-4 shrink-0" />
          <span className="flex-1 text-sm">{state.error}</span>
          <button
            className="text-xs underline opacity-70"
            onClick={() => patch((s) => ({ ...s, error: null }))}
          >
            dismiss
          </button>
        </div>
      )}
      {/* Last desktop-MCP edit (docs/MCP.md#desktop-live-ui--clash-tester-ui):
          non-blocking, one-step Undo. Hidden once the user edits further
          (the snapshot is stale). */}
      {canUndoAiEdit(state) && (
        <div className="flex items-center gap-2 border-b border-violet-800 bg-violet-950 px-4 py-2 text-violet-100">
          <Bot className="size-4 shrink-0" />
          <span className="flex-1 text-sm">AI changed: {state.aiUndo!.label}</span>
          <button
            className="rounded bg-violet-800 px-2 py-0.5 text-xs hover:bg-violet-700"
            onClick={() => patch(undoAiEdit)}
          >
            Undo
          </button>
          <button
            className="text-xs underline opacity-70"
            onClick={() => patch((s) => ({ ...s, aiUndo: null }))}
          >
            dismiss
          </button>
        </div>
      )}
      {/* Defensive: render the progress bar whenever a run is in flight,
          even if `runProgress` somehow ended up null. The component
          handles a freshly-minted progress object gracefully. */}
      {(state.running || state.runProgress) && (
        <ProgressBar progress={state.runProgress ?? freshProgress(0)} />
      )}
      <div className="flex flex-1 overflow-hidden">
        {!ready ? (
          <EmptyState onNew={onNew} onOpen={onOpen} />
        ) : (
          <>
            <Sidebar
              view={state.view}
              onSelect={(v) => patch((s) => ({ ...s, view: v }))}
            />
            <main className="flex-1 overflow-auto p-4">
              {state.view === "files" && (
                <FilesView state={state} patch={patch} />
              )}
              {state.view === "rules" && (
                <RulesView state={state} patch={patch} />
              )}
              {state.view === "results" && <ResultsView state={state} patch={patch} />}
            </main>
          </>
        )}
      </div>
      <DropOverlay show={isDragging} />
    </div>
  );
}

function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-emerald-900/40 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-2xl border-4 border-dashed border-emerald-400 bg-neutral-950/70 px-12 py-10 text-emerald-100">
        <Upload className="size-12" />
        <div className="text-xl font-semibold">Drop IFC files here</div>
        <div className="text-sm text-emerald-200/80">
          Non-IFC items will be skipped.
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function TopBar({
  state,
  onNew,
  onOpen,
  onSave,
  onRun,
  onBcfTopics,
}: {
  state: AppState;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onRun: () => void;
  onBcfTopics: (mode: "clash" | "group") => void;
}) {
  // Run doesn't require a saved project. Needs ≥1 file and ≥1 enabled
  // rule (one file is enough for a self check). The engine reads the
  // in-memory state and writes outputs to a temp dir — user can Export /
  // Save afterwards.
  const blockedReason = runBlockedReason(state.project);
  const canRun = blockedReason === null && !state.running;
  const runButtonText = state.running
    ? state.runProgress
      ? shortStatus(state.runProgress)
      : "Running…"
    : "Run";
  return (
    <header className="drag flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2">
      <span className="ml-16 text-sm font-semibold tracking-tight">
        Sprout · Clash Tester
      </span>
      <span className="ml-2 text-xs text-neutral-400">
        {state.projectPath ? state.projectPath.split(/[\\/]/).pop() : "no project"}
        {state.dirty && " •"}
      </span>
      <div className="no-drag ml-auto flex items-center gap-1">
        <ToolButton onClick={onNew} icon={<FilePlus2 className="size-4" />}>
          New
        </ToolButton>
        <ToolButton onClick={onOpen} icon={<FolderOpen className="size-4" />}>
          Open
        </ToolButton>
        <ToolButton
          onClick={onSave}
          disabled={!state.project}
          icon={<Save className="size-4" />}
        >
          Save
        </ToolButton>
        {state.project && (
          <label
            className="ml-2 flex items-center gap-1 text-xs text-neutral-400"
            title="BCF export: one topic per clash, or one per clash group (all the group's elements selected). Saved in the project."
          >
            BCF topics
            <select
              value={state.project.settings.bcfTopics ?? "clash"}
              onChange={(e) => onBcfTopics(e.target.value === "group" ? "group" : "clash")}
              disabled={state.running}
              className="rounded bg-neutral-800 px-1.5 py-1 text-xs text-neutral-200"
            >
              <option value="clash">per clash</option>
              <option value="group">per group</option>
            </select>
          </label>
        )}
        <ToolButton
          onClick={onRun}
          disabled={!canRun}
          title={blockedReason ?? undefined}
          icon={
            state.running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )
          }
          variant="primary"
        >
          {runButtonText}
        </ToolButton>
      </div>
    </header>
  );
}

/**
 * Live progress bar shown below the top bar while a run is in flight.
 *
 * Closed state: single-line status (rule, percent, elapsed time).
 * Open state: scrollable log of recent engine output lines.
 *
 * We auto-scroll the log to the bottom on each new line so the user
 * always sees the latest activity.
 */
function ProgressBar({ progress }: { progress: RunProgress }) {
  const [expanded, setExpanded] = useState(false);
  const elapsedSec = (Date.now() - progress.startedAt) / 1000;
  const elapsedText =
    elapsedSec < 60
      ? `${elapsedSec.toFixed(0)} s`
      : `${(elapsedSec / 60).toFixed(1)} min`;

  const status = shortStatus(progress);
  const pct = progress.pairs
    ? Math.round((100 * progress.pairs.done) / Math.max(1, progress.pairs.total))
    : null;

  // Auto-scroll the log to the bottom whenever a new line arrives.
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (expanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [expanded, progress.recentLines]);

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/80">
      {/* Top-of-bar fill — width = current rule completion %,
          or an indeterminate pulse before we know. */}
      <div className="relative h-1 w-full overflow-hidden bg-neutral-800">
        {pct !== null ? (
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse bg-emerald-500/50" />
        )}
      </div>
      <div className="flex items-center gap-2 px-4 py-2 text-xs">
        <Loader2 className="size-3 shrink-0 animate-spin text-emerald-400" />
        <span className="flex-1 truncate text-neutral-200" title={status}>
          {status}
        </span>
        <span className="font-mono text-neutral-500">{elapsedText}</span>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          {expanded ? "Hide log" : "Show log"}
        </button>
      </div>
      {expanded && (
        <div
          ref={logRef}
          className="max-h-48 overflow-auto border-t border-neutral-800 bg-neutral-950 px-4 py-2 font-mono text-[11px] text-neutral-400"
        >
          {progress.recentLines.length === 0 ? (
            <div className="italic text-neutral-600">
              Waiting for engine output…
            </div>
          ) : (
            progress.recentLines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {line || " "}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ToolButton({
  children,
  icon,
  onClick,
  disabled,
  variant = "default",
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "primary";
  /** Tooltip — e.g. why a button is disabled. */
  title?: string;
}) {
  const base =
    "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition";
  const styles =
    variant === "primary"
      ? "bg-emerald-700 hover:bg-emerald-600 text-white disabled:bg-neutral-800 disabled:text-neutral-500"
      : "bg-neutral-800 hover:bg-neutral-700 text-neutral-100 disabled:bg-neutral-800 disabled:text-neutral-600";
  return (
    <button
      className={`${base} ${styles}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {children}
    </button>
  );
}

function Sidebar({
  view,
  onSelect,
}: {
  view: View;
  onSelect: (v: View) => void;
}) {
  const items: { v: View; label: string }[] = [
    { v: "files", label: "Files" },
    { v: "rules", label: "Rules" },
    { v: "results", label: "Results" },
  ];
  return (
    <nav className="flex w-44 shrink-0 flex-col border-r border-neutral-800 bg-neutral-925 p-2">
      {items.map((it) => (
        <button
          key={it.v}
          onClick={() => onSelect(it.v)}
          className={`mb-1 rounded px-3 py-2 text-left text-sm transition ${
            view === it.v
              ? "bg-neutral-800 text-white"
              : "text-neutral-300 hover:bg-neutral-800/60"
          }`}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}

function EmptyState({
  onNew,
  onOpen,
}: {
  onNew: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-neutral-400">
      {/* Static drop-target affordance — visible at all times so users see
          drag-and-drop is an option without having to start dragging first. */}
      <div className="flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-neutral-700 bg-neutral-900/50 px-8 py-12 text-center">
        <Upload className="size-10 text-neutral-500" />
        <div className="text-lg text-neutral-200">Drop .ifc files here</div>
        <div className="text-sm">
          Drag one or more IFC models anywhere in the window to start a new
          project, or use the buttons below.
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onNew}
          className="rounded bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
        >
          New project
        </button>
        <button
          onClick={onOpen}
          className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-700"
        >
          Open project…
        </button>
      </div>
    </div>
  );
}
