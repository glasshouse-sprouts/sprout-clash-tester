// Derived from Clashero (MIT). See NOTICE.
//! The metadata pass: GUID, class, discipline, property sets and
//! relations of every entity, without meshing.

use super::IfcMetadata;
use super::relations::{IfcRelations, entity_refs};
use super::units::extract_active_length_unit_from_str;
use crate::type_objects::apply_type_objects;
use anyhow::{Context, Result};
use ifc_lite_core::decoder::EntityDecoder;
use ifc_lite_core::{AttributeValue, EntityScanner};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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

pub(super) fn extract_properties(
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

pub(super) fn extract_basic_metadata(
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
            // objects: physical ties (docs/HOW-IT-WORKS.md#related-elements) and type objects (§6).
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
