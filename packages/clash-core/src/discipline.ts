// Discipline inference from filename.
//
// Pure function — no Node APIs, safe to import from the renderer.
// Filename-only heuristic, same shape as Clashero's MCP server uses,
// extended with Danish AEC abbreviations (ARK, KON, VVS, BRAND, TERR).
//
// Order matters: more specific patterns win over less specific ones.
// Architecture sub-disciplines (ARCH_CONTEXT, ARCH_FURNITURE) are
// checked before plain ARCH so a file called "ArchFurniture.ifc"
// resolves to ARCH_FURNITURE rather than ARCH.

/**
 * The disciplines we recognise. Stable strings — the preset library
 * and `.clashproj` schema use these too.
 */
export type Discipline =
  | "ARCH"
  | "ARCH_CONTEXT"
  | "ARCH_FURNITURE"
  | "STR"
  | "MEP"
  | "HVAC"
  | "ELEC"
  | "FIRE"
  | "GEO"
  | "UNKNOWN";

/**
 * Infer a discipline from a file path or filename.
 *
 * The matching strategy:
 *
 * - Strip to the basename and uppercase.
 * - Replace every non-alphanumeric character with `_` and pad the
 *   string with `_` on both ends — so "Building-Hvac.ifc" becomes
 *   "_BUILDING_HVAC_IFC_". This lets us check for tokens at word
 *   boundaries with a simple `includes("_TOKEN_")`.
 * - Long, distinctive tokens (ARCH, HVAC, STRUC, ...) match anywhere
 *   in the string. Short tokens that could collide with unrelated
 *   words (EL, STR, ARK, VVS) only match when surrounded by
 *   separators — so `MODEL.ifc` is never mis-classified as electrical.
 *
 * If no rule matches, returns `"UNKNOWN"`. Callers should treat that
 * as "ask the user" — never assume.
 */
export function inferDisciplineFromFilename(filePath: string): Discipline {
  const basename = filePath.split(/[\\/]/).pop() ?? "";
  // Padded, separator-normalised, uppercase form. The padding makes
  // `_TOKEN_` matches work even when the token is the first/last word.
  const padded =
    "_" + basename.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_";

  /**
   * Substring check — use for tokens long/distinctive enough that a
   * false positive against an unrelated word is very unlikely
   * (ARCH, HVAC, STRUC, ELECTR, ...).
   */
  const sub = (...needles: string[]): boolean =>
    needles.some((n) => padded.includes(n));

  /**
   * Boundary-aware token check — use for short tokens that could
   * appear inside unrelated words (EL, STR, MEP, KON, ARK, ...).
   * Matches when the token is wrapped by underscores.
   */
  const tok = (...tokens: string[]): boolean =>
    tokens.some((t) => padded.includes(`_${t}_`));

  // ── Architecture sub-disciplines — checked first so they win ──
  if (sub("ARCH") && sub("CONTEXT")) return "ARCH_CONTEXT";
  if (sub("ARCH") && sub("FURN")) return "ARCH_FURNITURE";

  // ── Main disciplines, in roughly "most common first" order ──
  if (sub("ARCH") || tok("ARK")) return "ARCH";
  if (sub("STRUC", "STRUCT") || tok("STR", "KON")) return "STR";
  if (sub("HVAC") || tok("VENT", "VEN", "AIR")) return "HVAC";
  if (sub("PLUMB", "SANIT", "PIPE") || tok("MEP", "VVS")) return "MEP";
  if (sub("ELECTR") || tok("ELEC", "ELE", "EL")) return "ELEC";
  // FIRE is distinctive enough to match anywhere (FIREWALL, FIREPROOF,
  // FIREPROTECTION are all fire-related). BRAND is the Danish word for
  // fire — keep boundary-only since plain "BRAND" appears in lots of
  // unrelated contexts (brand names, brandnew, …).
  if (sub("FIRE", "SPRINK") || tok("BRAND")) return "FIRE";
  if (sub("LANDSC") || tok("GEO", "SITE", "TERR", "TERRAIN")) return "GEO";

  return "UNKNOWN";
}
