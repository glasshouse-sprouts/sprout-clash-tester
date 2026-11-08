//! `clash detect`: run detection, write the BCF and the JSON summary.

use super::args::DetectArgs;
use anyhow::Result;
use clash::bcf_reporter::generate_bcf;
use clash::opening_cuts::OpeningCutStats;
use clash::{DetectOptions, DetectionResult, EngineWarning, NarrowConfig, clash_detect_with_options};
use serde::Serialize;
use std::fs;
use std::time::Instant;

/// JSON sidecar shape the CLI writes when `--summary <path>` is given.
/// Stable contract — `@clash-tester/core`'s runner reads this.
#[derive(Serialize)]
struct CliSummary<'a> {
    total_clashes: usize,
    warnings: &'a [EngineWarning],
    /// Per-rule counts. Empty when `--file` is used (no rule names).
    per_rule: Vec<RuleCount<'a>>,
    /// All clashes broken down for downstream consumers (CSV writer, MCP,
    /// agents). Each entry carries the rule name plus the two IFC GUIDs
    /// and types involved. Position is in world metres.
    clashes: Vec<ClashSummaryEntry>,
    /// Where the BCF was written, if `--output` was given.
    bcf_path: Option<String>,
    /// Openings cut out of their hosts (SPEC §13f). Absent on the legacy
    /// `--file` path, which has no run-level total.
    opening_cuts: Option<&'a OpeningCutStats>,
}

#[derive(Serialize)]
struct RuleCount<'a> {
    name: &'a str,
    clashes: usize,
    /// Pairs skipped because they belong together by IFC relations
    /// (SPEC §13e). 0 when the skip is off.
    skipped_by_relations: usize,
    /// ifc-lite narrow phase: touching pairs / unconfirmed box estimates,
    /// not clashes (SPEC §13g). 0 with parry.
    touch_count: usize,
    unconfirmed_count: usize,
}

#[derive(Serialize)]
struct ClashSummaryEntry {
    /// Rule that fired (empty when the legacy `--file` path is used).
    rule: String,
    ifc_type_a: String,
    ifc_type_b: String,
    guid_a: String,
    guid_b: String,
    /// Basename of the file element A came from. Empty when unknown.
    file_a: String,
    /// Basename of the file element B came from. Empty when unknown.
    file_b: String,
    /// World position of the clash midpoint in metres.
    position: [f64; 3],
    /// Detection mode: "intersection" or "clearance".
    mode: String,
    /// Approximate penetration depth in metres (intersection mode only).
    depth_metres: Option<f64>,
    /// Clearance gap in metres (clearance mode only).
    gap_metres: Option<f64>,
    /// AABB-overlap extents `[dx, dy, dz]` in metres.
    aabb_overlap_extents: Option<[f64; 3]>,
    /// AABB-overlap volume in m³ — dx·dy·dz. Bounding-box volume, not
    /// true geometric overlap volume.
    aabb_overlap_volume: Option<f64>,
    /// Bounding-box similarity 0..1 (1 = identical boxes). Near 1 means
    /// "possibly modelled twice".
    aabb_match: Option<f64>,
    /// Mesh volume of element A / B in m³ (None for flat meshes).
    volume_a: Option<f64>,
    volume_b: Option<f64>,
    /// Distance between the two mesh centres in metres.
    centroid_distance: Option<f64>,
    /// ifc-lite only: "hard" / "clearance" / "touch" / "unconfirmed".
    status: Option<String>,
    /// ifc-lite only: "mesh" (measured) or "estimate" (from the boxes).
    distance_kind: Option<String>,
    /// Class from the type object when A / B is a generic IFC2X3-style
    /// occurrence (`IfcFlowSegment` → `IfcDuctSegment`), SPEC §6.
    type_class_a: Option<String>,
    type_class_b: Option<String>,
    /// `PredefinedType` of A / B (occurrence, else type object).
    predefined_type_a: Option<String>,
    predefined_type_b: Option<String>,
}

/// Parse the `description` field of a ClashInfo into its structured pieces.
///
/// Engine emits descriptions in two formats:
///   `[RuleName] Clash between IfcTypeA (guidA) and IfcTypeB (guidB)`
///   `Clash between IfcTypeA (guidA) and IfcTypeB (guidB)`
///
/// If the format ever drifts, this function falls back to leaving the
/// rule name empty and zero-filling the IFC types so the JSON stays
/// well-formed.
fn split_description(desc: &str) -> (String, String, String) {
    // (rule, type_a, type_b)
    let (rule, rest) = if let Some(rest) = desc.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let r = rest[..end].to_string();
            (r, rest[end + 1..].trim_start().to_string())
        } else {
            (String::new(), desc.to_string())
        }
    } else {
        (String::new(), desc.to_string())
    };
    // After the rule, the format is "Clash between <typeA> (...) and <typeB> (...)"
    // ("Touch between" / "Unconfirmed clash between" for listed ifc-lite
    // non-clashes, SPEC §13g).
    let body = rest.split_once(" between ").map_or(rest.as_str(), |(_, b)| b);
    let parts: Vec<&str> = body.splitn(2, " and ").collect();
    let type_a = parts
        .first()
        .map(|p| p.split(" (").next().unwrap_or("").to_string())
        .unwrap_or_default();
    let type_b = parts
        .get(1)
        .map(|p| p.split(" (").next().unwrap_or("").to_string())
        .unwrap_or_default();
    (rule, type_a, type_b)
}

pub fn run(args: DetectArgs) -> Result<()> {
    let DetectArgs {
        file,
        clash_set,
        tolerance,
        min_penetration,
        output,
        discipline_a,
        discipline_b,
        summary,
        no_relation_skip,
        no_opening_cuts,
        narrow_phase,
        report_touch,
    } = args;
    let start_time = Instant::now();
    println!("Starting clash detection...");
    if tolerance == 0.0 {
        println!("Mode: hard intersection (min penetration: {} mm)", min_penetration * 1000.0);
    } else {
        println!("Mode: clearance (tolerance: {} mm)", tolerance * 1000.0);
    }

    let is_rule_run = clash_set.is_some();
    let result: DetectionResult = if let Some(cs_path) = clash_set {
        println!("Using clash set configuration: {:?}", cs_path);
        let config_json = fs::read_to_string(cs_path)?;
        let options = DetectOptions {
            skip_related: !no_relation_skip,
            cut_openings: !no_opening_cuts,
            narrow: NarrowConfig { phase: narrow_phase, report_touch },
        };
        clash_detect_with_options(&config_json, tolerance, min_penetration, &discipline_a, &discipline_b, &options)?
    } else if let Some(files) = file {
        println!("Files: {:?}", files);
        let (_count, clashes) = clash::clash_detect(
            &files,
            tolerance,
            min_penetration,
            &discipline_a,
            &discipline_b,
            &None,
            &None,
        )?;
        // The legacy --file path doesn't compute per-file AABB
        // warnings (it merges everything into one pool).
        DetectionResult {
            clashes,
            warnings: Vec::new(),
            rule_stats: Vec::new(),
            opening_cuts: OpeningCutStats::default(),
        }
    } else {
        return Err(anyhow::anyhow!(
            "Either --file or --clashSet must be provided"
        ));
    };

    let clash_count = result.clashes.len();
    let duration = start_time.elapsed();
    println!("\nClash Detection Summary:");
    println!("------------------------");
    println!("Total Clashes: {}", clash_count);
    println!("Execution Time: {:?}", duration);
    if !result.warnings.is_empty() {
        println!("Warnings: {}", result.warnings.len());
    }

    let bcf_path = if let Some(out) = output {
        println!("Generating BCF report: {:?}", out);
        generate_bcf(&out, &result.clashes)?;
        println!("BCF report generated successfully.");
        Some(out.to_string_lossy().into_owned())
    } else {
        None
    };

    if let Some(sum_path) = summary {
        // Build per-clash structured entries from each ClashInfo
        // description. This is the data CSV writers / agents need.
        let entries: Vec<ClashSummaryEntry> = result
            .clashes
            .iter()
            .map(|c| {
                let (rule, type_a, type_b) = split_description(&c.description);
                ClashSummaryEntry {
                    rule,
                    ifc_type_a: type_a,
                    ifc_type_b: type_b,
                    guid_a: c.guid_a.clone(),
                    guid_b: c.guid_b.clone(),
                    file_a: c.file_a.clone(),
                    file_b: c.file_b.clone(),
                    position: c.position,
                    mode: c.mode.clone(),
                    depth_metres: c.depth_metres,
                    gap_metres: c.gap_metres,
                    aabb_overlap_extents: c.aabb_overlap_extents,
                    aabb_overlap_volume: c.aabb_overlap_volume,
                    aabb_match: c.aabb_match,
                    volume_a: c.volume_a,
                    volume_b: c.volume_b,
                    centroid_distance: c.centroid_distance,
                    status: c.status.clone(),
                    distance_kind: c.distance_kind.clone(),
                    type_class_a: c.type_class_a.clone(),
                    type_class_b: c.type_class_b.clone(),
                    predefined_type_a: c.predefined_type_a.clone(),
                    predefined_type_b: c.predefined_type_b.clone(),
                }
            })
            .collect();
        // Per-rule counts derived from the same structured data.
        let mut per_rule_map: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for e in &entries {
            if !e.rule.is_empty() {
                *per_rule_map.entry(e.rule.clone()).or_insert(0) += 1;
            }
        }
        // A rule whose every overlap was a related pair (or only
        // touched) still gets a row, so the user sees why it
        // reports nothing.
        let stats: std::collections::HashMap<&str, &clash::RuleStat> =
            result.rule_stats.iter().map(|r| (r.name.as_str(), r)).collect();
        for r in &result.rule_stats {
            if r.skipped_by_relations + r.touch_count + r.unconfirmed_count > 0 {
                per_rule_map.entry(r.name.clone()).or_insert(0);
            }
        }
        let per_rule: Vec<RuleCount> = per_rule_map
            .iter()
            .map(|(name, &clashes)| {
                let stat = stats.get(name.as_str());
                RuleCount {
                    name: name.as_str(),
                    clashes,
                    skipped_by_relations: stat.map_or(0, |s| s.skipped_by_relations),
                    touch_count: stat.map_or(0, |s| s.touch_count),
                    unconfirmed_count: stat.map_or(0, |s| s.unconfirmed_count),
                }
            })
            .collect();
        let summary_struct = CliSummary {
            total_clashes: clash_count,
            warnings: &result.warnings,
            per_rule,
            clashes: entries,
            bcf_path: bcf_path.clone(),
            opening_cuts: is_rule_run.then_some(&result.opening_cuts),
        };
        fs::write(&sum_path, serde_json::to_string_pretty(&summary_struct)?)?;
        println!("Summary written: {:?}", sum_path);
    }
    Ok(())
}
