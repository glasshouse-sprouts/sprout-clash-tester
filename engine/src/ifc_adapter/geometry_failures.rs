//! Elements that should have geometry but end up with no usable mesh
//! (docs/HOW-IT-WORKS.md#geometry-that-cant-be-read). The loader can't
//! check them, so it counts them and the run warns `geometry_failed` —
//! the same "never fail silently" rule as the opening cuts.

use crate::EngineWarning;
use ifc_lite_core::AttributeValue;
use ifc_lite_core::DecodedEntity;
use ifc_lite_core::decoder::EntityDecoder;

/// `Representation` is attribute 6 on every `IfcProduct`;
/// `IfcProductDefinitionShape.Representations` is attribute 2;
/// `IfcShapeRepresentation.RepresentationIdentifier` is attribute 1.
const PRODUCT_REPRESENTATION_ATTR: usize = 6;
const SHAPE_REPRESENTATIONS_ATTR: usize = 2;
const REPRESENTATION_IDENTIFIER_ATTR: usize = 1;

/// Identifiers of a 3D body (IFC "Body", and the older "Facetation").
/// Others are not geometry we test: 2D plan annotations ("Annotation",
/// IfcAnnotation dimension texts), grid lines and site outlines
/// ("FootPrint", IfcGrid), axes ("Axis"), boxes and clearances. Measured
/// on the test models (TASKS T34): every element left out by this was an
/// IfcAnnotation or IfcGrid with curves only.
/// How many elements a `geometry_failed` warning names before "… and N more".
const LISTED: usize = 5;

const BODY_IDENTIFIERS: &[&str] = &["Body", "Facetation"];

/// An element with a body representation whose mesh couldn't be used.
#[derive(Clone, Debug)]
pub struct GeometryFailure {
    pub guid: String,
    pub ifc_type: String,
    /// `"error"` (meshing failed), `"too small"` (< 3 vertices) or
    /// `"no triangles"`.
    pub reason: &'static str,
}

/// True when the element's `Representation` is an
/// `IfcProductDefinitionShape` with a body: a shape representation whose
/// identifier is a body identifier, or has none (a body exported without
/// a label must not slip through). Elements without a representation
/// (containers like `IfcRoof` that only aggregate their parts, spatial
/// structure) or with 2D / axis representations only are not failures.
/// Checking the referenced class, not just "some reference at attribute
/// 6", keeps non-products out: on `IfcRelConnectsElements` attribute 6 is
/// an element.
pub(super) fn has_body_representation(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> bool {
    let Some(AttributeValue::EntityRef(shape)) =
        element.attributes.get(PRODUCT_REPRESENTATION_ATTR)
    else {
        return false;
    };
    let Ok(shape) = decoder.decode_by_id(*shape) else {
        return false;
    };
    if format!("{:?}", shape.ifc_type) != "IfcProductDefinitionShape" {
        return false;
    }
    let Some(AttributeValue::List(reps)) = shape.attributes.get(SHAPE_REPRESENTATIONS_ATTR) else {
        return false;
    };
    reps.iter().any(|r| {
        let AttributeValue::EntityRef(id) = r else {
            return false;
        };
        let Ok(rep) = decoder.decode_by_id(*id) else {
            return false;
        };
        match rep
            .attributes
            .get(REPRESENTATION_IDENTIFIER_ATTR)
            .map(AttributeValue::unwrap_typed)
        {
            Some(AttributeValue::String(id)) => BODY_IDENTIFIERS.contains(&id.as_str()),
            _ => true,
        }
    })
}

/// The `geometry_failed` warning for one file, or `None` when nothing
/// failed: the count, then the first few elements as
/// `GUID (IFC type, reason)`.
pub fn geometry_failed_warning(file: &str, failed: &[GeometryFailure]) -> Option<EngineWarning> {
    if failed.is_empty() {
        return None;
    }
    let mut listed: Vec<String> = failed
        .iter()
        .take(LISTED)
        .map(|f| format!("{} ({}, {})", f.guid, f.ifc_type, f.reason))
        .collect();
    if failed.len() > LISTED {
        listed.push(format!("… and {} more", failed.len() - LISTED));
    }
    Some(EngineWarning {
        kind: "geometry_failed".to_string(),
        message: format!(
            "{} element(s) in {file} have geometry that could not be read and are not checked: {}",
            failed.len(),
            listed.join(", ")
        ),
        files: vec![file.to_string()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warning_lists_five_then_counts_the_rest() {
        let failure = |i: usize| GeometryFailure {
            guid: format!("G{i}"),
            ifc_type: "IFCWALL".to_string(),
            reason: "error",
        };
        let failed: Vec<_> = (0..7).map(failure).collect();
        let msg = geometry_failed_warning("X.ifc", &failed).unwrap().message;
        assert!(
            msg.starts_with("7 element(s) in X.ifc have geometry"),
            "{msg}"
        );
        assert!(
            msg.contains("G4 (IFCWALL, error)") && !msg.contains("G5 "),
            "{msg}"
        );
        assert!(msg.ends_with("… and 2 more"), "{msg}");
        assert!(geometry_failed_warning("X.ifc", &[]).is_none());
    }
}
