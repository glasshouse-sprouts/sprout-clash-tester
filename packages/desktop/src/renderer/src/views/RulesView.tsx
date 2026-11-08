// Rules view — list (with inline edit of custom rules) + add preset,
// self check, or custom rule.

import { useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Project, ProjectRule } from "@clash-tester/core/types";
import {
  addCustomRule,
  addPresetRule,
  addSelfCheckRule,
  customRuleFields,
  removeRule,
  selfCheckRuleName,
  toggleRule,
  updateCustomRule,
  PRESET_NAMES,
  setNarrowPhase,
  setReportTouch,
  setSkipRelatedElements,
  type CustomRuleFields,
} from "../state";
import type { AppState } from "../state";

interface Props {
  state: AppState;
  patch: (fn: (prev: AppState) => AppState) => void;
}

export function RulesView({ state, patch }: Props) {
  const project = state.project;
  const [draftPreset, setDraftPreset] = useState<string>(PRESET_NAMES[0]);
  // Name of the custom rule being edited inline, or null.
  const [editing, setEditing] = useState<string | null>(null);

  const realFiles = useMemo(
    () => project?.files.filter((f) => f.id !== "placeholder") ?? [],
    [project],
  );

  if (!project) return null;

  const updateProject = (fn: (p: Project) => Project) =>
    patch((s) => (s.project ? { ...s, project: fn(s.project), dirty: true } : s));

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Rules</h2>
        <span className="text-xs text-neutral-400">
          {project.rules.length} rule{project.rules.length === 1 ? "" : "s"}
        </span>
      </header>

      {project.rules.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-700 px-6 py-8 text-center text-sm text-neutral-400">
          No rules yet. Add a preset, a self check or a custom rule below.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="w-8 py-2 font-normal"></th>
              <th className="py-2 pr-2 font-normal">Name</th>
              <th className="py-2 pr-2 font-normal">Kind</th>
              <th className="py-2 pr-2 font-normal">Detail</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {project.rules.map((r: ProjectRule) => {
              const enabled = r.enabled !== false;
              const fields = customRuleFields(r);
              const isPreset = fields === null;
              if (editing === r.name && fields) {
                return (
                  <tr key={r.name} className="border-b border-neutral-900">
                    <td colSpan={5} className="py-2">
                      <CustomRuleForm
                        files={realFiles}
                        initial={fields}
                        submitLabel="Save changes"
                        onCancel={() => setEditing(null)}
                        onSubmit={(next) => {
                          const res = updateCustomRule(project, r.name, next);
                          if (res.error !== undefined) return res.error;
                          updateProject(() => res.project);
                          setEditing(null);
                          return null;
                        }}
                      />
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={r.name} className="border-b border-neutral-900">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => updateProject((p) => toggleRule(p, r.name))}
                    />
                  </td>
                  <td className="py-2 pr-2 font-mono text-xs">{r.name}</td>
                  <td className="py-2 pr-2 text-xs">
                    {isPreset ? (
                      <span className="rounded bg-blue-900 px-2 py-0.5">preset</span>
                    ) : fields.aFileId === fields.bFileId ? (
                      <span className="rounded bg-emerald-900 px-2 py-0.5">self check</span>
                    ) : (
                      <span className="rounded bg-neutral-800 px-2 py-0.5">custom</span>
                    )}
                  </td>
                  <td
                    className="py-2 pr-2 font-mono text-xs text-neutral-400"
                    title={isPreset ? undefined : describeCustomRuleFull(r)}
                  >
                    {isPreset
                      ? `preset: ${(r as { preset: string }).preset}`
                      : describeCustomRule(r)}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {!isPreset && (
                      <button
                        onClick={() => setEditing(r.name)}
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                        title="Edit rule"
                      >
                        <Pencil className="size-4" />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (editing === r.name) setEditing(null);
                        updateProject((p) => removeRule(p, r.name));
                      }}
                      className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
                      title="Remove rule"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Add a preset rule</h3>
          <AutoAddPresetsButton project={project} updateProject={updateProject} />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={draftPreset}
            onChange={(e) => setDraftPreset(e.target.value)}
            className="rounded bg-neutral-800 px-2 py-1 text-xs"
          >
            {PRESET_NAMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (project.rules.some((r: ProjectRule) => r.name === draftPreset)) return;
              updateProject((p) => addPresetRule(p, draftPreset));
            }}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600"
          >
            Add
          </button>
          <span className="text-xs text-neutral-400">
            Presets expand against files by discipline (see Files view).
          </span>
        </div>
      </section>

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

      <SelfCheckSection
        files={realFiles}
        existingRuleNames={project.rules.map((r: ProjectRule) => r.name)}
        onAdd={(fileId, ignoreSpacesAndOpenings) =>
          updateProject((p) => addSelfCheckRule(p, fileId, { ignoreSpacesAndOpenings }))
        }
      />

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-900/50 p-4">
        <h3 className="text-sm font-semibold">Add a custom rule</h3>
        {realFiles.length === 0 ? (
          <div className="text-xs text-neutral-400">
            Add at least one file in the Files view. (Picking the same file
            on both sides checks a model against itself.)
          </div>
        ) : (
          <CustomRuleForm
            // Re-mount after each add so the form resets.
            key={project.rules.length}
            files={realFiles}
            initial={{
              name: "",
              aFileId: "",
              aSelector: "*",
              bFileId: "",
              bSelector: "*",
              aExclude: "",
              bExclude: "",
            }}
            submitLabel="Add custom rule"
            onSubmit={(f) => {
              if (!f.name.trim()) return "Give the rule a name.";
              if (!f.aFileId || !f.bFileId) return "Choose a file for both sides.";
              if (project.rules.some((r: ProjectRule) => r.name === f.name.trim())) {
                return `A rule called "${f.name.trim()}" already exists.`;
              }
              updateProject((p) =>
                addCustomRule(
                  p,
                  f.name.trim(),
                  f.aFileId,
                  f.aSelector.trim() || "*",
                  f.bFileId,
                  f.bSelector.trim() || "*",
                  { aExclude: f.aExclude, bExclude: f.bExclude },
                ),
              );
              return null;
            }}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Form for a custom rule — used both to add a new rule and to edit an
 * existing one inline. `onSubmit` returns an error message to show, or
 * null on success.
 */
function CustomRuleForm({
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
function AutoAddPresetsButton({
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

/**
 * "Self check" — a model tested against itself (SPEC §13b). Finds internal
 * clashes and double modelling. One click adds `SELF-<fileId>` with the
 * same file on both sides and all element types.
 */
function SelfCheckSection({
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

interface SideText {
  fileId: string;
  selector?: string;
  mode?: "i" | "e";
  exclude?: string;
}

/** e.g. `ark (*, not IfcSpace|IfcOpening…) × ark (*, not …)`. */
function describeCustomRule(r: { name: string }): string {
  return describeRuleSides(r, true);
}

/** Same, with long exclude lists written out (for the tooltip). */
function describeCustomRuleFull(r: { name: string }): string {
  return describeRuleSides(r, false);
}

function describeRuleSides(r: { name: string }, shorten: boolean): string {
  const x = r as { a?: SideText; b?: SideText };
  if (!x.a || !x.b) return "(incomplete)";
  return `${describeSide(x.a, shorten)} × ${describeSide(x.b, shorten)}`;
}

function describeSide(s: SideText, shorten: boolean): string {
  const sel = s.selector ?? "*";
  const parts = [s.mode === "e" ? `all but ${sel}` : sel];
  if (s.exclude) {
    const ex = shorten && s.exclude.length > 22 ? `${s.exclude.slice(0, 21)}…` : s.exclude;
    parts.push(`not ${ex}`);
  }
  return `${s.fileId} (${parts.join(", ")})`;
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
