//! Run warnings about coordinate frames (SPEC §4, TASKS T14 B/C): placement
//! checks between files that actually meet in a rule, and BCF coordinates
//! when no file of a rule stays in its own frame.

use crate::{ClashSet, EngineWarning, aabb_overlap_warnings, placement_mismatch_warnings};
use parry3d_f64::bounding_volume::Aabb;
use std::collections::HashMap;
use std::path::PathBuf;

/// `placement_mismatch` and `no_aabb_overlap` per rule, over that rule's
/// files only — two models in separate rules never meet, so their
/// placements don't have to agree. Identical warnings from several rules
/// are reported once; all placement warnings come first.
pub(crate) fn rule_placement_warnings(
    sets: &[ClashSet],
    file_aabbs: &HashMap<PathBuf, Option<Aabb>>,
) -> Vec<EngineWarning> {
    let per_rule: Vec<HashMap<PathBuf, Option<Aabb>>> = sets
        .iter()
        .map(|set| {
            set.a
                .iter()
                .chain(&set.b)
                .filter_map(|g| file_aabbs.get(&g.file).map(|b| (g.file.clone(), *b)))
                .collect()
        })
        .collect();
    let mut warnings: Vec<EngineWarning> = Vec::new();
    let add = |w: EngineWarning, warnings: &mut Vec<EngineWarning>| {
        if !warnings
            .iter()
            .any(|x| x.kind == w.kind && x.message == w.message)
        {
            warnings.push(w);
        }
    };
    for files in &per_rule {
        for w in placement_mismatch_warnings(files) {
            add(w, &mut warnings);
        }
    }
    for files in &per_rule {
        for w in aabb_overlap_warnings(files) {
            add(w, &mut warnings);
        }
    }
    warnings
}

/// Clash points and BCF cameras are in the frame of the untranslated files:
/// a `translation` moves a file into the others' frame. When every side of
/// a rule is translated there is no such file, so the BCF won't line up
/// with any model as exported — warn, naming the rules.
pub(crate) fn bcf_frame_warnings(sets: &[ClashSet]) -> Vec<EngineWarning> {
    let moved = |t: Option<[f64; 3]>| t.is_some_and(|t| t != [0.0, 0.0, 0.0]);
    let rules: Vec<&str> = sets
        .iter()
        .filter(|s| s.a.iter().chain(&s.b).all(|g| moved(g.translation)))
        .map(|s| s.name.as_str())
        .collect();
    if rules.is_empty() {
        return Vec::new();
    }
    vec![EngineWarning {
        kind: "bcf_frame_translated".to_string(),
        message: format!(
            "Every file in rule(s) {} has a translation, so clash points and BCF cameras \
             are in the translated frame and won't line up with any of the models as \
             exported. Leave one file of each rule untranslated (the frame the BCF is \
             for).",
            rules.join(", ")
        ),
        files: Vec::new(),
    }]
}
