// Derived from Clashero (MIT). See NOTICE.
//! Reads straight from the IFC STEP text, no geometry pass: the IFCSITE
//! origin, IFCMAPCONVERSION, and the small STEP parsing helpers.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

// ── Site origin extraction ────────────────────────────────────────────────────

/// Reads an IFC file and returns the IFCSITE world origin in millimetres [x, y, z].
/// Returns [0, 0, 0] if the site placement cannot be found.
///
/// Follows the chain:
///   IFCSITE.ObjectPlacement (#ref)
///   → IFCLOCALPLACEMENT.RelativePlacement (#ref)
///   → IFCAXIS2PLACEMENT3D.Location (#ref)
///   → IFCCARTESIANPOINT.Coordinates ([x, y, z])
pub fn extract_site_origin_mm<P: AsRef<Path>>(path: P) -> [f64; 3] {
    let content = match fs::read_to_string(path.as_ref()) {
        Ok(c) => c,
        Err(_) => return [0.0, 0.0, 0.0],
    };
    extract_site_origin_from_str(&content)
}

/// Same as `extract_site_origin_mm` but operates on an already-loaded string.
pub fn extract_site_origin_from_str(content: &str) -> [f64; 3] {
    // Build a map: entity_id -> entity body text (everything after the '=' minus trailing ';')
    let mut map: HashMap<u32, String> = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('#') {
            if let Some(eq_pos) = rest.find('=') {
                if let Ok(id) = rest[..eq_pos].trim().parse::<u32>() {
                    let body = rest[eq_pos + 1..].trim().trim_end_matches(';').to_string();
                    map.insert(id, body);
                }
            }
        }
    }

    // Find IFCSITE entity. There's typically only one in a well-formed
    // IFC, but some files have placeholder/empty IFCSITEs alongside the
    // real one. Iterate by sorted entity id so the same file always
    // returns the same site — Rust's HashMap has randomised iteration
    // order, so `map.values().find(...)` was non-deterministic across runs.
    let mut sorted_ids: Vec<u32> = map.keys().copied().collect();
    sorted_ids.sort();
    let site_body = match sorted_ids
        .iter()
        .filter_map(|id| map.get(id))
        .find(|v| v.trim_start().starts_with("IFCSITE("))
    {
        Some(b) => b.clone(),
        None => return [0.0, 0.0, 0.0],
    };

    // Arg 5 (0-indexed) of IFCSITE is ObjectPlacement
    let placement_id = match step_nth_arg(&site_body, 5).and_then(|s| parse_entity_ref(&s)) {
        Some(id) => id,
        None => return [0.0, 0.0, 0.0],
    };

    // IFCLOCALPLACEMENT — arg 1 is RelativePlacement
    let lp_body = match map.get(&placement_id) {
        Some(b) => b.clone(),
        None => return [0.0, 0.0, 0.0],
    };
    let axis_id = match step_nth_arg(&lp_body, 1).and_then(|s| parse_entity_ref(&s)) {
        Some(id) => id,
        None => return [0.0, 0.0, 0.0],
    };

    // IFCAXIS2PLACEMENT3D — arg 0 is Location
    let ap_body = match map.get(&axis_id) {
        Some(b) => b.clone(),
        None => return [0.0, 0.0, 0.0],
    };
    let point_id = match step_nth_arg(&ap_body, 0).and_then(|s| parse_entity_ref(&s)) {
        Some(id) => id,
        None => return [0.0, 0.0, 0.0],
    };

    // IFCCARTESIANPOINT — arg 0 is the coordinate list e.g. "(-289840.,137899.,40800.)"
    let cp_body = match map.get(&point_id) {
        Some(b) => b.clone(),
        None => return [0.0, 0.0, 0.0],
    };
    let coord_list = match step_nth_arg(&cp_body, 0) {
        Some(s) => s,
        None => return [0.0, 0.0, 0.0],
    };

    // Strip outer parens from "(-289840.,137899.,40800.)"
    let inner = coord_list.trim();
    let inner = if inner.starts_with('(') && inner.ends_with(')') {
        &inner[1..inner.len() - 1]
    } else {
        inner
    };

    let coords: Vec<f64> = inner
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();

    match coords.len() {
        n if n >= 3 => [coords[0], coords[1], coords[2]],
        2 => [coords[0], coords[1], 0.0],
        _ => [0.0, 0.0, 0.0],
    }
}

/// Parse the nth argument (0-indexed) from a STEP entity string.
/// Correctly handles nested parentheses and single-quoted string literals.
pub(super) fn step_nth_arg(entity: &str, n: usize) -> Option<String> {
    let paren_start = entity.find('(')?;
    let inner = &entity[paren_start + 1..];

    let mut depth = 0i32;
    let mut in_str = false;
    let mut cur = String::new();
    let mut idx: usize = 0;

    for ch in inner.chars() {
        if in_str {
            cur.push(ch);
            if ch == '\'' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '\'' => {
                in_str = true;
                cur.push(ch);
            }
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                if depth == 0 {
                    if idx == n {
                        return Some(cur.trim().to_string());
                    }
                    break;
                }
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => {
                if idx == n {
                    return Some(cur.trim().to_string());
                }
                idx += 1;
                cur = String::new();
            }
            _ => cur.push(ch),
        }
    }
    None
}

/// Parse a STEP entity reference like "#190" into its numeric ID.
pub(super) fn parse_entity_ref(s: &str) -> Option<u32> {
    s.trim().strip_prefix('#')?.trim().parse().ok()
}

/// Build a minimal entity-id → body map from raw IFC STEP text.
pub(super) fn build_entity_map(content: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('#') {
            if let Some(eq_pos) = rest.find('=') {
                if let Ok(id) = rest[..eq_pos].trim().parse::<u32>() {
                    let body = rest[eq_pos + 1..].trim().trim_end_matches(';').to_string();
                    map.insert(id, body);
                }
            }
        }
    }
    map
}

/// Map-conversion data scraped from an `IFCMAPCONVERSION` entity, when
/// present. Used by the alignment pre-check to detect "mixed export
/// origin" cases (one file shipped with georeferencing, another not).
///
/// Eastings / northings / orthogonal height are stored as written in
/// the IFC — typically metres (the target CRS unit), but the IFC spec
/// doesn't strictly require this. For our purposes we just compare
/// "present vs not" and "values broadly equal vs not" between files,
/// so unit ambiguity at the margin is acceptable.
#[derive(Debug, Clone, PartialEq)]
pub struct MapConversion {
    pub eastings: f64,
    pub northings: f64,
    pub orthogonal_height: f64,
}

/// Returns the first IFCMAPCONVERSION entity's data, or None.
///
/// Mirrors the deterministic-iteration approach used by
/// `extract_site_origin_from_str`: keys are sorted before searching
/// so the same file always yields the same answer.
pub fn extract_map_conversion_from_str(content: &str) -> Option<MapConversion> {
    let map = build_entity_map(content);
    let mut sorted_ids: Vec<u32> = map.keys().copied().collect();
    sorted_ids.sort();
    let mc_body = sorted_ids
        .iter()
        .filter_map(|id| map.get(id))
        .find(|v| v.trim_start().starts_with("IFCMAPCONVERSION("))?;
    // IFC4 schema (0-indexed args after the entity name):
    //   0: SourceCRS (ref)
    //   1: TargetCRS (ref)
    //   2: Eastings (REAL)
    //   3: Northings (REAL)
    //   4: OrthogonalHeight (REAL)
    //   5: XAxisAbscissa (optional)
    //   6: XAxisOrdinate (optional)
    //   7: Scale (optional)
    let parse_real = |idx: usize| -> Option<f64> {
        let s = step_nth_arg(mc_body, idx)?;
        s.trim().parse::<f64>().ok()
    };
    Some(MapConversion {
        eastings: parse_real(2).unwrap_or(0.0),
        northings: parse_real(3).unwrap_or(0.0),
        orthogonal_height: parse_real(4).unwrap_or(0.0),
    })
}
