//! Narrow phase via `ifc-lite-clash` (SPEC §13g, TASKS T11 step 1).
//!
//! One rule's two element groups (metres since load, SPEC §4) go into a
//! `ClashSession` shifted to a local origin before the f32 cast (survey
//! coordinates as f32 lose precision), and every classified pair comes back keyed by
//! its position in group A and group B. The caller keeps everything above
//! the narrow phase (selectors, skips, ClashInfo) and only asks
//! `verdict(i, j)` per pair.

use crate::deep_enough;
use crate::ifc_adapter::IfcElement;
use ifc_lite_clash::{ClashSession, ClashStatus, DistanceKind};
use std::collections::HashMap;

/// Gap within which ifc-lite calls two faces touching rather than
/// clear, metres. At 0 touch counts flipped with float rounding (4 → 2 on
/// one real model after T13); 1 mm is a product decision (SPEC §13g,
/// TASKS T16). Penetrations shallower than this are touches too.
pub const TOUCH_TOLERANCE_METRES: f64 = 0.001;

/// Which narrow phase decides a clash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NarrowPhase {
    #[default]
    Parry,
    Ifclite,
}

impl std::str::FromStr for NarrowPhase {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "parry" => Ok(NarrowPhase::Parry),
            "ifclite" => Ok(NarrowPhase::Ifclite),
            other => Err(format!("narrow phase must be parry or ifclite, not {other:?}")),
        }
    }
}

/// ifc-lite's verdict on one pair, in world metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Verdict {
    pub status: ClashStatus,
    /// Depth (hard) or gap (clearance / touch), metres, never negative.
    pub distance: f64,
    /// Measured on the meshes, or read off the boxes.
    pub kind: DistanceKind,
    /// Contact point.
    pub point: [f64; 3],
}

/// Verdicts by (index in group A, index in group B).
pub type Verdicts = HashMap<(usize, usize), Verdict>;

/// Run one rule through ifc-lite-clash. `clearance` is in metres (0 = hard
/// mode). A rule whose two sides hold the same elements runs in ifc-lite's
/// self-check mode (each pair once) and is keyed both ways round.
pub fn verdicts(group_a: &[IfcElement], group_b: &[IfcElement], clearance: f64) -> Verdicts {
    let self_check = same_elements(group_a, group_b);
    let elements: Vec<&IfcElement> = if self_check {
        group_a.iter().collect()
    } else {
        group_a.iter().chain(group_b).collect()
    };
    let origin = local_origin(&elements);
    let mut session = ClashSession::new();
    ingest(&mut session, &elements, origin);

    let n_a = group_a.len() as u32;
    let a: Vec<u32> = (0..n_a).collect();
    let b: Vec<u32> = (n_a..elements.len() as u32).collect();
    let (mode, group_b_ids) = (u8::from(clearance > 0.0), (!self_check).then_some(b.as_slice()));
    let result = session.run_rule(&a, group_b_ids, mode, TOUCH_TOLERANCE_METRES, clearance, true);

    let mut out = Verdicts::new();
    for r in result.records {
        let verdict = Verdict {
            status: r.status,
            distance: r.distance.abs(),
            kind: r.distance_kind,
            point: [r.point[0] + origin[0], r.point[1] + origin[1], r.point[2] + origin[2]],
        };
        let (i, j) = (r.a.min(r.b) as usize, r.a.max(r.b) as usize);
        if self_check {
            out.insert((i, j), verdict);
            out.insert((j, i), verdict);
        } else {
            out.insert((i, j - n_a as usize), verdict);
        }
    }
    out
}

/// Both sides hold the same elements (same file, same GUIDs, same order).
fn same_elements(a: &[IfcElement], b: &[IfcElement]) -> bool {
    let key = |e: &IfcElement| (e.metadata.source_file.clone(), e.metadata.guid.clone());
    a.len() == b.len() && a.iter().map(key).eq(b.iter().map(key))
}

/// Centre of all elements' boxes, in world metres.
fn local_origin(elements: &[&IfcElement]) -> [f64; 3] {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for e in elements {
        for v in e.mesh.vertices() {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    if elements.is_empty() {
        return [0.0; 3];
    }
    [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0]
}

/// Flat f32 arenas relative to `origin`, as `ClashSession::ingest` wants
/// them.
fn ingest(session: &mut ClashSession, elements: &[&IfcElement], origin: [f64; 3]) {
    let (mut pos, mut pos_ranges, mut idx, mut idx_ranges, mut aabbs) =
        (vec![], vec![], vec![], vec![], vec![]);
    for e in elements {
        let start = pos.len() as u32;
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for v in e.mesh.vertices() {
            for k in 0..3 {
                let c = (v[k] - origin[k]) as f32;
                pos.push(c);
                lo[k] = lo[k].min(c);
                hi[k] = hi[k].max(c);
            }
        }
        pos_ranges.extend([start, pos.len() as u32 - start]);
        let istart = idx.len() as u32;
        idx.extend(e.mesh.indices().iter().flatten());
        idx_ranges.extend([istart, idx.len() as u32 - istart]);
        aabbs.extend(lo.into_iter().chain(hi));
    }
    session.ingest(&pos, &pos_ranges, &idx, &idx_ranges, &aabbs);
}

/// What one pair is, after ifc-lite and (for box estimates) parry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// Not reported, or a hard overlap shallower than the minimum.
    Nothing,
    Clash(Verdict),
    /// Faces in contact: not a clash, counted per rule.
    Touch(Verdict),
    /// ifc-lite says hard but could only estimate the depth from the
    /// boxes, and parry sees no surface crossing: not a clash, counted.
    Unconfirmed(Verdict),
}

/// Decide one pair. Hard mode (`clearance == false`): a measured hard
/// overlap of at least `min_penetration` metres is a clash; a box-estimated
/// one only when `surfaces_cross()` confirms it (product decision,
/// 2026-10-31). In clearance mode everything ifc-lite reports is within the
/// clearance and the distance becomes the gap (0 for overlaps).
pub fn classify(
    verdict: Option<&Verdict>,
    clearance: bool,
    min_penetration: f64,
    surfaces_cross: impl FnOnce() -> anyhow::Result<bool>,
) -> anyhow::Result<Outcome> {
    let Some(&v) = verdict else {
        return Ok(Outcome::Nothing);
    };
    if clearance {
        // Overlapping pairs are within any clearance: gap 0.
        let gap = if v.status == ClashStatus::Hard { 0.0 } else { v.distance };
        return Ok(Outcome::Clash(Verdict { distance: gap, ..v }));
    }
    Ok(match (v.status, v.kind) {
        (ClashStatus::Touch, _) => Outcome::Touch(v),
        (ClashStatus::Hard, _) if !deep_enough(v.distance, min_penetration) => Outcome::Nothing,
        (ClashStatus::Hard, DistanceKind::Mesh) => Outcome::Clash(v),
        (ClashStatus::Hard, DistanceKind::Estimate) if surfaces_cross()? => Outcome::Clash(v),
        (ClashStatus::Hard, DistanceKind::Estimate) => Outcome::Unconfirmed(v),
        (ClashStatus::Clearance, _) => Outcome::Nothing,
    })
}

/// What a record is called in descriptions and BCF titles: listed
/// ifc-lite non-clashes say so ("Touch between …").
pub fn record_noun(status: Option<&str>) -> &'static str {
    match status {
        Some("touch") => "Touch",
        Some("unconfirmed") => "Unconfirmed clash",
        _ => "Clash",
    }
}

/// Labels for the clash record (`status`, `distance_kind`).
pub fn status_label(s: ClashStatus) -> &'static str {
    match s {
        ClashStatus::Hard => "hard",
        ClashStatus::Clearance => "clearance",
        ClashStatus::Touch => "touch",
    }
}

pub fn kind_label(k: DistanceKind) -> &'static str {
    match k {
        DistanceKind::Mesh => "mesh",
        DistanceKind::Estimate => "estimate",
    }
}
