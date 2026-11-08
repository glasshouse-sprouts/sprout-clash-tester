// Derived from Clashero (MIT). See NOTICE.
//! Command-line arguments (clap).

use clash::ifclite_narrow::NarrowPhase;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Detect clashes between IFC files
    Detect(DetectArgs),
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
    /// the Node side for "one topic per group" exports (docs/HOW-IT-WORKS.md#bcf-topics).
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

#[derive(Args)]
pub struct DetectArgs {
    /// Path to the IFC files (mutually exclusive with --clashSet)
    #[arg(short, long, required_unless_present = "clash_set")]
    pub file: Option<Vec<PathBuf>>,

    /// Path to the JSON clash set configuration (mutually exclusive with --file)
    #[arg(long, required_unless_present = "file")]
    pub clash_set: Option<PathBuf>,

    /// Tolerance for clash detection (meters) — flags elements within this
    /// distance of each other even if they don't physically overlap.
    #[arg(short, long, default_value_t = 0.0)]
    pub tolerance: f64,

    /// Minimum penetration depth (meters) required to report a hard clash.
    /// Elements that merely touch (depth ≈ 0) are ignored.
    /// Default 0.005 m (5 mm). Only applied when --tolerance is 0.
    #[arg(long, default_value_t = 0.005)]
    pub min_penetration: f64,

    /// Output path for the BCF report
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    /// Filter discipline A
    #[arg(long)]
    pub discipline_a: Option<String>,

    /// Filter discipline B
    #[arg(long)]
    pub discipline_b: Option<String>,

    /// Optional path for a structured JSON summary. Written even when
    /// `--output` (BCF) is not. The Node runner reads this file to
    /// get clash counts per rule and any warnings emitted by the engine.
    #[arg(long)]
    pub summary: Option<PathBuf>,

    /// Don't skip element pairs that belong together by IFC relations
    /// (opening in its host, door/window in its wall, parts of the same
    /// assembly). By default those pairs are skipped (docs/HOW-IT-WORKS.md#related-elements).
    #[arg(long)]
    pub no_relation_skip: bool,

    /// Don't cut openings (IfcRelVoidsElement) out of their host
    /// elements. For side-by-side diagnosis only (docs/HOW-IT-WORKS.md#opening-cuts).
    #[arg(long)]
    pub no_opening_cuts: bool,

    /// Narrow phase that decides a clash: `parry` (default) or
    /// `ifclite` (ifc-lite-clash, docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase).
    #[arg(long, default_value = "parry")]
    pub narrow_phase: NarrowPhase,

    /// ifclite only: also list touching pairs and unconfirmed box
    /// estimates (status "touch" / "unconfirmed").
    #[arg(long)]
    pub report_touch: bool,
}
