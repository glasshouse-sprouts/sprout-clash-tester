// Desktop MCP edit ops (docs/MCP.md#desktop-live-ui--clash-tester-ui, phase 2). Pure: `(state,
// args) → { state, result }`, built on the same `state.ts` helpers the UI uses,
// so a human and an AI edit go down one code path.
//
// Every successful edit marks the project dirty and records an `AiUndo`
// snapshot; the UI shows "AI changed: <label> — Undo". Nothing is saved
// to disk — there is no save tool.
//
// Two tools need main-process I/O first (App.tsx does it, then calls the
// pure half here): `ui_add_file` (does the path exist?) and
// `ui_auto_add_presets` (preset library lives in main).

import type { AutoAddPresetsResult, Project, ProjectRule } from "@clash-tester/core/types";
import { validateSettings } from "@clash-tester/core/settings";
import {
  addCustomRule,
  addFileToProject,
  addPresetRule,
  addSelfCheckRule,
  customRuleFields,
  dropPlaceholderIfRealFiles,
  emptyProject,
  PRESET_NAMES,
  removeFileFromProject,
  removeRule,
  selfCheckRuleName,
  toggleRule,
  updateCustomRule,
  type AppState,
  type CustomRuleFields,
} from "./state";
import type { OpResult } from "./mcpOps";

type Args = Record<string, unknown>;

export const EDIT_OPS = [
  "ui_remove_file",
  "ui_add_preset_rule",
  "ui_add_self_check",
  "ui_add_custom_rule",
  "ui_update_custom_rule",
  "ui_toggle_rule",
  "ui_remove_rule",
  "ui_set_settings",
] as const;
export type EditOp = (typeof EDIT_OPS)[number];

export function isEditOp(op: string): op is EditOp {
  return (EDIT_OPS as readonly string[]).includes(op);
}

const NOT_SAVED = "Shown in the app with an Undo button. Not saved to disk — the user saves.";

export function applyEditOp(state: AppState, op: EditOp, args: Args): OpResult {
  const project = editableProject(state);
  switch (op) {
    case "ui_remove_file":
      return removeFile(state, project, args);
    case "ui_add_preset_rule":
      return addPreset(state, project, args);
    case "ui_add_self_check":
      return addSelfCheck(state, project, args);
    case "ui_add_custom_rule":
      return addCustom(state, project, args);
    case "ui_update_custom_rule":
      return updateCustom(state, project, args);
    case "ui_toggle_rule":
      return toggle(state, project, args);
    case "ui_remove_rule":
      return remove(state, project, args);
    case "ui_set_settings":
      return setSettings(state, project, args);
  }
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

/** Apply an AI edit: new project, dirty, undo snapshot. */
export function aiEdit(state: AppState, label: string, next: Project, extra: object = {}): OpResult {
  const before = state.project;
  return {
    state: {
      ...state,
      project: next,
      dirty: true,
      aiUndo: { label, before, dirtyBefore: state.dirty, after: next },
    },
    result: { changed: label, ...extra, note: NOT_SAVED },
  };
}

/** True while the last AI edit can still be undone. */
export function canUndoAiEdit(state: AppState): boolean {
  return state.aiUndo !== null && state.project === state.aiUndo.after;
}

/** Restore the project from before the last AI edit (if still current). */
export function undoAiEdit(state: AppState): AppState {
  if (!canUndoAiEdit(state)) return { ...state, aiUndo: null };
  const u = state.aiUndo!;
  return { ...state, project: u.before, dirty: u.dirtyBefore, aiUndo: null };
}

// ─── Guards + args ────────────────────────────────────────────────────────────

function editableProject(state: AppState): Project {
  if (!state.project) {
    throw new Error("No project is open in Clash Tester — ask the user to create (New) or open one.");
  }
  if (state.running) throw new Error("A run is in progress — wait for it to finish, then edit.");
  return state.project;
}

function str(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${name} must be a non-empty string.`);
  return v.trim();
}

function optStr(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${name} must be a string.`);
  return v;
}

function realFileIds(p: Project): string[] {
  return p.files.filter((f) => f.id !== "placeholder").map((f) => f.id);
}

function requireFile(p: Project, id: string): void {
  if (!realFileIds(p).includes(id)) {
    throw new Error(`No file "${id}". Files: ${realFileIds(p).join(", ") || "(none)"}.`);
  }
}

function requireRule(p: Project, name: string): ProjectRule {
  const r = p.rules.find((x) => x.name === name);
  if (!r) throw new Error(`No rule "${name}". Rules: ${p.rules.map((x) => x.name).join(", ") || "(none)"}.`);
  return r;
}

// ─── Files ────────────────────────────────────────────────────────────────────

/** What `window.api.pingPaths` said about the path. */
export interface PathCheck {
  path: string;
  isFile: boolean;
  isIfc: boolean;
}

/**
 * `ui_add_file`, after main checked the path. Discipline guessed from the
 * file name like drag-and-drop when not given.
 */
export function addFileChecked(state: AppState, args: Args, check: PathCheck): OpResult {
  // Like a drop on an empty window: no project yet ⇒ start a new one
  // (Undo removes it again).
  if (state.running) throw new Error("A run is in progress — wait for it to finish, then edit.");
  const project = state.project ?? emptyProject();
  const filePath = str(args, "path");
  const discipline = optStr(args, "discipline");
  if (!check.isFile) throw new Error(`No file at ${filePath}.`);
  if (!check.isIfc) throw new Error(`${filePath} is not an .ifc file.`);
  if (project.files.some((f) => f.path === filePath)) {
    throw new Error(`${filePath} is already in the project.`);
  }
  // Same as a drop: the placeholder goes once a real file is in.
  const next = dropPlaceholderIfRealFiles(
    addFileToProject(project, filePath, discipline?.trim() || undefined),
  );
  const added = next.files[next.files.length - 1]!;
  const label = state.project ? `added file ${added.id}` : `started a new project with file ${added.id}`;
  return aiEdit({ ...state, view: state.project ? state.view : "files" }, label, next, {
    file: { id: added.id, discipline: added.discipline ?? null, path: added.path },
  });
}

function removeFile(state: AppState, project: Project, args: Args): OpResult {
  const id = str(args, "id");
  requireFile(project, id);
  const next = removeFileFromProject(project, id);
  const removedRules = project.rules.filter((r) => !next.rules.includes(r)).map((r) => r.name);
  return aiEdit(state, `removed file ${id}`, next, { removedRules });
}

// ─── Rules ────────────────────────────────────────────────────────────────────

function addPreset(state: AppState, project: Project, args: Args): OpResult {
  const preset = str(args, "preset");
  if (!(PRESET_NAMES as readonly string[]).includes(preset)) {
    throw new Error(`Unknown preset "${preset}". Presets: ${PRESET_NAMES.join(", ")}.`);
  }
  if (project.rules.some((r) => r.name === preset)) throw new Error(`A rule called "${preset}" already exists.`);
  return aiEdit(state, `added preset rule ${preset}`, addPresetRule(project, preset));
}

/** `ui_auto_add_presets`, after main ran `autoAddPresets`. */
export function applyAutoAddPresets(state: AppState, r: AutoAddPresetsResult): OpResult {
  editableProject(state);
  if (r.added.length === 0) {
    return {
      state,
      result: {
        changed: null,
        reason:
          r.disciplinesSeen.length < 2
            ? `No applicable presets — only ${r.disciplinesSeen.length} discipline(s) tagged (${r.disciplinesSeen.join(", ") || "none"}).`
            : "All applicable presets are already in the rules.",
      },
    };
  }
  return aiEdit(state, `added presets ${r.added.join(", ")}`, r.project, { added: r.added });
}

function addSelfCheck(state: AppState, project: Project, args: Args): OpResult {
  const fileId = str(args, "fileId");
  requireFile(project, fileId);
  const ignore = args.ignoreSpacesAndOpenings;
  if (ignore !== undefined && typeof ignore !== "boolean") {
    throw new Error("ignoreSpacesAndOpenings must be true or false.");
  }
  const name = selfCheckRuleName(fileId);
  if (project.rules.some((r) => r.name === name)) throw new Error(`A rule called "${name}" already exists.`);
  const next = addSelfCheckRule(project, fileId, { ignoreSpacesAndOpenings: ignore ?? true });
  return aiEdit(state, `added self check ${name}`, next, { rule: name });
}

interface SideArgs {
  fileId?: string;
  selector?: string;
  mode?: "i" | "e";
  exclude?: string;
}

function side(args: Args, key: "a" | "b", required: boolean): SideArgs {
  const v = args[key];
  if (v === undefined && !required) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${key} must be an object.`);
  const s = v as Args;
  const out: SideArgs = {};
  if (s.fileId !== undefined) out.fileId = str(s, "fileId");
  else if (required) throw new Error(`${key}.fileId must be a non-empty string.`);
  if (s.selector !== undefined) out.selector = optStr(s, "selector");
  if (s.exclude !== undefined) out.exclude = optStr(s, "exclude");
  if (s.mode !== undefined) {
    if (s.mode !== "i" && s.mode !== "e") throw new Error(`${key}.mode must be "i" or "e".`);
    out.mode = s.mode;
  }
  return out;
}

function addCustom(state: AppState, project: Project, args: Args): OpResult {
  const name = str(args, "name");
  const a = side(args, "a", true);
  const b = side(args, "b", true);
  if (project.rules.some((r) => r.name === name)) throw new Error(`A rule called "${name}" already exists.`);
  requireFile(project, a.fileId!);
  requireFile(project, b.fileId!);
  let next = addCustomRule(
    project,
    name,
    a.fileId!,
    a.selector?.trim() || "*",
    b.fileId!,
    b.selector?.trim() || "*",
    { aExclude: a.exclude, bExclude: b.exclude },
  );
  // Rare "everything except" mode: same path as editing the rule.
  if (a.mode === "e" || b.mode === "e") {
    const fields = customRuleFields(next.rules[next.rules.length - 1]!)!;
    next = updateCustomRule(next, name, { ...fields, aMode: a.mode ?? "i", bMode: b.mode ?? "i" }).project!;
  }
  return aiEdit(state, `added custom rule ${name}`, next, { rule: name });
}

function updateCustom(state: AppState, project: Project, args: Args): OpResult {
  const name = str(args, "name");
  const current = customRuleFields(requireRule(project, name));
  if (!current) throw new Error("Preset rules can't be edited — add a custom rule instead.");
  const a = side(args, "a", false);
  const b = side(args, "b", false);
  const newName = optStr(args, "newName");
  const fields: CustomRuleFields = {
    name: newName ?? current.name,
    aFileId: a.fileId ?? current.aFileId,
    aSelector: a.selector ?? current.aSelector,
    bFileId: b.fileId ?? current.bFileId,
    bSelector: b.selector ?? current.bSelector,
    aMode: a.mode,
    bMode: b.mode,
    aExclude: a.exclude,
    bExclude: b.exclude,
  };
  const res = updateCustomRule(project, name, fields);
  if (res.error !== undefined) throw new Error(res.error);
  return aiEdit(state, `edited rule ${fields.name.trim()}`, res.project, { rule: fields.name.trim() });
}

function toggle(state: AppState, project: Project, args: Args): OpResult {
  const name = str(args, "name");
  const rule = requireRule(project, name);
  const enabled = args.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled must be true or false.");
  const isEnabled = rule.enabled !== false;
  const want = enabled ?? !isEnabled;
  if (want === isEnabled) {
    return { state, result: { changed: null, reason: `Rule ${name} is already ${want ? "enabled" : "disabled"}.` } };
  }
  return aiEdit(state, `${want ? "enabled" : "disabled"} rule ${name}`, toggleRule(project, name));
}

function remove(state: AppState, project: Project, args: Args): OpResult {
  const name = str(args, "name");
  requireRule(project, name);
  return aiEdit(state, `removed rule ${name}`, removeRule(project, name));
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTING_KEYS = [
  "toleranceMeters",
  "minPenetrationMeters",
  "grouping",
  "bcfTopics",
  "skipRelatedElements",
  "narrowPhase",
  "reportTouch",
] as const;

function setSettings(state: AppState, project: Project, args: Args): OpResult {
  const given = SETTING_KEYS.filter((k) => args[k] !== undefined);
  if (given.length === 0) throw new Error(`Pass at least one of ${SETTING_KEYS.join(", ")}.`);
  const merged: Args = { ...project.settings };
  for (const k of given) merged[k] = args[k];
  const { settings, issues } = validateSettings(merged);
  if (issues.length > 0) throw new Error(issues.join("; "));
  // Per clash is the default — stored by leaving the key out (as the UI does).
  if (settings.bcfTopics === "clash") delete settings.bcfTopics;
  // Relation skip on is the default — likewise stored by leaving it out.
  if (settings.skipRelatedElements === true) delete settings.skipRelatedElements;
  // Parry and no touch listing are the defaults too.
  if (settings.narrowPhase === "parry") delete settings.narrowPhase;
  if (settings.reportTouch === false) delete settings.reportTouch;
  return aiEdit(state, `changed settings (${given.join(", ")})`, { ...project, settings }, { settings });
}
