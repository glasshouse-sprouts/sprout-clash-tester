// Derived from Clashero (MIT). See NOTICE.
mod commands;

use anyhow::Result;
use clap::Parser;
use clash::bcf_reporter::{BcfTopic, generate_bcf_topics};
use commands::args::{Cli, Commands};
use std::fs;

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Detect(args) => commands::detect::run(args)?,
        Commands::Bcf { topics, output } => {
            let raw = fs::read_to_string(&topics)?;
            let list: Vec<BcfTopic> = serde_json::from_str(&raw)?;
            generate_bcf_topics(&output, &list)?;
            println!("BCF report generated: {:?} ({} topic(s))", output, list.len());
        }
        Commands::CheckAlignment { input, output } => {
            commands::check_alignment::run(input, output)?
        }
    }

    Ok(())
}
