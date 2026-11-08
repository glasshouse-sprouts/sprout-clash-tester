// Derived from Clashero (MIT). See NOTICE.
use anyhow::{Context, Result};
use ifc_lite_core::decoder::EntityDecoder;
use ifc_lite_core::{AttributeValue, EntityScanner};
use ifc_lite_core::limits::RtcVerdict;
use ifc_lite_geometry::GeometryRouter;
use crate::opening_cuts::{OpeningCutStats, check_cuts, mesh_element, void_map};
use crate::type_objects::{
    OCCURRENCE_PREDEFINED_TYPE_ATTR, apply_type_objects, is_generic_distribution_class,
    predefined_enum,
};
use parry3d_f64::math::Vector as Point;
use parry3d_f64::shape::TriMesh;
use std::collections::{HashMap, HashSet};
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
fn step_nth_arg(entity: &str, n: usize) -> Option<String> {
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
fn parse_entity_ref(s: &str) -> Option<u32> {
    s.trim().strip_prefix('#')?.trim().parse().ok()
}

/// Build a minimal entity-id → body map from raw IFC STEP text.
fn build_entity_map(content: &str) -> HashMap<u32, String> {
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
                            // Normalise to the strings expected by lib.rs
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
/// mesh by this once, so the engine works in metres throughout (SPEC §4).
/// Unknown names count as metres.
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

/// Represents basic metadata extracted from an IFC element.
#[derive(Debug, Clone, PartialEq)]
pub struct IfcMetadata {
    pub guid: String,
    pub ifc_type: String,
    pub discipline: String,
    pub properties: HashMap<String, String>,
    pub length_unit: String,
    /// Source file basename (no directory). Set by `load_ifc_elements`
    /// after metadata extraction; empty when constructed elsewhere
    /// (e.g. test fixtures).
    pub source_file: String,
    /// The class read off the type object when the occurrence is a
    /// generic distribution class (IFC2X3 style): an `IfcFlowSegment`
    /// typed by `IfcDuctSegmentType` is an `IfcDuctSegment`. `None` when
    /// the occurrence class already says what the element is (SPEC §6).
    pub type_class: Option<String>,
    /// `PredefinedType` of the occurrence, else of its type object;
    /// `None` when absent or `NOTDEFINED`. Shown, not matched on.
    pub predefined_type: Option<String>,
}

/// Represents an extracted IFC element with its geometry and metadata.
#[derive(Clone)]
pub struct IfcElement {
    pub metadata: IfcMetadata,
    pub mesh: TriMesh,
}

/// A property's NominalValue as plain text, e.g. `IFCBOOLEAN(.T.)` → `"T"`.
/// ifc-lite 27 decodes typed values as `Typed { name, value }`; 2.1 used a
/// `[name, value]` list — both unwrap to the inner value, so metadata
/// stays plain strings.
fn property_value_text(v: &AttributeValue) -> String {
    match v {
        AttributeValue::String(s) => s.clone(),
        AttributeValue::Enum(e) => e.clone(),
        AttributeValue::Typed { value, .. } => property_value_text(value),
        AttributeValue::List(l) => match l.get(1) {
            Some(inner @ (AttributeValue::String(_) | AttributeValue::Enum(_))) => {
                property_value_text(inner)
            }
            _ => format!("{:?}", v).trim_matches('"').to_string(),
        },
        _ => format!("{:?}", v).trim_matches('"').to_string(),
    }
}

fn extract_properties(
    decoder: &mut EntityDecoder,
    pset_relationships: Vec<(u64, Vec<u64>, u64)>,
    metadata_map: &mut HashMap<u64, IfcMetadata>,
) {
    for (_, object_ids, pset_id) in pset_relationships {
        if let Ok(prop_set) = decoder.decode_by_id(pset_id as u32) {
            if format!("{:?}", prop_set.ifc_type) == "IfcPropertySet" {
                let mut properties = HashMap::new();
                if let Some(AttributeValue::List(props)) = prop_set.attributes.get(4) {
                    for p_id in props {
                        if let AttributeValue::EntityRef(pid) = p_id {
                            if let Ok(prop) = decoder.decode_by_id(*pid as u32) {
                                if format!("{:?}", prop.ifc_type) == "IfcPropertySingleValue" {
                                    if let (Some(name_attr), Some(val_attr)) =
                                        (prop.attributes.get(0), prop.attributes.get(2))
                                    {
                                        let name = match name_attr {
                                            AttributeValue::String(s) => s.clone(),
                                            _ => format!("{:?}", name_attr)
                                                .trim_matches('"')
                                                .to_string(),
                                        };
                                        let value = property_value_text(val_attr);
                                        properties.insert(name, value);
                                    }
                                }
                            }
                        }
                    }
                }
                for obj_id in object_ids {
                    if let Some(metadata) = metadata_map.get_mut(&obj_id) {
                        metadata.properties.extend(properties.clone());
                    }
                }
            }
        }
    }
}

/// IFC relations that tie elements together physically, by entity id —
/// read in the metadata pass so related pairs can be skipped (SPEC §13e).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct IfcRelations {
    /// `IfcRelVoidsElement`: (host element, opening).
    pub voids: Vec<(u64, u64)>,
    /// `IfcRelFillsElement`: (opening, filling element e.g. door/window).
    pub fills: Vec<(u64, u64)>,
    /// `IfcRelAggregates`: (whole, parts).
    pub aggregates: Vec<(u64, Vec<u64>)>,
    /// `IfcRelDefinesByType`: (type object, occurrences). Not a physical
    /// tie — read here so occurrences get their type class (SPEC §6).
    pub typed_by: Vec<(u64, Vec<u64>)>,
}

fn entity_refs(v: Option<&AttributeValue>) -> Vec<u64> {
    match v {
        Some(AttributeValue::EntityRef(id)) => vec![*id as u64],
        Some(AttributeValue::List(items)) => items
            .iter()
            .filter_map(|x| match x {
                AttributeValue::EntityRef(id) => Some(*id as u64),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

/// Unordered GUID pairs that belong together and are expected to touch:
/// host × its opening; opening × its filling and host × filling (via the
/// opening); whole × part and part × part of an aggregate. Each pair is
/// stored with the smaller GUID first. Ids without a GUID are ignored.
pub fn related_guid_pairs(
    rel: &IfcRelations,
    guid_of: &HashMap<u64, IfcMetadata>,
) -> HashSet<(String, String)> {
    let mut out = HashSet::new();
    let mut add = |x: u64, y: u64| {
        if let (Some(a), Some(b)) = (guid_of.get(&x), guid_of.get(&y)) {
            if a.guid.is_empty() || b.guid.is_empty() || a.guid == b.guid {
                return;
            }
            out.insert(ordered_pair(&a.guid, &b.guid));
        }
    };
    let host_of_opening: HashMap<u64, u64> = rel.voids.iter().map(|(h, o)| (*o, *h)).collect();
    for (host, opening) in &rel.voids {
        add(*host, *opening);
    }
    for (opening, filler) in &rel.fills {
        add(*opening, *filler);
        if let Some(host) = host_of_opening.get(opening) {
            add(*host, *filler);
        }
    }
    for (whole, parts) in &rel.aggregates {
        for p in parts {
            add(*whole, *p);
        }
        for i in 0..parts.len() {
            for j in i + 1..parts.len() {
                add(parts[i], parts[j]);
            }
        }
    }
    out
}

/// `(min, max)` of two GUIDs — the key used for related pairs.
pub fn ordered_pair(a: &str, b: &str) -> (String, String) {
    if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) }
}

fn extract_basic_metadata(
    decoder: &mut EntityDecoder,
    scanner: &mut EntityScanner,
) -> (HashMap<u64, IfcMetadata>, Vec<(u64, Vec<u64>, u64)>, String, IfcRelations) {
    let mut metadata_map = HashMap::new();
    let mut pset_relationships = Vec::new();
    let mut length_unit = "meter".to_string();
    let mut relations = IfcRelations::default();

    while let Some((id, type_name, _start, _end)) = scanner.next_entity() {
        if let Ok(decoded) = decoder.decode_by_id(id as u32) {
            // Relations — attributes 4 and 5 are the related / relating
            // objects: physical ties (SPEC §13e) and type objects (§6).
            match type_name {
                "IFCRELVOIDSELEMENT" | "IFCRELFILLSELEMENT" | "IFCRELAGGREGATES" => {
                    let a = entity_refs(decoded.attributes.get(4));
                    let b = entity_refs(decoded.attributes.get(5));
                    match (type_name, a.first(), b.first()) {
                        ("IFCRELVOIDSELEMENT", Some(h), Some(o)) => relations.voids.push((*h, *o)),
                        ("IFCRELFILLSELEMENT", Some(o), Some(f)) => relations.fills.push((*o, *f)),
                        ("IFCRELAGGREGATES", Some(w), _) => relations.aggregates.push((*w, b)),
                        _ => {}
                    }
                }
                "IFCRELDEFINESBYTYPE" => {
                    let occurrences = entity_refs(decoded.attributes.get(4));
                    if let Some(t) = entity_refs(decoded.attributes.get(5)).first() {
                        relations.typed_by.push((*t, occurrences));
                    }
                }
                _ => {}
            }
            if type_name == "IFCRELDEFINESBYPROPERTIES" {
                if let (
                    Some(AttributeValue::List(objs)),
                    Some(AttributeValue::EntityRef(prop_id)),
                ) = (decoded.attributes.get(4), decoded.attributes.get(5))
                {
                    let object_ids: Vec<u64> = objs
                        .iter()
                        .filter_map(|v| match v {
                            AttributeValue::EntityRef(id) => Some(*id as u64),
                            _ => None,
                        })
                        .collect();
                    pset_relationships.push((id as u64, object_ids, *prop_id as u64));
                }
            } else if type_name == "IFCSIUNIT" {
                if let (
                    Some(AttributeValue::Enum(unit_type)),
                    Some(AttributeValue::Enum(unit_name)),
                ) = (decoded.attributes.get(1), decoded.attributes.get(3))
                {
                    if unit_type == "LENGTHUNIT" {
                        length_unit = match decoded.attributes.get(2) {
                            Some(AttributeValue::Enum(prefix)) => {
                                format!("{prefix}{unit_name}").to_lowercase()
                            }
                            _ => unit_name.to_lowercase(),
                        };
                    }
                }
            } else if let Some(guid_attr) = decoded.attributes.first() {
                let guid = match guid_attr {
                    AttributeValue::String(s) => s.clone(),
                    _ => format!("{:?}", guid_attr).trim_matches('"').to_string(),
                };
                let discipline = identify_discipline(&format!("{:?}", decoded.ifc_type));

                metadata_map.insert(
                    id as u64,
                    IfcMetadata {
                        guid,
                        ifc_type: type_name.to_string(),
                        discipline,
                        properties: HashMap::new(),
                        length_unit: "".to_string(),
                        // Stamped by load_ifc_elements once we know the path.
                        source_file: "".to_string(),
                        type_class: None,
                        predefined_type: None,
                    },
                );
            }
        }
    }

    for meta in metadata_map.values_mut() {
        meta.length_unit = length_unit.clone();
    }

    (metadata_map, pset_relationships, length_unit, relations)
}

/// An IFC file as loaded for clash detection: its elements, the GUID
/// pairs that belong together by IFC relations (SPEC §13e) and what the
/// opening cuts did (SPEC §13f).
#[derive(Clone)]
pub struct LoadedIfc {
    pub elements: Vec<IfcElement>,
    pub related_pairs: HashSet<(String, String)>,
    pub opening_cuts: OpeningCutStats,
    /// Generic MEP elements (`IfcFlowSegment`, …) with no type object:
    /// presets can't classify them (SPEC §6).
    pub untyped_generic: usize,
}

/// Loads an IFC file and extracts all geometry elements and their metadata.
pub fn load_ifc_elements<P: AsRef<Path>>(path: P) -> Result<Vec<IfcElement>> {
    Ok(load_ifc_file(path)?.elements)
}

/// Loads an IFC file: geometry elements, metadata and related pairs, with
/// the openings of every host cut out.
pub fn load_ifc_file<P: AsRef<Path>>(path: P) -> Result<LoadedIfc> {
    load_ifc_file_cutting(path, &|_| true)
}

/// `load_ifc_file`, cutting openings only out of the hosts `should_cut`
/// accepts (`&|_| false` meshes every host uncut).
pub fn load_ifc_file_cutting<P: AsRef<Path>>(
    path: P,
    should_cut: &dyn Fn(&IfcMetadata) -> bool,
) -> Result<LoadedIfc> {
    let content = fs::read_to_string(path.as_ref())
        .with_context(|| format!("Failed to read IFC file at {:?}", path.as_ref()))?;

    // Determine the active length unit from IFCUNITASSIGNMENT (not the last
    // IFCSIUNIT seen by the scanner, which may be wrong when multiple entries
    // exist for LENGTHUNIT).
    let active_length_unit = extract_active_length_unit_from_str(&content);
    println!("Active length unit (from IFCUNITASSIGNMENT): {active_length_unit}");

    let mut decoder = EntityDecoder::new(&content);
    let mut scanner = EntityScanner::new(&content);
    // Survey coordinates (UTM, millions of metres) keep full precision only
    // if nothing passes through f32 at that size — an f32 step there is
    // ~0.5 m (SPEC §4, TASKS T14). So: RTC — ifc-lite subtracts a
    // model-wide anchor in f64 before any f32 work, opening cuts included —
    // plus a local frame per mesh. File units (scale 1); the conversion to
    // metres, with the anchor added back, happens below.
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, true);
    let rtc = router
        .detect_rtc_offset_for_file(content.as_bytes(), &mut decoder)
        .map_or((0.0, 0.0, 0.0), RtcVerdict::offset);
    router.set_rtc_offset(rtc);
    let (mut metadata_map, pset_relationships, _, relations) =
        extract_basic_metadata(&mut decoder, &mut scanner);
    extract_properties(&mut decoder, pset_relationships, &mut metadata_map);
    let typed = apply_type_objects(&mut decoder, &relations.typed_by, &mut metadata_map);
    let related_pairs = related_guid_pairs(&relations, &metadata_map);

    // Override the length_unit set by the scanner with the authoritative value
    // from IFCUNITASSIGNMENT. Also stamp the source-file basename so each
    // element knows which IFC it came from (used downstream when building
    // per-clash file_a / file_b fields).
    let source_basename = path
        .as_ref()
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    for meta in metadata_map.values_mut() {
        meta.length_unit = active_length_unit.clone();
        meta.source_file = source_basename.clone();
    }

    // Geometry generation pass (Second full pass, but reused content/decoder)
    let voids = void_map(&relations.voids, &metadata_map, should_cut);
    let to_metres = unit_scale_metres_per(&active_length_unit);
    let mut opening_cuts = OpeningCutStats::default();
    let mut untyped_generic = 0;
    let mut elements = Vec::new();
    let mut index_by_id: HashMap<u32, usize> = HashMap::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, _type_name, _start, _end)) = scanner.next_entity() {
        if let Some(metadata) = metadata_map.get(&(id as u64)) {
            if let Ok(decoded) = decoder.decode_by_id(id as u32) {
                if let Ok(mesh) = mesh_element(
                    &router,
                    &decoded,
                    &mut decoder,
                    &voids,
                    &metadata.guid,
                    &mut opening_cuts,
                ) {
                    // Filter out very small meshes that might be artifacts
                    if mesh.positions.len() < 9 {
                        continue;
                    }

                    // Positions are relative to `mesh.origin` (zero on the
                    // plain path, the element centre on the opening-cut
                    // path), in the file's unit. The engine works in metres
                    // from here on — this is the one conversion (SPEC §4).
                    let (o, s) = (mesh.origin, to_metres);
                    let anchor = [rtc.0, rtc.1, rtc.2];
                    let vertices: Vec<Point> = mesh
                        .positions
                        .chunks(3)
                        .map(|v| {
                            let at = |k: usize| (anchor[k] + o[k] + v[k] as f64) * s;
                            Point::new(at(0), at(1), at(2))
                        })
                        .collect();

                    let indices: Vec<[u32; 3]> = mesh
                        .indices
                        .chunks(3)
                        .map(|c| [c[0] as u32, c[1] as u32, c[2] as u32])
                        .collect();

                    if !indices.is_empty() {
                        let mut metadata = metadata.clone();
                        let own = decoded.attributes.get(OCCURRENCE_PREDEFINED_TYPE_ATTR);
                        if let Some(p) = predefined_enum(own) {
                            metadata.predefined_type = Some(p);
                        }
                        let generic = is_generic_distribution_class(&metadata.ifc_type);
                        untyped_generic += (generic && !typed.contains(&(id as u64))) as usize;
                        index_by_id.insert(id as u32, elements.len());
                        elements.push(IfcElement {
                            metadata,
                            mesh: TriMesh::new(vertices, indices)?,
                        });
                    }
                }
            }
        }
    }

    // Meshes are in metres now: 1 mm.
    check_cuts(&elements, &index_by_id, &voids, &metadata_map, 0.001, &mut opening_cuts);
    println!("  {}", opening_cuts.summary_line());
    if untyped_generic > 0 {
        println!("  {untyped_generic} generic MEP element(s) without a type object");
    }
    Ok(LoadedIfc { elements, related_pairs, opening_cuts, untyped_generic })
}

/// Loads an IFC file and extracts basic metadata (GUID and Type) for all elements.
pub fn load_ifc_metadata<P: AsRef<Path>>(path: P) -> Result<HashMap<u64, IfcMetadata>> {
    let content = fs::read_to_string(path.as_ref())
        .with_context(|| format!("Failed to read IFC file at {:?}", path.as_ref()))?;

    let active_length_unit = extract_active_length_unit_from_str(&content);

    let mut decoder = EntityDecoder::new(&content);
    let mut scanner = EntityScanner::new(&content);
    let (mut metadata_map, pset_relationships, _, relations) =
        extract_basic_metadata(&mut decoder, &mut scanner);
    extract_properties(&mut decoder, pset_relationships, &mut metadata_map);
    apply_type_objects(&mut decoder, &relations.typed_by, &mut metadata_map);

    for meta in metadata_map.values_mut() {
        meta.length_unit = active_length_unit.clone();
    }

    Ok(metadata_map)
}

fn identify_discipline(ifc_type: &str) -> String {
    let type_clean = ifc_type.to_uppercase();
    if type_clean.contains("IFCBEAM")
        || type_clean.contains("IFCCOLUMN")
        || type_clean.contains("IFCFOOTING")
        || type_clean.contains("IFCMEMBER")
        || type_clean.contains("IFCSLAB")
        || type_clean.contains("IFCWALL")
    {
        return "Structural".to_string();
    }
    if type_clean.contains("IFCPIPE")
        || type_clean.contains("IFCDUCT")
        || type_clean.contains("IFCFLOW")
    {
        return "MEP".to_string();
    }
    if type_clean.contains("IFCDOOR")
        || type_clean.contains("IFCWINDOW")
        || type_clean.contains("IFCSTAIR")
        || type_clean.contains("IFCRAILING")
        || type_clean.contains("IFCCURTAINWALL")
    {
        return "Architectural".to_string();
    }
    "General".to_string()
}
