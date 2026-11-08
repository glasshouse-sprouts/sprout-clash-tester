//! Run warnings about coordinate frames (docs/HOW-IT-WORKS.md#placement-checks): placement
//! checks between files that actually meet in a rule, and BCF coordinates
//! when no file of a rule stays in its own frame.

use crate::placement::placement_mismatch_warnings;
use crate::{ClashSet, EngineWarning};
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

/// After all files are loaded, do a pairwise AABB-overlap check between
/// every pair of files. If a pair doesn't overlap **and** both files
/// contributed at least one element, emit a `no_aabb_overlap` warning.
/// Disjoint AABBs almost always mean the models aren't aligned.
///
/// This complements `placement_mismatch_warnings`: that one fires when
/// clusters are >0.5 m apart by centre (may still have overlapping
/// AABBs for large files); this one fires when the AABBs are truly
/// disjoint (the more extreme symptom).
fn aabb_overlap_warnings(file_aabbs: &HashMap<PathBuf, Option<Aabb>>) -> Vec<EngineWarning> {
    // Stable order so warnings are deterministic.
    let mut entries: Vec<(&PathBuf, &Aabb)> = file_aabbs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|a| (k, a)))
        .collect();
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));

    let mut warnings = Vec::new();
    for i in 0..entries.len() {
        for j in (i + 1)..entries.len() {
            let (path_i, aabb_i) = entries[i];
            let (path_j, aabb_j) = entries[j];
            if aabb_i.intersection(aabb_j).is_none() {
                let name_i = path_i
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                let name_j = path_j
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                warnings.push(EngineWarning {
                    kind: "no_aabb_overlap".to_string(),
                    message: format!(
                        "files {} and {} don't overlap in space — possibly misaligned, clash count may be unreliable",
                        name_i, name_j
                    ),
                    files: vec![name_i, name_j],
                });
            }
        }
    }
    warnings
}
