// One-line text for a custom rule's two sides, for the rules table.

interface SideText {
  fileId: string;
  selector?: string;
  mode?: "i" | "e";
  exclude?: string;
}

/** e.g. `ark (*, not IfcSpace|IfcOpening…) × ark (*, not …)`. */
export function describeCustomRule(r: { name: string }): string {
  return describeRuleSides(r, true);
}

/** Same, with long exclude lists written out (for the tooltip). */
export function describeCustomRuleFull(r: { name: string }): string {
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
