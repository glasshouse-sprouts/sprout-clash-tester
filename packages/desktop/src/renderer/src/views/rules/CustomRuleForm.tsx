// Form for a custom rule — add a new one, or edit one inline.

import { useState } from "react";
import type { CustomRuleFields } from "../../state";

/**
 * Form for a custom rule — used both to add a new rule and to edit an
 * existing one inline. `onSubmit` returns an error message to show, or
 * null on success.
 */
export function CustomRuleForm({
  files,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  files: { id: string; discipline?: string }[];
  initial: CustomRuleFields;
  submitLabel: string;
  onSubmit: (fields: CustomRuleFields) => string | null;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<CustomRuleFields>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof CustomRuleFields) => (v: string) => {
    setF((prev) => ({ ...prev, [k]: v }));
    setError(null);
  };
  // A side in exclude mode ("everything except the selector") is rare and
  // can't be created from this form, but an edit must show it, not hide it.
  const showModeA = initial.aMode === "e";
  const showModeB = initial.bMode === "e";
  const modeSelect = (k: "aMode" | "bMode") => (
    <select
      value={f[k] ?? "i"}
      onChange={(e) => set(k)(e.target.value)}
      className="w-full rounded bg-neutral-800 px-2 py-1 text-xs"
    >
      <option value="i">Include — elements matching the selector</option>
      <option value="e">Exclude — everything except the selector</option>
    </select>
  );
  const fileOptions = (
    <>
      <option value="">(choose)</option>
      {files.map((file) => (
        <option key={file.id} value={file.id}>
          {file.id} — {file.discipline ?? "UNKNOWN"}
        </option>
      ))}
    </>
  );
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <Field label="Name">
        <input
          value={f.name}
          onChange={(e) => set("name")(e.target.value)}
          placeholder="e.g. HVAC vs Structure"
          className="w-full rounded bg-neutral-800 px-2 py-1 text-xs"
        />
      </Field>
      <div />
      <Field label="Side A — file">
        <select
          value={f.aFileId}
          onChange={(e) => set("aFileId")(e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-xs"
        >
          {fileOptions}
        </select>
      </Field>
      <Field label="Side A — selector">
        <input
          value={f.aSelector}
          onChange={(e) => set("aSelector")(e.target.value)}
          placeholder="IfcDuct*"
          className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs"
        />
      </Field>
      {showModeA && (
        <>
          <div />
          <Field label="Side A — mode">{modeSelect("aMode")}</Field>
        </>
      )}
      <div />
      <Field label="Side A — exclude (optional)">
        <input
          value={f.aExclude ?? ""}
          onChange={(e) => set("aExclude")(e.target.value)}
          placeholder="IfcSpace|IfcOpeningElement"
          title="Elements of these types are dropped after the selector. Same syntax: exact, Prefix*, A|B."
          className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="Side B — file">
        <select
          value={f.bFileId}
          onChange={(e) => set("bFileId")(e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-xs"
        >
          {fileOptions}
        </select>
      </Field>
      <Field label="Side B — selector">
        <input
          value={f.bSelector}
          onChange={(e) => set("bSelector")(e.target.value)}
          placeholder="IfcBeam|IfcColumn"
          className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs"
        />
      </Field>
      {showModeB && (
        <>
          <div />
          <Field label="Side B — mode">{modeSelect("bMode")}</Field>
        </>
      )}
      <div />
      <Field label="Side B — exclude (optional)">
        <input
          value={f.bExclude ?? ""}
          onChange={(e) => set("bExclude")(e.target.value)}
          placeholder="IfcSpace|IfcOpeningElement"
          title="Elements of these types are dropped after the selector. Same syntax: exact, Prefix*, A|B."
          className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs"
        />
      </Field>
      <div className="flex items-center gap-2 md:col-span-2">
        <button
          onClick={() => setError(onSubmit(f))}
          className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Cancel
          </button>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}
