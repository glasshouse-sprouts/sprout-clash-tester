// Derived from Clashero (MIT). See NOTICE.
//! The file's active length unit and its scale to metres
//! (docs/HOW-IT-WORKS.md#coordinates-and-units).

use super::step_text::{build_entity_map, parse_entity_ref, step_nth_arg};

/// Reads the IFCUNITASSIGNMENT from an IFC file and returns the length unit
/// name string (e.g. "millimetre", "metre") for the **active** length unit.
/// Falls back to "metre" if the chain cannot be resolved.
pub fn extract_active_length_unit_from_str(content: &str) -> String {
    let map = build_entity_map(content);

    // Find IFCUNITASSIGNMENT body
    let ua_body = match map.values().find(|v| v.trim_start().starts_with("IFCUNITASSIGNMENT(")) {
        Some(b) => b.clone(),
        None => return "metre".to_string(),
    };

    // Arg 0 is a parenthesised list of entity refs: (#48,#49,#50,...)
    let list_str = match step_nth_arg(&ua_body, 0) {
        Some(s) => s,
        None => return "metre".to_string(),
    };

    // Strip outer parens
    let inner = list_str.trim();
    let inner = if inner.starts_with('(') && inner.ends_with(')') {
        &inner[1..inner.len() - 1]
    } else {
        inner
    };

    for part in inner.split(',') {
        let part = part.trim();
        if let Some(id) = parse_entity_ref(part) {
            if let Some(body) = map.get(&id) {
                if body.trim_start().starts_with("IFCSIUNIT(") {
                    // Arg 1 is the unit type enum, e.g. .LENGTHUNIT.
                    if let Some(unit_type) = step_nth_arg(body, 1) {
                        if unit_type.trim() == ".LENGTHUNIT." {
                            // Arg 2 is prefix (.MILLI., .CENTI., .DECI., or $)
                            // Arg 3 is name (.METRE., .INCH., .FOOT., …)
                            let prefix = step_nth_arg(body, 2).unwrap_or_default();
                            let name   = step_nth_arg(body, 3).unwrap_or_default();
                            let combined = format!("{}{}", prefix.trim(), name.trim()).to_lowercase();
                            // Normalise to the strings `unit_scale_metres_per` expects
                            return if combined.contains("milli") {
                                "millimetre".to_string()
                            } else if combined.contains("centi") {
                                "centimetre".to_string()
                            } else if combined.contains("deci") {
                                "decimetre".to_string()
                            } else if combined.contains("inch") {
                                "inch".to_string()
                            } else if combined.contains("foot") || combined.contains("feet") {
                                "foot".to_string()
                            } else {
                                "metre".to_string()
                            };
                        }
                    }
                }
            }
        }
    }

    "metre".to_string()
}

/// Metres per one unit of `unit` (a name from
/// `extract_active_length_unit_from_str`). The loader multiplies every
/// mesh by this once, so the engine works in metres throughout
/// (docs/HOW-IT-WORKS.md#coordinates-and-units). Unknown names count as metres.
pub fn unit_scale_metres_per(unit: &str) -> f64 {
    match unit {
        "millimetre" => 0.001,
        "centimetre" => 0.01,
        "decimetre" => 0.1,
        "meter" | "metre" => 1.0,
        "inch" => 0.0254,
        "foot" => 0.3048,
        _ => 1.0,
    }
}
