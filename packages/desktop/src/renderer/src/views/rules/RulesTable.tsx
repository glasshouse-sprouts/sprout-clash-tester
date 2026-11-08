// The rules table: enable, kind, detail, edit inline, remove.

import { Pencil, Trash2 } from "lucide-react";
import type { Project, ProjectRule } from "@clash-tester/core/types";
import { customRuleFields, removeRule, toggleRule, updateCustomRule } from "../../state";
import { CustomRuleForm } from "./CustomRuleForm";
import { describeCustomRule, describeCustomRuleFull } from "./describeRule";

export function RulesTable({
  project,
  realFiles,
  editing,
  setEditing,
  updateProject,
}: {
  project: Project;
  realFiles: { id: string; discipline?: string }[];
  editing: string | null;
  setEditing: (name: string | null) => void;
  updateProject: (fn: (p: Project) => Project) => void;
}) {
  return (
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
  );
}
