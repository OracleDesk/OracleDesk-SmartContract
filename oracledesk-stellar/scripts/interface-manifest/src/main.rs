use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Clone, ValueEnum)]
enum Format {
    Json,
    Text,
}
#[derive(Subcommand)]
enum Action {
    Extract {
        #[arg(long)]
        wasm: PathBuf,
        #[arg(long)]
        contract: String,
    },
    Diff {
        #[arg(long)]
        old: PathBuf,
        #[arg(long)]
        new: PathBuf,
        #[arg(long, value_enum, default_value = "text")]
        format: Format,
    },
    Check {
        #[arg(long)]
        pkg_dir: PathBuf,
        #[arg(long)]
        base_ref: String,
    },
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    match Cli::parse().command {
        Action::Extract { wasm, contract } => print!(
            "{}",
            interface_manifest::canonical(&interface_manifest::extract(
                &std::fs::read(wasm)?,
                &contract
            )?)?
        ),
        Action::Diff { old, new, format } => {
            let a = serde_json::from_slice(&std::fs::read(old)?)?;
            let b = serde_json::from_slice(&std::fs::read(new)?)?;
            let r = interface_manifest::diff::diff(&a, &b);
            match format {
                Format::Text => print!("{}", r.text()),
                Format::Json => println!("{}", serde_json::to_string_pretty(&r)?),
            }
        }
        Action::Check { pkg_dir, base_ref } => println!(
            "{}",
            interface_manifest::policy::check(&pkg_dir, &base_ref)?
        ),
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
