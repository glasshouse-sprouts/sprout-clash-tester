//! Classify generic MEP occurrences by their type object
//! (docs/PROJECT-FILE.md#ifc2x3-type-objects). In IFC2X3 a duct is an `IfcFlowSegment` occurrence
//! whose
//! `IfcDuctSegmentType` says what it is, so selectors like `IfcDuct*`
//! need the class read off the type object.

use crate::ifc_adapter::IfcMetadata;
use ifc_lite_core::AttributeValue;
use ifc_lite_core::decoder::EntityDecoder;
use std::collections::{HashMap, HashSet};

/// Occurrence classes that only say "some distribution element"; the
/// type object says which. Upper case, as the scanner reports them.
const GENERIC_DISTRIBUTION_CLASSES: &[&str] = &[
    "IFCFLOWSEGMENT",
    "IFCFLOWFITTING",
    "IFCFLOWTERMINAL",
    "IFCFLOWCONTROLLER",
    "IFCFLOWMOVINGDEVICE",
    "IFCFLOWSTORAGEDEVICE",
    "IFCFLOWTREATMENTDEVICE",
    "IFCENERGYCONVERSIONDEVICE",
    "IFCDISTRIBUTIONFLOWELEMENT",
    "IFCDISTRIBUTIONCONTROLELEMENT",
];

pub fn is_generic_distribution_class(ifc_type: &str) -> bool {
    GENERIC_DISTRIBUTION_CLASSES.contains(&ifc_type.to_uppercase().as_str())
}

/// The class a generic occurrence really is, from its type object's
/// class: `IfcDuctSegmentType` → `IfcDuctSegment`. `None` when the
/// occurrence isn't generic or the type class doesn't end in `Type`.
pub fn effective_class(occurrence_class: &str, type_object_class: &str) -> Option<String> {
    if !is_generic_distribution_class(occurrence_class) {
        return None;
    }
    type_object_class.strip_suffix("Type").map(str::to_string)
}

/// A `PredefinedType` value, or `None` for anything that isn't an enum
/// and for `NOTDEFINED` (which says nothing).
pub fn predefined_enum(attr: Option<&AttributeValue>) -> Option<String> {
    match attr {
        Some(AttributeValue::Enum(e)) if e != "NOTDEFINED" => Some(e.clone()),
        _ => None,
    }
}

/// `PredefinedType` sits at attribute 8 on element occurrences (IFC4)
/// and at 9 on element type objects (after `ElementType`).
pub const OCCURRENCE_PREDEFINED_TYPE_ATTR: usize = 8;
const TYPE_OBJECT_PREDEFINED_TYPE_ATTR: usize = 9;

/// Apply `IfcRelDefinesByType` relations — `(type object, occurrences)`
/// by entity id — to the metadata: each occurrence gets its effective
/// class and the type object's `PredefinedType` (the occurrence's own
/// one, read when meshing, takes precedence). Returns the ids of all
/// occurrences that have a type object.
pub fn apply_type_objects(
    decoder: &mut EntityDecoder,
    typed_by: &[(u64, Vec<u64>)],
    metadata_map: &mut HashMap<u64, IfcMetadata>,
) -> HashSet<u64> {
    let mut typed = HashSet::new();
    for (type_id, occurrences) in typed_by {
        let Ok(type_object) = decoder.decode_by_id(*type_id as u32) else {
            continue;
        };
        let type_class = type_object.ifc_type.name().to_string();
        let predefined =
            predefined_enum(type_object.attributes.get(TYPE_OBJECT_PREDEFINED_TYPE_ATTR));
        for id in occurrences {
            typed.insert(*id);
            if let Some(meta) = metadata_map.get_mut(id) {
                meta.type_class = effective_class(&meta.ifc_type, &type_class);
                meta.predefined_type = predefined.clone();
            }
        }
    }
    typed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_occurrence_takes_the_type_class() {
        let class = effective_class("IFCFLOWSEGMENT", "IfcDuctSegmentType");
        assert_eq!(class.as_deref(), Some("IfcDuctSegment"));
        let class = effective_class("IFCFLOWCONTROLLER", "IfcValveType");
        assert_eq!(class.as_deref(), Some("IfcValve"));
    }

    #[test]
    fn specific_occurrence_keeps_its_own_class() {
        assert_eq!(effective_class("IFCDUCTSEGMENT", "IfcDuctSegmentType"), None);
        assert_eq!(effective_class("IFCBEAM", "IfcBeamType"), None);
    }

    #[test]
    fn notdefined_is_no_predefined_type() {
        let e = |s: &str| AttributeValue::Enum(s.to_string());
        assert_eq!(predefined_enum(Some(&e("BEND"))).as_deref(), Some("BEND"));
        assert_eq!(predefined_enum(Some(&e("NOTDEFINED"))), None);
        assert_eq!(predefined_enum(Some(&AttributeValue::Null)), None);
    }
}
