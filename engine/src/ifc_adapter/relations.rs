// Derived from Clashero (MIT). See NOTICE.
//! IFC relations that tie elements together, and the GUID pairs they give
//! (docs/HOW-IT-WORKS.md#related-elements).

use super::IfcMetadata;
use ifc_lite_core::AttributeValue;
use std::collections::{HashMap, HashSet};

/// IFC relations that tie elements together physically, by entity id —
/// read in the metadata pass so related pairs can be skipped
/// (docs/HOW-IT-WORKS.md#related-elements).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct IfcRelations {
    /// `IfcRelVoidsElement`: (host element, opening).
    pub voids: Vec<(u64, u64)>,
    /// `IfcRelFillsElement`: (opening, filling element e.g. door/window).
    pub fills: Vec<(u64, u64)>,
    /// `IfcRelAggregates`: (whole, parts).
    pub aggregates: Vec<(u64, Vec<u64>)>,
    /// `IfcRelDefinesByType`: (type object, occurrences). Not a physical
    /// tie — read here so occurrences get their type class
    /// (docs/PROJECT-FILE.md#ifc2x3-type-objects).
    pub typed_by: Vec<(u64, Vec<u64>)>,
}

pub(super) fn entity_refs(v: Option<&AttributeValue>) -> Vec<u64> {
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
