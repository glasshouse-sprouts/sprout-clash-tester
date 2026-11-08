// Derived from Clashero (MIT). See NOTICE.
use anyhow::Result;
use clap::{Parser, Subcommand};
use clash::opening_cuts::OpeningCutStats;
use clash::bcf_reporter::{BcfTopic, generate_bcf, generate_bcf_topics};
use clash::ifc_adapter::{
    MapConversion, extract_active_length_unit_from_str, extract_map_conversion_from_str,
    extract_site_origin_from_str,
};
use clash::ifclite_narrow::NarrowPhase;
use clash::{
    DetectOptions, DetectionResult, EngineWarning, NarrowConfig, build_quick_placement_warning,
    clash_detect_with_options,
    cluster_origins_with_tolerance,
};

/// Threshold for the pre-detection IFCSITE check — kept in sync with
/// the `QUICK_CLUSTER_TOLERANCE_METRES` constant in lib.rs.
const QUICK_TOLERANCE_M: f64 = 10.0;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Detect clashes between IFC files
    Detect {
        /// Path to the IFC files (mutually exclusive with --clashSet)
        #[arg(short, long, required_unless_present = "clash_set")]
        file: Option<Vec<PathBuf>>,

        /// Path to the JSON clash set configuration (mutually exclusive with --file)
        #[arg(long, required_unless_present = "file")]
        clash_set: Option<PathBuf>,

        /// Tolerance for clash detection (meters) — flags elements within this
        /// distance of each other even if they don't physically overlap.
        #[arg(short, long, default_value_t = 0.0)]
        tolerance: f64,

        /// Minimum penetration depth (meters) required to report a hard clash.
        /// Elements that merely touch (depth ≈ 0) are ignored.
        /// Default 0.005 m (5 mm). Only applied when --tolerance is 0.
        #[arg(long, default_value_t = 0.005)]
        min_penetration: f64,

        /// Output path for the BCF report
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Filter discipline A
        #[arg(long)]
        discipline_a: Option<String>,

        /// Filter discipline B
        #[arg(long)]
        discipline_b: Option<String>,

        /// Optional path for a structured JSON summary. Written even when
        /// `--output` (BCF) is not. The Node runner reads this file to
        /// get clash counts per rule and any warnings emitted by the engine.
        #[arg(long)]
        summary: Option<PathBuf>,

        /// Don't skip element pairs that belong together by IFC relations
        /// (opening in its host, door/window in its wall, parts of the same
        /// assembly). By default those pairs are skipped (SPEC §13e).
        #[arg(long)]
        no_relation_skip: bool,

        /// Don't cut openings (IfcRelVoidsElement) out of their host
        /// elements. For side-by-side diagnosis only (SPEC §13f).
        #[arg(long)]
        no_opening_cuts: bool,

        /// Narrow phase that decides a clash: `parry` (default) or
        /// `ifclite` (ifc-lite-clash, SPEC §13g).
        #[arg(long, default_value = "parry")]
        narrow_phase: NarrowPhase,

        /// ifclite only: also list touching pairs and unconfirmed box
        /// estimates (status "touch" / "unconfirmed").
        #[arg(long)]
        report_touch: bool,
    },
    /// Quick pre-flight check: read each file's IFCSITE origin (no
    /// geometry pass) and cluster them. Reports placement mismatches
    /// **before** the user pays for a full clash detection run.
    CheckAlignment {
        /// Path to a JSON file containing an array of
        /// `{ "file": "...", "translation": [dx, dy, dz] }` entries.
        /// Translation is in metres and optional.
        #[arg(long)]
        input: PathBuf,
        /// Where to write the structured result. JSON is also printed
        /// to stdout regardless.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Write a BCF from a ready-made topic list (no detection). Used by
    /// the Node side for "one topic per group" exports (SPEC §13c).
    Bcf {
        /// JSON array of topics:
        /// `{ title, description?, position, camera_eye?, guids[] }`.
        #[arg(long)]
        topics: PathBuf,
        /// Output path for the BCF report.
        #[arg(short, long)]
        output: PathBuf,
    },
}

#[derive(Deserialize)]
struct AlignmentInputEntry {
    file: PathBuf,
    #[serde(default)]
    translation: Option<[f64; 3]>,
}

#[derive(Serialize)]
struct AlignmentFileEntry {
    path: String,
    /// Origin in metres as read from IFCSITE (zero if none found).
    origin: [f64; 3],
    /// Origin + translation in metres.
    effective_origin: [f64; 3],
    /// Cluster label this file belongs to (A, B, …).
    cluster: String,
    /// "millimetre", "metre", …
    length_unit: String,
    /// IfcMapConversion data, when the file has one. Used to spot
    /// "mixed export origin" cases — see the `mapconversion_split` note.
    map_conversion: Option<MapConversionDto>,
}

#[derive(Serialize)]
struct MapConversionDto {
    eastings: f64,
    northings: f64,
    orthogonal_height: f64,
}

#[derive(Serialize)]
struct AlignmentCluster {
    label: String,
    centre: [f64; 3],
    files: Vec<String>,
}

#[derive(Serialize)]
struct AlignmentResult<'a> {
    files: Vec<AlignmentFileEntry>,
    clusters: Vec<AlignmentCluster>,
    warnings: &'a [EngineWarning],
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Detect {
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
        } => {
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
        }
        Commands::Bcf { topics, output } => {
            let raw = fs::read_to_string(&topics)?;
            let list: Vec<BcfTopic> = serde_json::from_str(&raw)?;
            generate_bcf_topics(&output, &list)?;
            println!("BCF report generated: {:?} ({} topic(s))", output, list.len());
        }
        Commands::CheckAlignment { input, output } => {
            let input_raw = fs::read_to_string(&input)?;
            let entries: Vec<AlignmentInputEntry> = serde_json::from_str(&input_raw)?;

            // Read each file's IFCSITE origin + length unit + (optional)
            // IFCMAPCONVERSION (purely text-parsing — no geometry pass).
            // Apply any user-supplied translation, then cluster.
            let mut files: Vec<(
                PathBuf,
                [f64; 3],
                [f64; 3],
                String,
                Option<MapConversion>,
            )> = Vec::new();
            for e in &entries {
                let content = fs::read_to_string(&e.file)?;
                let unit = extract_active_length_unit_from_str(&content);
                let unit_scale: f64 = match unit.as_str() {
                    "millimetre" => 0.001,
                    "centimetre" => 0.01,
                    "decimetre" => 0.1,
                    "meter" | "metre" => 1.0,
                    "inch" => 0.0254,
                    "foot" => 0.3048,
                    _ => 1.0,
                };
                let raw = extract_site_origin_from_str(&content);
                let origin_m = [raw[0] * unit_scale, raw[1] * unit_scale, raw[2] * unit_scale];
                let t = e.translation.unwrap_or([0.0, 0.0, 0.0]);
                let effective = [
                    origin_m[0] + t[0],
                    origin_m[1] + t[1],
                    origin_m[2] + t[2],
                ];
                let mc = extract_map_conversion_from_str(&content);
                files.push((e.file.clone(), origin_m, effective, unit, mc));
            }

            // Cluster on effective origins (post-translation).
            let cluster_input: Vec<(PathBuf, [f64; 3])> = files
                .iter()
                .map(|(p, _, eff, _, _)| (p.clone(), *eff))
                .collect();
            let clusters = cluster_origins_with_tolerance(cluster_input, QUICK_TOLERANCE_M);
            let mut warnings = build_quick_placement_warning(&clusters);

            // ── Detect mixed export-origin (IfcMapConversion split) ──
            // If at least one file has IFCMAPCONVERSION but at least one
            // doesn't (OR all have it but eastings/northings differ
            // substantially) — flag it. Clash detection ignores
            // IfcMapConversion, so the engine still finds real overlaps,
            // but georef-aware viewers (like Model Viewer) will place
            // these files in different positions.
            let with_mc: Vec<&PathBuf> = files
                .iter()
                .filter_map(|(p, _, _, _, mc)| mc.as_ref().map(|_| p))
                .collect();
            let without_mc: Vec<&PathBuf> = files
                .iter()
                .filter_map(|(p, _, _, _, mc)| if mc.is_none() { Some(p) } else { None })
                .collect();
            let mc_values_differ = {
                let vals: Vec<&MapConversion> = files
                    .iter()
                    .filter_map(|(_, _, _, _, mc)| mc.as_ref())
                    .collect();
                if vals.len() < 2 {
                    false
                } else {
                    let first = vals[0];
                    vals.iter().skip(1).any(|v| {
                        (v.eastings - first.eastings).abs() > 1.0
                            || (v.northings - first.northings).abs() > 1.0
                            || (v.orthogonal_height - first.orthogonal_height).abs() > 1.0
                    })
                }
            };
            let mc_mixed = !with_mc.is_empty() && !without_mc.is_empty();
            if mc_mixed || mc_values_differ {
                let names: Vec<String> = files
                    .iter()
                    .map(|(p, _, _, _, _)| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("?")
                            .to_string()
                    })
                    .collect();
                let detail = if mc_mixed {
                    format!(
                        "Some files carry IfcMapConversion ({}) but others don't ({}).",
                        with_mc
                            .iter()
                            .map(|p| p
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("?"))
                            .collect::<Vec<_>>()
                            .join(", "),
                        without_mc
                            .iter()
                            .map(|p| p
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("?"))
                            .collect::<Vec<_>>()
                            .join(", "),
                    )
                } else {
                    "IfcMapConversion is present on all files but with different eastings/northings.".to_string()
                };
                warnings.push(EngineWarning {
                    kind: "mapconversion_split".to_string(),
                    message: format!(
                        "{} Clash detection ignores IfcMapConversion and will find real overlaps correctly — but georef-aware viewers (Model Viewer, BIMcollab, …) may place these files in different positions. Re-export from Revit with consistent Shared Coordinates for visual consistency too.",
                        detail
                    ),
                    files: names,
                });
            }

            // Build label per file by looking up which cluster contains it.
            let cluster_labels: Vec<(String, [f64; 3], Vec<String>)> = clusters
                .iter()
                .enumerate()
                .map(|(i, (paths, centre))| {
                    let label: String = if i < 26 {
                        ((b'A' + i as u8) as char).to_string()
                    } else {
                        format!("#{}", i + 1)
                    };
                    let names = paths
                        .iter()
                        .map(|p| {
                            p.file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("?")
                                .to_string()
                        })
                        .collect::<Vec<_>>();
                    (label, *centre, names)
                })
                .collect();

            let file_entries: Vec<AlignmentFileEntry> = files
                .iter()
                .map(|(path, origin, effective, unit, mc)| {
                    let label = cluster_labels
                        .iter()
                        .find(|(_, _, names)| {
                            names.iter().any(|n| {
                                path.file_name()
                                    .and_then(|x| x.to_str())
                                    .map(|x| x == n)
                                    .unwrap_or(false)
                            })
                        })
                        .map(|(l, _, _)| l.clone())
                        .unwrap_or_default();
                    AlignmentFileEntry {
                        path: path.to_string_lossy().into_owned(),
                        origin: *origin,
                        effective_origin: *effective,
                        cluster: label,
                        length_unit: unit.clone(),
                        map_conversion: mc.as_ref().map(|m| MapConversionDto {
                            eastings: m.eastings,
                            northings: m.northings,
                            orthogonal_height: m.orthogonal_height,
                        }),
                    }
                })
                .collect();

            let cluster_out: Vec<AlignmentCluster> = cluster_labels
                .iter()
                .map(|(label, centre, names)| AlignmentCluster {
                    label: label.clone(),
                    centre: *centre,
                    files: names.clone(),
                })
                .collect();

            let result = AlignmentResult {
                files: file_entries,
                clusters: cluster_out,
                warnings: &warnings,
            };
            let json = serde_json::to_string_pretty(&result)?;
            if let Some(out) = output {
                fs::write(&out, &json)?;
            }
            // Always echo to stdout so the Node runner can read either path.
            println!("{}", json);
            for w in &warnings {
                eprintln!("WARNING: {}: {}", w.kind, w.message);
            }
        }
    }

    Ok(())
}
