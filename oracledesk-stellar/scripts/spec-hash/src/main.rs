//! Prints sha256(XDR(ResolutionSpec)) for a resolution spec given on the
//! command line — the same commitment hash contracts/resolver verifies a
//! revealed spec against (see docs/adr/0001-resolution-commitment.md).
//! Off-chain dev tool only; never deployed.
//!
//! Usage:
//!   spec-hash signers <threshold> <dispute_window_secs> <signer_G_address>...
//!   spec-hash price <reflector_C_address> <asset> <threshold> <direction> <max_staleness_secs>
//!     <asset> is `stellar:<G_or_C_address>` or `other:<symbol>`
//!     <direction> is one of: above | at-or-above | below | at-or-below

use resolver::{OracleAsset, PriceConfig, PriceDirection, ResolutionSpec, SignerConfig};
use soroban_sdk::{xdr::ToXdr, Address, Env, Symbol, Vec};

const USAGE: &str = "\
usage:
  spec-hash signers <threshold> <dispute_window_secs> <signer_G_address>...
  spec-hash price <reflector_C_address> <asset> <threshold> <direction> <max_staleness_secs>
    <asset> is `stellar:<G_or_C_address>` or `other:<symbol>`
    <direction> is one of: above | at-or-above | below | at-or-below";

fn main() {
    let args: std::vec::Vec<std::string::String> = std::env::args().skip(1).collect();
    let env = Env::default();

    let spec = match args.first().map(std::string::String::as_str) {
        Some("signers") => parse_signers(&env, &args[1..]),
        Some("price") => parse_price(&env, &args[1..]),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };

    let hash = env.crypto().sha256(&spec.to_xdr(&env));
    let bytes = hash.to_array();
    let mut hex = std::string::String::with_capacity(64);
    for b in bytes {
        hex.push_str(&std::format!("{b:02x}"));
    }
    println!("{hex}");
}

fn parse_signers(env: &Env, args: &[std::string::String]) -> ResolutionSpec {
    if args.len() < 3 {
        eprintln!("usage: spec-hash signers <threshold> <dispute_window_secs> <signer_G_address>...");
        std::process::exit(2);
    }
    let threshold: u32 = args[0].parse().expect("threshold must be a u32");
    let dispute_window: u64 = args[1].parse().expect("dispute_window must be a u64");
    let signers = Vec::from_slice(
        env,
        &args[2..]
            .iter()
            .map(|s| Address::from_str(env, s))
            .collect::<std::vec::Vec<_>>(),
    );
    ResolutionSpec::Signers(SignerConfig { signers, threshold, dispute_window })
}

fn parse_price(env: &Env, args: &[std::string::String]) -> ResolutionSpec {
    if args.len() != 5 {
        eprintln!(
            "usage: spec-hash price <reflector_C_address> <asset> <threshold> <direction> <max_staleness_secs>"
        );
        std::process::exit(2);
    }
    let reflector = Address::from_str(env, &args[0]);
    let asset = if let Some(rest) = args[1].strip_prefix("stellar:") {
        OracleAsset::Stellar(Address::from_str(env, rest))
    } else if let Some(rest) = args[1].strip_prefix("other:") {
        OracleAsset::Other(Symbol::new(env, rest))
    } else {
        eprintln!("asset must be `stellar:<address>` or `other:<symbol>`");
        std::process::exit(2);
    };
    let threshold: i128 = args[2].parse().expect("threshold must be an i128");
    let direction = match args[3].as_str() {
        "above" => PriceDirection::Above,
        "at-or-above" => PriceDirection::AtOrAbove,
        "below" => PriceDirection::Below,
        "at-or-below" => PriceDirection::AtOrBelow,
        other => {
            eprintln!("unknown direction '{other}': expected above|at-or-above|below|at-or-below");
            std::process::exit(2);
        }
    };
    let max_staleness: u64 = args[4].parse().expect("max_staleness must be a u64");
    ResolutionSpec::Price(PriceConfig { reflector, asset, threshold, direction, max_staleness })
}
