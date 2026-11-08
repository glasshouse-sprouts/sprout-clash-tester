// Pretty output for `clashtester run --compare-narrow-phase` (SPEC §13g).

import type { RuleComparison } from "@clash-tester/core";

/** One line per rule plus a total: both / only parry / only ifc-lite. */
export function formatComparison(rules: RuleComparison[]): string {
  const width = Math.max(4, ...rules.map((r) => r.rule.length));
  const n = (v: number, w: number) => String(v).padStart(w);
  const line = (name: string, r: Omit<RuleComparison, "rule">) =>
    `  ${name.padEnd(width)}  ${n(r.both, 5)}  ${n(r.onlyParry, 11)}  ` +
    `${n(r.onlyIfclite, 14)}  ${n(r.touch, 5)}  ${n(r.unconfirmed, 11)}`;
  const total = rules.reduce(
    (t, r) => ({
      both: t.both + r.both,
      onlyParry: t.onlyParry + r.onlyParry,
      onlyIfclite: t.onlyIfclite + r.onlyIfclite,
      touch: t.touch + r.touch,
      unconfirmed: t.unconfirmed + r.unconfirmed,
    }),
    { both: 0, onlyParry: 0, onlyIfclite: 0, touch: 0, unconfirmed: 0 },
  );
  return [
    `  ${"Rule".padEnd(width)}   both  only parry  only ifc-lite  touch  unconfirmed`,
    ...rules.map((r) => line(r.rule, r)),
    line("Total", total),
    "",
    "touch / unconfirmed: ifc-lite pairs that are not clashes (faces only touching;",
    "hard by box estimate without a surface crossing).",
  ].join("\n");
}
