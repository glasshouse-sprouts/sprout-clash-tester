// AlignmentPanel — inline panel above the Files table that surfaces the
// engine's fast IFCSITE-origin check. Re-runs (debounced) whenever the
// project's file list / translations change.
//
// The panel shows three states:
//   1. running     — "Checking alignment…"
//   2. one cluster — green, "Files placement looks consistent"
//   3. >1 cluster  — yellow, with per-group breakdown + Sprout · Fragments hint
//
// On <2 files the panel hides itself entirely.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Info, Loader2, RefreshCw } from "lucide-react";
import type { AlignmentResult, Project } from "@clash-tester/core/types";

interface Props {
  project: Project;
}

/**
 * Compute a stable signature for the project's file list. Two renders
 * with the same signature won't re-run the alignment check. Translation
 * is part of the signature because changing a translation should
 * re-cluster.
 */
function fileListSignature(project: Project): string {
  const real = project.files.filter((f) => f.id !== "placeholder");
  return real
    .map((f) => `${f.path}|${(f.translation ?? [0, 0, 0]).join(",")}`)
    .sort()
    .join("\n");
}

export function AlignmentPanel({ project }: Props) {
  const [result, setResult] = useState<AlignmentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signature = useMemo(() => fileListSignature(project), [project]);
  const realFiles = useMemo(
    () => project.files.filter((f) => f.id !== "placeholder"),
    [project],
  );

  /** Debounced auto-run on file-list change. */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Skip when there's nothing meaningful to check.
    if (realFiles.length < 2) {
      setResult(null);
      setError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runCheck();
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  /** Manual trigger — bypasses debounce. */
  async function runCheck(): Promise<void> {
    if (realFiles.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const r = await window.api.checkAlignment({
        files: realFiles.map((f) => ({
          file: f.path,
          translation: f.translation,
        })),
      });
      if (!r.ok) {
        setError(r.error);
        setResult(null);
      } else {
        setResult(r.value);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (realFiles.length < 2) {
    return null; // nothing to check
  }

  if (loading) {
    return (
      <Panel tone="neutral">
        <Loader2 className="size-4 animate-spin" />
        <span>Checking placement…</span>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel tone="red">
        <AlertTriangle className="size-4" />
        <span className="flex-1">
          Couldn't check alignment: <span className="text-xs">{error}</span>
        </span>
        <RecheckButton onClick={runCheck} />
      </Panel>
    );
  }

  if (!result) {
    return null;
  }

  const mismatch = result.clusters.length > 1;
  const mcSplit = result.warnings.find((w) => w.kind === "mapconversion_split");

  return (
    <div className="space-y-2">
      <div
        className={`rounded border p-3 text-sm ${
          mismatch
            ? "border-yellow-700 bg-yellow-950/30 text-yellow-100"
            : "border-emerald-800 bg-emerald-950/30 text-emerald-100"
        }`}
      >
        <div className="flex items-center gap-2">
          {mismatch ? (
            <AlertTriangle className="size-4 shrink-0" />
          ) : (
            <CheckCircle className="size-4 shrink-0" />
          )}
          <span className="flex-1 font-semibold">
            {mismatch
              ? `Files split into ${result.clusters.length} placement groups`
              : `Placement check OK — all ${realFiles.length} files in one group`}
          </span>
          <RecheckButton onClick={runCheck} />
        </div>

        {mismatch && (
          <>
            <ul className="mt-2 space-y-1 text-xs">
              {result.clusters.map((c) => (
                <li key={c.label}>
                  <span className="font-mono">group {c.label}</span> — centre ~(
                  {c.centre.map((n) => n.toFixed(1)).join(", ")}):{" "}
                  <span className="text-yellow-200">{c.files.join(", ")}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-yellow-200/80">
              Your IFCs likely have different Revit "Export Origin" settings
              (Shared Coordinates vs Project Base Point). Open them in{" "}
              <strong>Sprout · Fragments</strong>, align there, then set each
              file's{" "}
              <code className="rounded bg-yellow-900/50 px-1">translation</code>{" "}
              field in the <code>.clashproj</code>. Re-running this panel
              confirms the fix.
            </p>
            <p className="mt-1 text-[10px] text-yellow-300/60">
              This is a fast check based on IFCSITE origins only — the full
              geometry check runs during clash detection.
            </p>
          </>
        )}
      </div>

      {/* Info-level note: IfcMapConversion mismatch. Distinct from
          placement_mismatch because clash detection works correctly
          here — but a georef-aware viewer would show the same set in
          different places. This is the case where "Clash Tester says
          one group, Sprout · Fragments says two" — both apps are right for
          the question they're answering. */}
      {mcSplit && (
        <div className="rounded border border-blue-800 bg-blue-950/30 p-3 text-xs text-blue-100">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="font-semibold">
                Mixed IfcMapConversion across the federation
              </div>
              <p className="whitespace-pre-line">{mcSplit.message}</p>
              <p className="text-blue-200/70">
                If Sprout · Fragments shows these in different placement groups but
                clash detection here finds real overlaps, this is why. Both
                apps are correct — they answer different questions.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function Panel({
  tone,
  children,
}: {
  tone: "neutral" | "red";
  children: React.ReactNode;
}) {
  const style =
    tone === "red"
      ? "border-red-800 bg-red-950/40 text-red-100"
      : "border-neutral-700 bg-neutral-900/40 text-neutral-300";
  return (
    <div className={`flex items-center gap-2 rounded border p-3 text-sm ${style}`}>
      {children}
    </div>
  );
}

function RecheckButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded bg-neutral-800/70 px-2 py-1 text-xs hover:bg-neutral-700/70"
      title="Re-check alignment"
    >
      <RefreshCw className="size-3" />
      Re-check
    </button>
  );
}
