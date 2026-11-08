//! `clash check-alignment`: quick pre-flight placement check from each
//! file's IFCSITE origin (no geometry pass).

use anyhow::Result;
use clash::ifc_adapter::{
    MapConversion, extract_active_length_unit_from_str, extract_map_conversion_from_str,
    extract_site_origin_from_str,
};
use clash::{EngineWarning, build_quick_placement_warning, cluster_origins_with_tolerance};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Threshold for the pre-detection IFCSITE check — kept in sync with
/// the `QUICK_CLUSTER_TOLERANCE_METRES` constant in placement.rs.
const QUICK_TOLERANCE_M: f64 = 10.0;

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

pub fn run(input: PathBuf, output: Option<PathBuf>) -> Result<()> {
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
    Ok(())
}
