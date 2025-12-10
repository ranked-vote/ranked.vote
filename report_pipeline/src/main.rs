mod commands;
mod formats;
mod model;
mod normalizers;
mod read_metadata;
mod report;
mod tabulator;
mod util;

use crate::commands::{info, rebuild_index, report, sync};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
struct Opts {
    #[clap(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Validate and dump info about election.
    Info {
        /// Input directory to validate and dump.
        meta_dir: PathBuf,
    },
    /// Sync raw data files with metadata.
    Sync {
        /// Metadata directory
        meta_dir: PathBuf,
        /// Raw data directory
        raw_data_dir: PathBuf,
    },
    /// Generate reports
    Report {
        /// Metadata directory
        meta_dir: PathBuf,
        /// Raw data directory
        raw_data_dir: PathBuf,
        /// Preprocessed file output directory
        preprocessed_dir: PathBuf,
        /// Report output directory
        report_dir: PathBuf,
        /// Whether to use cached preprocessed files if they exist (default: regenerate)
        #[clap(long)]
        use_cache_preprocess: bool,
        /// Whether to use cached report files if they exist (default: regenerate)
        #[clap(long)]
        use_cache_report: bool,
        /// Whether to force preprocessing even if preprocessed files exist (deprecated: use --use-cache-preprocess=false)
        #[clap(long, hide = true)]
        force_preprocess: bool,
        /// Whether to force report generation even if report files exist (deprecated: use --use-cache-report=false)
        #[clap(long, hide = true)]
        force_report: bool,
        /// Optional jurisdiction filter (e.g., "us/ca/alameda")
        #[clap(long)]
        jurisdiction: Option<String>,
    },
    /// Rebuild index.json from existing reports
    RebuildIndex {
        /// Report output directory
        report_dir: PathBuf,
    },
}

fn main() {
    let opts = Opts::parse();

    match opts.command {
        Command::Info { meta_dir } => {
            info(&meta_dir);
        }
        Command::Sync {
            meta_dir,
            raw_data_dir,
        } => {
            sync(&meta_dir, &raw_data_dir);
        }
        Command::Report {
            meta_dir,
            raw_data_dir,
            preprocessed_dir,
            report_dir,
            use_cache_preprocess,
            use_cache_report,
            force_preprocess,
            force_report,
            jurisdiction,
        } => {
            // Support deprecated flags for backward compatibility
            // If old flags are used, convert them to new cache flags
            let use_cache_preprocess = if force_preprocess {
                false
            } else {
                use_cache_preprocess
            };
            let use_cache_report = if force_report {
                false
            } else {
                use_cache_report
            };

            // By default (when flags are false), regenerate everything
            // Only use cache if explicitly requested
            // If regenerating reports, also regenerate preprocessing
            let force_preprocess_final = !use_cache_preprocess || !use_cache_report;
            let force_report_final = !use_cache_report;

            report(
                &meta_dir,
                &raw_data_dir,
                &report_dir,
                &preprocessed_dir,
                force_preprocess_final,
                force_report_final,
                jurisdiction.as_deref(),
            );
        }
        Command::RebuildIndex { report_dir } => {
            rebuild_index(&report_dir);
        }
    }
}
