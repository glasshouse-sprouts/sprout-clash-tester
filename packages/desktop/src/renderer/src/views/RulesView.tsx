// Rules view — list (with inline edit of custom rules) + add preset,
// self check, or custom rule.

import { useMemo, useState } from "react";
import type { Project, ProjectRule } from "@clash-tester/core/types";
import { addCustomRule, addPresetRule, addSelfCheckRule, PRESET_NAMES } from "../state";
import type { AppState } from "../state";
import { AutoAddPresetsButton } from "./rules/AutoAddPresetsButton";
import { CustomRuleForm } from "./rules/CustomRuleForm";
import { EngineOptions } from "./rules/EngineOptions";
import { RulesTable } from "./rules/RulesTable";
import { SelfCheckSection } from "./rules/SelfCheckSection";

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
        <RulesTable
          project={project}
          realFiles={realFiles}
          editing={editing}
          setEditing={setEditing}
          updateProject={updateProject}
        />
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

      <EngineOptions project={project} updateProject={updateProject} />

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
