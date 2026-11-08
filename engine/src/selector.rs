// Derived from Clashero (MIT). See NOTICE.
use crate::ifc_adapter::{IfcElement, IfcMetadata};

/// Selector filtering logic based on IfcOpenShell syntax.
/// Initially supports basic type filtering (e.g., "IfcWall").
pub struct Selector {
    query: String,
}

impl Selector {
    pub fn new(query: &str) -> Self {
        Self {
            query: query.trim().to_string(),
        }
    }

    /// Filters a list of elements based on the query.
    pub fn filter(&self, elements: Vec<IfcElement>) -> Vec<IfcElement> {
        if self.query.is_empty() {
            return elements;
        }

        elements.into_iter().filter(|el| self.matches(el)).collect()
    }

    /// Checks if a single element matches the query.
    pub fn matches(&self, el: &IfcElement) -> bool {
        self.matches_metadata(&el.metadata)
    }

    /// `matches` on the metadata alone (no geometry needed).
    pub fn matches_metadata(&self, meta: &IfcMetadata) -> bool {
        if self.query.is_empty() || self.query == "*" {
            return true;
        }

        let is_exclusion = self.query.starts_with('!');
        let query_val = if is_exclusion {
            &self.query[1..]
        } else {
            &self.query
        };

        // If it starts with #, treat it as a GUID
        let matched = if query_val.starts_with('#') {
            let guid = &query_val[1..];
            meta.guid == guid
        } else {
            // Pipe-separated alternatives: "IfcBeam|IfcColumn" → match either.
            // An element answers to its occurrence class and to the class
            // read off its type object (IFC2X3 `IfcFlowSegment` typed as a
            // duct segment answers to both), docs/PROJECT-FILE.md#ifc2x3-type-objects.
            let classes: Vec<String> = std::iter::once(&meta.ifc_type)
                .chain(meta.type_class.as_ref())
                .map(|c| c.to_uppercase())
                .collect();
            query_val.split('|').any(|part| {
                let part = part.trim().to_uppercase();
                classes.iter().any(|class| match part.strip_suffix('*') {
                    // Prefix wildcard: "IfcDuct*" → IfcDuctSegment, IfcDuctFitting, …
                    Some(prefix) => class.starts_with(prefix),
                    None => *class == part,
                })
            })
        };

        if is_exclusion { !matched } else { matched }
    }
}

/// The include step of a rule side: `selector`, inverted when `mode` is
/// `"e"`. Metadata only, so it can run before meshing.
fn side_includes(meta: &IfcMetadata, selector: Option<&str>, mode: Option<&str>) -> bool {
    if mode.unwrap_or("i") == "e" {
        Selector::new(&format!("!{}", selector.unwrap_or("*"))).matches_metadata(meta)
    } else {
        Selector::new(selector.unwrap_or("")).matches_metadata(meta)
    }
}

/// The exclude step: an empty/absent `exclude` drops nothing.
fn side_excludes(meta: &IfcMetadata, exclude: Option<&str>) -> bool {
    exclude
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .is_some_and(|ex| Selector::new(ex).matches_metadata(meta))
}

/// Whether one rule side (same arguments as `select_elements`) picks this
/// element.
pub fn side_selects(
    meta: &IfcMetadata,
    selector: Option<&str>,
    mode: Option<&str>,
    exclude: Option<&str>,
) -> bool {
    side_includes(meta, selector, mode) && !side_excludes(meta, exclude)
}

/// Pick one rule side's elements: the include `selector` (inverted when
/// `mode` is `"e"`), then drop everything matching `exclude` (same
/// syntax — exact, `Prefix*`, `A|B`). Returns the kept elements and how
/// many the exclude step dropped. An empty/absent `exclude` drops nothing.
pub fn select_elements(
    elements: Vec<IfcElement>,
    selector: Option<&str>,
    mode: Option<&str>,
    exclude: Option<&str>,
) -> (Vec<IfcElement>, usize) {
    let mut excluded = 0;
    let kept = elements
        .into_iter()
        .filter(|el| side_includes(&el.metadata, selector, mode))
        .filter(|el| {
            let drop = side_excludes(&el.metadata, exclude);
            excluded += drop as usize;
            !drop
        })
        .collect();
    (kept, excluded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ifc_adapter::IfcMetadata;
    use parry3d_f64::shape::TriMesh;
    use std::collections::HashMap;

    fn create_mock_element(ifc_type: &str, guid: &str) -> IfcElement {
        let vertices = vec![
            parry3d_f64::math::Vector::new(0.0, 0.0, 0.0),
            parry3d_f64::math::Vector::new(1.0, 0.0, 0.0),
            parry3d_f64::math::Vector::new(0.0, 1.0, 0.0),
        ];
        let indices = vec![[0, 1, 2]];
        IfcElement {
            metadata: IfcMetadata {
                guid: guid.to_string(),
                ifc_type: ifc_type.to_string(),
                discipline: "General".to_string(),
                properties: HashMap::new(),
                length_unit: "meter".to_string(),
                source_file: "".to_string(),
                type_class: None,
                predefined_type: None,
            },
            mesh: TriMesh::new(vertices, indices).expect("Mock mesh should be valid"),
        }
    }

    #[test]
    fn test_basic_type_filtering() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let el2 = create_mock_element("IfcWindow", "guid2");
        let elements = vec![el1, el2];

        let selector = Selector::new("IfcWall");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].metadata.ifc_type, "IfcWall");
    }

    #[test]
    fn test_exclusion_filtering() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let el2 = create_mock_element("IfcWindow", "guid2");
        let elements = vec![el1, el2];

        let selector = Selector::new("!IfcWall");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].metadata.ifc_type, "IfcWindow");
    }

    #[test]
    fn test_guid_filtering() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let el2 = create_mock_element("IfcWall", "guid2");
        let elements = vec![el1, el2];

        let selector = Selector::new("#guid1");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].metadata.guid, "guid1");
    }

    #[test]
    fn test_wildcard_filtering() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let el2 = create_mock_element("IfcWindow", "guid2");
        let elements = vec![el1, el2];

        let selector = Selector::new("*");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn test_empty_query() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let elements = vec![el1];

        let selector = Selector::new("");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 1);
    }

    fn mixed_elements() -> Vec<IfcElement> {
        vec![
            create_mock_element("IfcWall", "w"),
            create_mock_element("IfcSpace", "s"),
            create_mock_element("IfcOpeningElement", "o"),
            create_mock_element("IfcOpeningStandardCase", "osc"),
            create_mock_element("IfcSlab", "sl"),
        ]
    }

    fn guids(els: &[IfcElement]) -> Vec<&str> {
        els.iter().map(|e| e.metadata.guid.as_str()).collect()
    }

    #[test]
    fn test_select_exclude_after_include() {
        let (kept, excluded) = select_elements(
            mixed_elements(),
            Some("*"),
            Some("i"),
            Some("IfcSpace|IfcOpeningElement|IfcOpeningStandardCase"),
        );
        assert_eq!(guids(&kept), vec!["w", "sl"]);
        assert_eq!(excluded, 3);
    }

    #[test]
    fn test_select_exclude_prefix_and_case() {
        let (kept, excluded) =
            select_elements(mixed_elements(), None, None, Some("ifcopening*"));
        assert_eq!(guids(&kept), vec!["w", "s", "sl"]);
        assert_eq!(excluded, 2);
    }

    #[test]
    fn test_select_exclude_only_counts_included() {
        // Include picks walls + spaces; exclude spaces ⇒ only the one
        // space that was included counts as excluded.
        let (kept, excluded) =
            select_elements(mixed_elements(), Some("IfcWall|IfcSpace"), None, Some("IfcSpace|IfcSlab"));
        assert_eq!(guids(&kept), vec!["w"]);
        assert_eq!(excluded, 1);
    }

    #[test]
    fn test_select_without_exclude_and_mode_e() {
        let (kept, excluded) = select_elements(mixed_elements(), Some("IfcWall"), Some("e"), None);
        assert_eq!(kept.len(), 4);
        assert_eq!(excluded, 0);
        let (kept, excluded) = select_elements(mixed_elements(), Some("IfcWall"), Some("e"), Some("  "));
        assert_eq!((kept.len(), excluded), (4, 0));
        let (kept, _) = select_elements(mixed_elements(), Some("IfcSpace"), Some("e"), Some("IfcSlab"));
        assert_eq!(guids(&kept), vec!["w", "o", "osc"]);
    }

    #[test]
    fn test_case_insensitivity() {
        let el1 = create_mock_element("IfcWall", "guid1");
        let elements = vec![el1];

        let selector = Selector::new("ifcwall");
        let filtered = selector.filter(elements);

        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn test_type_class_and_occurrence_class_both_match() {
        let mut duct = create_mock_element("IFCFLOWSEGMENT", "duct");
        duct.metadata.type_class = Some("IfcDuctSegment".to_string());
        let pipe = create_mock_element("IFCFLOWSEGMENT", "untyped");
        let m = |q: &str, el: &IfcElement| Selector::new(q).matches(el);
        assert!(m("IfcDuct*", &duct));
        assert!(m("IfcDuctSegment", &duct));
        assert!(m("IfcFlowSegment", &duct), "occurrence class still matches");
        assert!(!m("IfcPipe*", &duct));
        assert!(!m("!IfcDuct*", &duct), "exclusion sees the type class too");
        assert!(!m("IfcDuct*", &pipe));
        assert!(m("IfcFlowSegment", &pipe));
    }
}
