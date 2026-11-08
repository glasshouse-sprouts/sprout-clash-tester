// Narrow-phase comparison (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase): run the same
// rules with parry and with ifc-lite and count, per rule, the clashes both
// report and those only one of them reports — for side-by-side checks on
// real projects before ifc-lite becomes the default.

import { run } from "./runner.js";
import type { ClashEntry, RunOptions, RunResult } from "./types.js";

/** One rule's agreement between the two narrow phases. */
export interface RuleComparison {
  rule: string;
  both: number;
  onlyParry: number;
  onlyIfclite: number;
  /** ifc-lite: touching pairs / unconfirmed box estimates (not clashes). */
  touch: number;
  unconfirmed: number;
}

export interface NarrowPhaseComparison {
  rules: RuleComparison[];
  parry: RunResult;
  ifclite: RunResult;
}

/** Run `opts` twice — parry, then ifc-lite — without writing a BCF. */
export async function compareNarrowPhases(opts: RunOptions): Promise<NarrowPhaseComparison> {
  const base: RunOptions = { ...opts, outputBcf: undefined, reportTouch: false };
  const parry = await run({ ...base, narrowPhase: "parry" });
  const ifclite = await run({ ...base, narrowPhase: "ifclite" });
  return { rules: diffByRule(parry, ifclite), parry, ifclite };
}

/** Same rule, same two elements (order-independent). */
function pairKey(c: ClashEntry): string {
  const [x, y] = [`${c.fileA}#${c.guidA}`, `${c.fileB}#${c.guidB}`].sort();
  return `${c.rule}\u0000${x}\u0000${y}`;
}

/** Per-rule counts, rules in the order they first appear. Pure. */
export function diffByRule(parry: RunResult, ifclite: RunResult): RuleComparison[] {
  const rules = new Map<string, RuleComparison>();
  const row = (rule: string): RuleComparison => {
    let r = rules.get(rule);
    if (!r) {
      r = { rule, both: 0, onlyParry: 0, onlyIfclite: 0, touch: 0, unconfirmed: 0 };
      rules.set(rule, r);
    }
    return r;
  };
  for (const r of [...parry.perRule, ...ifclite.perRule]) row(r.name);
  const parryKeys = new Set(parry.clashes.map(pairKey));
  const ifcliteKeys = new Set(ifclite.clashes.map(pairKey));
  for (const c of parry.clashes) {
    const r = row(c.rule);
    if (ifcliteKeys.has(pairKey(c))) r.both++;
    else r.onlyParry++;
  }
  for (const c of ifclite.clashes) {
    if (!parryKeys.has(pairKey(c))) row(c.rule).onlyIfclite++;
  }
  for (const r of ifclite.perRule) {
    row(r.name).touch = r.touchCount ?? 0;
    row(r.name).unconfirmed = r.unconfirmedCount ?? 0;
  }
  return [...rules.values()];
}
