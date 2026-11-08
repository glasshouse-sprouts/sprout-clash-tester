// Derived from Clashero (MIT). See NOTICE.
use anyhow::Result;
use chrono::Utc;
use quick_xml::Writer;
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use std::fs::File;
use std::io::{Cursor, Write};
use std::path::Path;
use uuid::Uuid;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

/// Minimal 1×1 grey PNG — satisfies BIMcollab's snapshot.png requirement.
/// BIMcollab refuses to load issues without a snapshot file in the topic folder.
const PLACEHOLDER_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x3A, 0x7E, 0x9B,
    0x55, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xD7, 0x63, 0x60, 0x00, 0x00, 0x00,
    0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];


/// Author of every topic and comment this engine writes.
const BCF_AUTHOR: &str = "Clash Tester";
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClashInfo {
    pub guid_a: String,
    pub guid_b: String,
    pub description: String,
    pub position: [f64; 3],
    pub camera_eye: Option<[f64; 3]>,
    /// Basename of the IFC file element A came from. Empty if unknown.
    #[serde(default)]
    pub file_a: String,
    /// Basename of the IFC file element B came from. Empty if unknown.
    #[serde(default)]
    pub file_b: String,
    /// Detection mode that fired the clash: `"intersection"` (hard) or
    /// `"clearance"` (within tolerance). Empty when constructed manually
    /// in tests.
    #[serde(default)]
    pub mode: String,
    /// Approximate penetration depth in metres. Set only in
    /// `intersection` mode. **Caveat:** this is the AABB-overlap minimum
    /// dimension (same proxy `penetration_depth` returns), not true
    /// geometric depth. Monotonic with truth — accurate within ~10% on
    /// duct/beam/wall-shaped elements; can over-estimate for elements
    /// whose bounding box is much bigger than their geometry.
    #[serde(default)]
    pub depth_metres: Option<f64>,
    /// Clearance gap in metres. Set only in `clearance` mode. This one
    /// IS real-world accurate (parry3d's `distance` between meshes).
    #[serde(default)]
    pub gap_metres: Option<f64>,
    /// Extents `[dx, dy, dz]` of the AABB-overlap box in metres.
    /// Present whenever the two elements' AABBs intersect; `None` when
    /// they don't (only possible in clearance mode).
    #[serde(default)]
    pub aabb_overlap_extents: Option<[f64; 3]>,
    /// Volume of the AABB-overlap box in m³ (= dx·dy·dz). Same caveat
    /// as the extents — this is the box volume, **not** the true
    /// volume of geometric overlap. Useful as a crude severity proxy
    /// and for AI-driven grouping; do not report as an exact figure.
    #[serde(default)]
    pub aabb_overlap_volume: Option<f64>,
    /// How alike the two elements' bounding boxes are, 0..1 (1 = same
    /// box). Per axis: overlap length / longer of the two lengths; the
    /// result is the smallest of the three. `None` when the boxes don't
    /// overlap. Near 1 means "possibly modelled twice".
    #[serde(default)]
    pub aabb_match: Option<f64>,
    /// Volume of element A's mesh in m³ (see `mesh_measure` for method).
    /// `None` for flat/degenerate meshes.
    #[serde(default)]
    pub volume_a: Option<f64>,
    /// Volume of element B's mesh in m³.
    #[serde(default)]
    pub volume_b: Option<f64>,
    /// Distance between the two elements' mesh centres, metres. Near 0
    /// plus equal volumes and the same IFC type ⇒ likely double modelling.
    #[serde(default)]
    pub centroid_distance: Option<f64>,
    /// ifc-lite narrow phase only (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase): `"hard"`,
    /// `"clearance"`, or — listed only with `report_touch` — `"touch"` / `"unconfirmed"`.
    /// `None` from the parry narrow phase.
    #[serde(default)]
    pub status: Option<String>,
    /// ifc-lite narrow phase only: whether the depth/gap was measured on
    /// the meshes (`"mesh"`) or read off the boxes (`"estimate"`).
    #[serde(default)]
    pub distance_kind: Option<String>,
    /// Class read off element A's / B's type object when the occurrence
    /// is generic (`IfcFlowSegment` → `IfcDuctSegment`), docs/PROJECT-FILE.md#ifc2x3-type-objects.
    /// `None` when the occurrence class says it already.
    #[serde(default)]
    pub type_class_a: Option<String>,
    #[serde(default)]
    pub type_class_b: Option<String>,
    /// `PredefinedType` of element A / B (occurrence, else type object).
    #[serde(default)]
    pub predefined_type_a: Option<String>,
    #[serde(default)]
    pub predefined_type_b: Option<String>,
}

/// One BCF topic, independent of where it came from (a clash or a group
/// of clashes). The only input `generate_bcf_topics` needs; the
/// `clash bcf --topics` subcommand reads a JSON array of these.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BcfTopic {
    /// Full topic title, already numbered (e.g. `"1 - Clash between …"`).
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Point the camera looks at, world metres.
    pub position: [f64; 3],
    /// Camera location, world metres. `None` ⇒ 5 m back diagonally
    /// (X-5, Y-5, Z+5) from `position`, as for single clashes.
    #[serde(default)]
    pub camera_eye: Option<[f64; 3]>,
    /// IFC GUIDs selected and shown (all others hidden), in order.
    pub guids: Vec<String>,
}

impl BcfTopic {
    /// The topic for one clash; `number` is its 1-based position in the
    /// clash list ("1 - Clash between …") — the same number the CSV `no`
    /// column and the JSON `number` field carry.
    /// Listed ifc-lite non-clashes say what they are ("Touch between …").
    pub fn from_clash(number: usize, clash: &ClashInfo) -> Self {
        let what = crate::ifclite_narrow::record_noun(clash.status.as_deref());
        BcfTopic {
            title: format!("{} - {} between {} and {}", number, what, clash.guid_a, clash.guid_b),
            description: clash.description.clone(),
            position: clash.position,
            camera_eye: clash.camera_eye,
            guids: vec![clash.guid_a.clone(), clash.guid_b.clone()],
        }
    }
}

/// One topic per clash, in list order.
pub fn generate_bcf<P: AsRef<Path>>(path: P, clashes: &[ClashInfo]) -> Result<()> {
    let topics: Vec<BcfTopic> = clashes
        .iter()
        .enumerate()
        .map(|(index, clash)| BcfTopic::from_clash(index + 1, clash))
        .collect();
    generate_bcf_topics(path, &topics)
}

/// Write a BCF 2.1 zip with one topic per entry, in order. This is the
/// only BCF writer (BIMcollab-tested); per-clash and per-group exports
/// both go through it.
pub fn generate_bcf_topics<P: AsRef<Path>>(path: P, topics: &[BcfTopic]) -> Result<()> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755);

    // ── bcf.version ───────────────────────────────────────────────────────────
    zip.start_file("bcf.version", options)?;
    zip.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
          <Version VersionId=\"2.1\" DetailedVersion=\"2.1\">\n\
          </Version>",
    )?;

    // ── project.bcfp ─────────────────────────────────────────────────────────
    // No xmlns — BIMcollab rejects xmlns attributes on root elements
    zip.start_file("project.bcfp", options)?;
    zip.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
          <ProjectInfo>\n\
          \x20\x20<Project ProjectId=\"\">Clash Detection Project</Project>\n\
          </ProjectInfo>",
    )?;

    // ── One topic folder per topic ────────────────────────────────────────────
    let now = Utc::now().to_rfc3339();

    for topic in topics {
        let topic_id    = Uuid::new_v4().to_string();
        let viewpoint_id = Uuid::new_v4().to_string();
        let comment_id  = Uuid::new_v4().to_string();
        let topic_dir   = format!("{}/", topic_id);

        // ── markup.bcf ───────────────────────────────────────────────────────
        zip.start_file(format!("{}markup.bcf", topic_dir), options)?;
        let mut w = Writer::new(Cursor::new(Vec::new()));
        w.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;

        // <Markup> — no xmlns (BIMcollab rejects it)
        w.write_event(Event::Start(BytesStart::new("Markup")))?;

        // <Topic>
        let mut topic_el = BytesStart::new("Topic");
        topic_el.push_attribute(("Guid", topic_id.as_str()));
        topic_el.push_attribute(("TopicType", "Clash"));
        topic_el.push_attribute(("TopicStatus", "Open"));
        w.write_event(Event::Start(topic_el))?;

        w.write_event(Event::Start(BytesStart::new("Title")))?;
        w.write_event(Event::Text(BytesText::new(&topic.title)))?;
        w.write_event(Event::End(BytesEnd::new("Title")))?;

        w.write_event(Event::Start(BytesStart::new("Priority")))?;
        w.write_event(Event::Text(BytesText::new("Normal")))?;
        w.write_event(Event::End(BytesEnd::new("Priority")))?;

        w.write_event(Event::Start(BytesStart::new("CreationDate")))?;
        w.write_event(Event::Text(BytesText::new(&now)))?;
        w.write_event(Event::End(BytesEnd::new("CreationDate")))?;

        w.write_event(Event::Start(BytesStart::new("CreationAuthor")))?;
        w.write_event(Event::Text(BytesText::new(BCF_AUTHOR)))?;
        w.write_event(Event::End(BytesEnd::new("CreationAuthor")))?;

        w.write_event(Event::Start(BytesStart::new("ModifiedDate")))?;
        w.write_event(Event::Text(BytesText::new(&now)))?;
        w.write_event(Event::End(BytesEnd::new("ModifiedDate")))?;

        w.write_event(Event::Start(BytesStart::new("ModifiedAuthor")))?;
        w.write_event(Event::Text(BytesText::new(BCF_AUTHOR)))?;
        w.write_event(Event::End(BytesEnd::new("ModifiedAuthor")))?;

        w.write_event(Event::Start(BytesStart::new("Description")))?;
        w.write_event(Event::Text(BytesText::new(&topic.description)))?;
        w.write_event(Event::End(BytesEnd::new("Description")))?;

        w.write_event(Event::End(BytesEnd::new("Topic")))?;

        // <Comment> — BIMcollab requires this to link the topic to its viewpoint
        let mut comment_el = BytesStart::new("Comment");
        comment_el.push_attribute(("Guid", comment_id.as_str()));
        w.write_event(Event::Start(comment_el))?;

        w.write_event(Event::Start(BytesStart::new("Date")))?;
        w.write_event(Event::Text(BytesText::new(&now)))?;
        w.write_event(Event::End(BytesEnd::new("Date")))?;

        w.write_event(Event::Start(BytesStart::new("Author")))?;
        w.write_event(Event::Text(BytesText::new(BCF_AUTHOR)))?;
        w.write_event(Event::End(BytesEnd::new("Author")))?;

        w.write_event(Event::Start(BytesStart::new("Comment")))?;
        w.write_event(Event::End(BytesEnd::new("Comment")))?;

        let mut vp_ref = BytesStart::new("Viewpoint");
        vp_ref.push_attribute(("Guid", viewpoint_id.as_str()));
        w.write_event(Event::Empty(vp_ref))?;

        w.write_event(Event::End(BytesEnd::new("Comment")))?;

        // <Viewpoints> — Guid on the element, Snapshot reference required by BIMcollab
        let mut vp_el = BytesStart::new("Viewpoints");
        vp_el.push_attribute(("Guid", viewpoint_id.as_str()));
        w.write_event(Event::Start(vp_el))?;

        w.write_event(Event::Start(BytesStart::new("Viewpoint")))?;
        w.write_event(Event::Text(BytesText::new("viewpoint.bcfv")))?;
        w.write_event(Event::End(BytesEnd::new("Viewpoint")))?;

        w.write_event(Event::Start(BytesStart::new("Snapshot")))?;
        w.write_event(Event::Text(BytesText::new("snapshot.png")))?;
        w.write_event(Event::End(BytesEnd::new("Snapshot")))?;

        w.write_event(Event::End(BytesEnd::new("Viewpoints")))?;
        w.write_event(Event::End(BytesEnd::new("Markup")))?;

        zip.write_all(&w.into_inner().into_inner())?;

        // ── viewpoint.bcfv ───────────────────────────────────────────────────
        zip.start_file(format!("{}viewpoint.bcfv", topic_dir), options)?;
        let mut v = Writer::new(Cursor::new(Vec::new()));
        v.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;

        // <VisualizationInfo Guid="…"> — no xmlns
        let mut vi_el = BytesStart::new("VisualizationInfo");
        vi_el.push_attribute(("Guid", viewpoint_id.as_str()));
        v.write_event(Event::Start(vi_el))?;

        // <Components> MUST come BEFORE <PerspectiveCamera> per BCF 2.1 XSD
        v.write_event(Event::Start(BytesStart::new("Components")))?;

        let mut hints = BytesStart::new("ViewSetupHints");
        hints.push_attribute(("SpacesVisible", "false"));
        hints.push_attribute(("SpaceBoundariesVisible", "false"));
        hints.push_attribute(("OpeningsVisible", "false"));
        v.write_event(Event::Empty(hints))?;

        v.write_event(Event::Start(BytesStart::new("Selection")))?;
        for guid in &topic.guids {
            let mut comp = BytesStart::new("Component");
            comp.push_attribute(("IfcGuid", guid.as_str()));
            v.write_event(Event::Empty(comp))?;
        }
        v.write_event(Event::End(BytesEnd::new("Selection")))?;

        // DefaultVisibility="false" + Exceptions — shows only the clashing elements
        let mut vis = BytesStart::new("Visibility");
        vis.push_attribute(("DefaultVisibility", "false"));
        v.write_event(Event::Start(vis))?;
        v.write_event(Event::Start(BytesStart::new("Exceptions")))?;
        for guid in &topic.guids {
            let mut comp = BytesStart::new("Component");
            comp.push_attribute(("IfcGuid", guid.as_str()));
            v.write_event(Event::Empty(comp))?;
        }
        v.write_event(Event::End(BytesEnd::new("Exceptions")))?;
        v.write_event(Event::End(BytesEnd::new("Visibility")))?;

        v.write_event(Event::End(BytesEnd::new("Components")))?;

        // ── Camera ────────────────────────────────────────────────────────────
        let (eye, dir) = if let Some(eye) = topic.camera_eye {
            // Direction: from camera eye toward the target point, normalised
            let d = [
                topic.position[0] - eye[0],
                topic.position[1] - eye[1],
                topic.position[2] - eye[2],
            ];
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            let dir = if len > 0.0 {
                [d[0] / len, d[1] / len, d[2] / len]
            } else {
                [0.0, 0.0, -1.0]
            };
            (eye, dir)
        } else {
            (
                [topic.position[0] - 5.0, topic.position[1] - 5.0, topic.position[2] + 5.0],
                [0.57735, 0.57735, -0.57735],
            )
        };

        v.write_event(Event::Start(BytesStart::new("PerspectiveCamera")))?;

        write_xyz(&mut v, "CameraViewPoint", eye)?;
        write_xyz(&mut v, "CameraDirection",  dir)?;
        write_xyz(&mut v, "CameraUpVector",   [0.0, 0.0, 1.0])?; // Z-up

        v.write_event(Event::Start(BytesStart::new("FieldOfView")))?;
        v.write_event(Event::Text(BytesText::new("65")))?;
        v.write_event(Event::End(BytesEnd::new("FieldOfView")))?;

        v.write_event(Event::End(BytesEnd::new("PerspectiveCamera")))?;
        v.write_event(Event::End(BytesEnd::new("VisualizationInfo")))?;

        zip.write_all(&v.into_inner().into_inner())?;

        // ── snapshot.png — placeholder required by BIMcollab ─────────────────
        zip.start_file(format!("{}snapshot.png", topic_dir), options)?;
        zip.write_all(PLACEHOLDER_PNG)?;
    }

    zip.finish()?;
    Ok(())
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn write_xyz(
    w: &mut Writer<Cursor<Vec<u8>>>,
    tag: &str,
    v: [f64; 3],
) -> Result<()> {
    w.write_event(Event::Start(BytesStart::new(tag)))?;
    for (axis, val) in [("X", v[0]), ("Y", v[1]), ("Z", v[2])] {
        w.write_event(Event::Start(BytesStart::new(axis)))?;
        w.write_event(Event::Text(BytesText::new(&val.to_string())))?;
        w.write_event(Event::End(BytesEnd::new(axis)))?;
    }
    w.write_event(Event::End(BytesEnd::new(tag)))?;
    Ok(())
}
