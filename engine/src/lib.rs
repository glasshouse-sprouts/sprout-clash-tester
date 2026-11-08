// Derived from Clashero (MIT). See NOTICE.
pub mod bcf_reporter;
pub mod clash_engine;
mod frame_warnings;
pub mod ifc_adapter;
pub mod ifclite_narrow;
pub mod opening_cuts;
pub mod selector;
pub mod type_objects;

mod legacy_detect;
mod measure;
mod placement;
mod rule_detect;
mod run;

// Public API, unchanged paths (`clash::…`) after the module split.
pub use legacy_detect::{clash_detect, clash_detect_between_groups};
pub use measure::{MeshMeasure, aabb_match, mesh_measure};
pub use placement::{
    build_quick_placement_warning, cluster_origins, cluster_origins_with_tolerance,
};
pub use rule_detect::{clash_detect_rule, deep_enough};
pub use run::{clash_detect_with_config, clash_detect_with_options};

use bcf_reporter::ClashInfo;
use ifclite_narrow::NarrowPhase;
use opening_cuts::OpeningCutStats;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClashSet {
    pub name: String,
    pub a: Vec<SelectionGroup>,
    pub b: Vec<SelectionGroup>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionGroup {
    pub file: PathBuf,
    pub selector: Option<String>,
    pub mode: Option<String>,
    /// Optional selector (same syntax as `selector`) applied AFTER the
    /// include step; matching elements are dropped. Used e.g. by self
    /// checks to skip IfcSpace / IfcOpeningElement. See docs/HOW-IT-WORKS.md#self-check.
    #[serde(default)]
    pub exclude: Option<String>,
    /// Optional `[dx, dy, dz]` translation in metres applied to every
    /// element loaded from `file` before clash detection. Used for edge
    /// cases where the IFCs don't share a coordinate origin. Default =
    /// `None` (no translation). See docs/HOW-IT-WORKS.md#coordinates-and-units.
    #[serde(default)]
    pub translation: Option<[f64; 3]>,
}

/// Structured warning surfaced by the engine. Currently the only kind is
/// `no_aabb_overlap`, fired when two source files have non-overlapping
/// bounding boxes (a strong hint that the models are misaligned).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineWarning {
    /// Stable machine-readable identifier. Today: `"no_aabb_overlap"`.
    pub kind: String,
    /// Human-readable text. Safe to print to stdout/stderr.
    pub message: String,
    /// File names involved in the warning, basenames only (no full paths).
    pub files: Vec<String>,
}

/// Full result of `clash_detect_with_config`: the clashes themselves plus
/// any structured warnings emitted along the way.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub clashes: Vec<ClashInfo>,
    pub warnings: Vec<EngineWarning>,
    /// One entry per rule, in config order (docs/HOW-IT-WORKS.md#related-elements).
    #[serde(default)]
    pub rule_stats: Vec<RuleStat>,
    /// Openings cut out of their hosts, summed over the run's files
    /// (docs/HOW-IT-WORKS.md#opening-cuts).
    #[serde(default)]
    pub opening_cuts: OpeningCutStats,
}

/// Per-rule figures besides the clashes themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleStat {
    pub name: String,
    /// Element pairs skipped because they belong together by IFC
    /// relations (opening in host, door in wall, parts of an assembly).
    pub skipped_by_relations: usize,
    /// ifc-lite narrow phase: touching pairs and unconfirmed box
    /// estimates, not counted as clashes (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase). 0 with
    /// parry.
    #[serde(default)]
    pub touch_count: usize,
    #[serde(default)]
    pub unconfirmed_count: usize,
}

/// Options for `clash_detect_with_options`.
#[derive(Debug, Clone)]
pub struct DetectOptions {
    /// Skip element pairs that belong together by IFC relations
    /// (docs/HOW-IT-WORKS.md#related-elements). Default true.
    pub skip_related: bool,
    /// Cut `IfcRelVoidsElement` openings out of their hosts (docs/HOW-IT-WORKS.md#opening-cuts).
    /// Default true; off only for side-by-side diagnosis.
    pub cut_openings: bool,
    /// Narrow phase and touch reporting (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase). Default
    /// parry.
    pub narrow: NarrowConfig,
}

impl Default for DetectOptions {
    fn default() -> Self {
        DetectOptions { skip_related: true, cut_openings: true, narrow: NarrowConfig::default() }
    }
}

/// GUID pairs that belong together, per source file basename. Pairs only
/// apply within one file — relations never link two models.
pub type RelatedPairs = HashMap<String, HashSet<(String, String)>>;

/// Narrow-phase choice for a run (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase).
#[derive(Debug, Clone, Copy, Default)]
pub struct NarrowConfig {
    pub phase: NarrowPhase,
    /// List touching pairs and unconfirmed box estimates as records
    /// (status `"touch"` / `"unconfirmed"`). ifc-lite phase only.
    pub report_touch: bool,
}

/// Per-rule counts besides the clashes themselves.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RuleCounts {
    pub skipped_by_relations: usize,
    /// ifc-lite: pairs whose faces only touch (not clashes).
    pub touch: usize,
    /// ifc-lite: hard by box estimate, no surface crossing (not clashes).
    pub unconfirmed: usize,
}
