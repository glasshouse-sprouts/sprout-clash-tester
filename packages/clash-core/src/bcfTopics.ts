// BCF topics built from clash groups (SPEC §13c). Pure — no I/O.
//
// The engine's `clash bcf --topics <json>` subcommand writes the BCF; this
// module only decides what goes into each topic. The future BCF-API push
// to the task tracker must reuse `groupToTopic` so a group looks the same
// in a file and in the tracker.

import type { ClashGroup, ClashGroupKind } from "./grouping.js";
import type { ClashEntry } from "./types.js";

/** One BCF topic — the JSON shape `clash bcf --topics` reads. */
export interface BcfTopic {
  /** Full title, numbered: `"<n> - <group title>"`. */
  title: string;
  /** Group kind + one line per member clash. */
  description: string;
  /** Point the camera looks at (group centroid), world metres. */
  position: [number, number, number];
  /** Camera location, world metres. */
  camera_eye: [number, number, number];
  /** Every distinct element GUID in the group, in order of appearance. */
  guids: string[];
}

/** BCF topics per clash (engine default) or per group. */
export type BcfTopicsMode = "clash" | "group";

/** Field of view the engine writes into every viewpoint, degrees. */
const FIELD_OF_VIEW_DEG = 65;
/** Camera direction used for single clashes too: down and towards +X/+Y. */
const VIEW_DIR: [number, number, number] = [1 / Math.sqrt(3), 1 / Math.sqrt(3), -1 / Math.sqrt(3)];
/** Single-clash camera distance (5 m back on each axis = 5·√3 m). */
const MIN_CAMERA_DISTANCE = 5 * Math.sqrt(3);
/** Extra room around the members' bounding box, metres. */
const VIEW_MARGIN_METRES = 2;

const KIND_LABEL: Record<ClashGroupKind, string> = {
  duplicate: "Possible double modelling",
  clashGroup: "Clash group (one element, many clashes)",
  pair: "Same element pair",
  area: "Nearby clashes",
};

/**
 * Turn one group into a BCF topic.
 *
 * - Title: `"<n> - " + group.title` — `n` is the group's 1-based position
 *   in the group list (TASKS T2/T4).
 * - Description: group kind, then one line per member clash:
 *   `#<clash number> <rule>: <typeA> (<guidA>) × <typeB> (<guidB>)`.
 * - Camera: aimed at the group centroid along the single-clash direction,
 *   pulled back so the bounding box of the member positions (plus a
 *   margin) fits the 65° field of view; never closer than a single clash.
 * - GUIDs: all distinct elements of all member clashes.
 */
export function groupToTopic(
  group: ClashGroup,
  number: number,
  clashes: readonly ClashEntry[],
): BcfTopic {
  const members = group.clashIndices
    .map((i) => ({ index: i, clash: clashes[i] }))
    .filter((m): m is { index: number; clash: ClashEntry } => m.clash !== undefined);

  const lines = [
    `${KIND_LABEL[group.kind]} — ${members.length} clash${members.length === 1 ? "" : "es"}` +
      `, ${group.pairCount} element pair${group.pairCount === 1 ? "" : "s"}`,
    ...members.map(({ index, clash: c }) => {
      const rule = c.rule ? `${c.rule}: ` : "";
      return `#${c.number ?? index + 1} ${rule}${c.ifcTypeA} (${c.guidA}) × ${c.ifcTypeB} (${c.guidB})`;
    }),
  ];

  const guids: string[] = [];
  const seen = new Set<string>();
  for (const { clash: c } of members) {
    for (const g of [c.guidA, c.guidB]) {
      if (g && !seen.has(g)) {
        seen.add(g);
        guids.push(g);
      }
    }
  }

  const target = group.position;
  const distance = cameraDistance(members.map((m) => m.clash.position));
  const camera_eye: [number, number, number] = [
    target[0] - VIEW_DIR[0] * distance,
    target[1] - VIEW_DIR[1] * distance,
    target[2] - VIEW_DIR[2] * distance,
  ];

  return {
    title: `${number} - ${group.title}`,
    description: lines.join("\n"),
    position: target,
    camera_eye,
    guids,
  };
}

/** All groups as topics, numbered 1..N in group-list order. */
export function groupsToTopics(
  groups: readonly ClashGroup[],
  clashes: readonly ClashEntry[],
): BcfTopic[] {
  return groups.map((g, i) => groupToTopic(g, i + 1, clashes));
}

/**
 * How far back the camera must be for a sphere around the positions'
 * bounding box (half its diagonal + margin) to fit the field of view.
 */
export function cameraDistance(positions: readonly [number, number, number][]): number {
  if (positions.length === 0) return MIN_CAMERA_DISTANCE;
  const span = ([0, 1, 2] as const).map((k) => {
    const values = positions.map((p) => p[k]);
    return Math.max(...values) - Math.min(...values);
  });
  const halfDiagonal = Math.hypot(...span) / 2;
  const radius = halfDiagonal + VIEW_MARGIN_METRES;
  const halfFov = (FIELD_OF_VIEW_DEG / 2) * (Math.PI / 180);
  return Math.max(MIN_CAMERA_DISTANCE, radius / Math.sin(halfFov));
}
