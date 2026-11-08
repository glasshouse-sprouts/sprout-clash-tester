// Derived from Clashero (MIT). See NOTICE.
//! Loading IFC files: element types, and meshing every element in metres
//! with its openings cut out. The metadata pass, relations, units and raw
//! STEP-text readers live in the submodules.

mod metadata;
mod relations;
mod step_text;
mod units;

// Public API, unchanged paths (`clash::ifc_adapter::…`) since the T30 split.
pub use metadata::load_ifc_metadata;
pub use relations::{IfcRelations, ordered_pair, related_guid_pairs};
pub use step_text::{
    MapConversion, extract_map_conversion_from_str, extract_site_origin_from_str,
    extract_site_origin_mm,
};
pub use units::{extract_active_length_unit_from_str, unit_scale_metres_per};

use anyhow::{Context, Result};
use ifc_lite_core::decoder::EntityDecoder;
use ifc_lite_core::EntityScanner;
use ifc_lite_core::limits::RtcVerdict;
use ifc_lite_geometry::GeometryRouter;
use crate::opening_cuts::{OpeningCutStats, check_cuts, mesh_element, void_map};
use crate::type_objects::{
    OCCURRENCE_PREDEFINED_TYPE_ATTR, apply_type_objects, is_generic_distribution_class,
    predefined_enum,
};
use metadata::{extract_basic_metadata, extract_properties};
use parry3d_f64::math::Vector as Point;
use parry3d_f64::shape::TriMesh;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

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
