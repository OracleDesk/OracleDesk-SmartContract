//! Computes the commitment hash `contracts/resolver` verifies a revealed
//! resolution spec against (see `docs/adr/0001-resolution-commitment.md` and
//! `docs/adr/0004-spec-versioning.md`). Off-chain dev tool only; never deployed.
//!
//! All hashing delegates to the resolver crate's own `legacy_spec_hash` /
//! `spec_v2_hash`, so the tool cannot drift from the contract.

use resolver::{
    legacy_spec_hash, spec_v2_hash, CatSignerConfig, DisputableSignerConfig, Escalation,
    OracleAsset, PriceConfig, PriceDirection, ResolutionSpec, ResolutionSpecV2, ScalarPriceConfig,
    SignerConfig, WeightedKey, WeightedKeyConfig,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, Vec as SorobanVec};

pub const USAGE: &str = "\
usage:
  spec-hash [V2 FLAGS] signers <threshold> <dispute_window_secs> <signer_G_address>...
  spec-hash [V2 FLAGS] price <reflector_C_address> <asset> <threshold> <direction> <max_staleness_secs>
    <asset> is `stellar:<G_or_C_address>` or `other:<symbol>`
    <direction> is one of: above | at-or-above | below | at-or-below
  spec-hash [V2 FLAGS] weighted-keys <weight_threshold> <dispute_window_secs> <pubkey_hex64>:<weight>...
  spec-hash [V2 FLAGS] signers-disputable <threshold> <dispute_window_secs> <bond_stroops>
      <escalation_timeout_secs> <escalation> <signer_G_address>...
    <escalation> is `guardian` or `committee:<k>:<G_address>,<G_address>...`
  spec-hash [V2 FLAGS] cat-signers <outcome_count> <threshold> <dispute_window_secs> <signer_G_address>...
    <outcome_count> is 2..=8, the number of outcomes of the categorical market
  spec-hash [V2 FLAGS] scalar <reflector_C_address> <asset> <lower> <upper> <max_staleness_secs>
    <asset> is `stellar:<G_or_C_address>` or `other:<symbol>`
    LONG pays `(price - lower) / (upper - lower)` in bps, clamped into the range
  spec-hash [V2 FLAGS] verify <expected_hash_hex> <signers|price|weighted-keys|signers-disputable|cat-signers|scalar> <args>...
  spec-hash gen-salt

V2 FLAGS (all four are required together; without them the legacy hash is printed):
  --v2 --salt <64 hex> --network-passphrase <passphrase> --market-core <C_address>";

pub enum CliError {
    Usage(String),
    Mismatch { expected: String, actual: String },
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        CliError::Usage(message)
    }
}

/// `--v2` envelope parameters, already parsed.
struct V2Params {
    salt: [u8; 32],
    network_id: [u8; 32],
    market_core: String,
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn parse_hex32(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 || !hex.is_ascii() {
        return Err(format!("expected 64 hex characters, got '{hex}'"));
    }
    let mut out = [0u8; 32];
    for (byte, pair) in out.iter_mut().zip(hex.as_bytes().chunks(2)) {
        let pair = std::str::from_utf8(pair).expect("ascii checked above");
        *byte = u8::from_str_radix(pair, 16).map_err(|_| format!("invalid hex '{hex}'"))?;
    }
    Ok(out)
}

/// 32 bytes from the operating system's CSPRNG, for a V2 commitment salt.
pub fn gen_salt() -> Result<[u8; 32], String> {
    let mut salt = [0u8; 32];
    getrandom::fill(&mut salt).map_err(|e| format!("could not read OS randomness: {e}"))?;
    Ok(salt)
}

/// `sha256(passphrase)`: what `env.ledger().network_id()` returns on-chain.
pub fn network_id(env: &Env, passphrase: &str) -> [u8; 32] {
    let digest: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_slice(env, passphrase.as_bytes()))
        .into();
    digest.to_array()
}

fn parse_address(env: &Env, value: &str) -> Result<Address, String> {
    let well_formed = value.len() == 56 && (value.starts_with('G') || value.starts_with('C'));
    if !well_formed {
        return Err(format!("'{value}' is not a G... or C... strkey address"));
    }
    Ok(Address::from_str(env, value))
}

pub fn parse_signers(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [threshold, dispute_window, signers @ ..] = args else {
        return Err("signers needs <threshold> <dispute_window_secs> <signer>...".into());
    };
    if signers.is_empty() {
        return Err("signers needs at least one signer address".into());
    }
    let threshold = threshold
        .parse()
        .map_err(|_| "threshold must be a u32".to_string())?;
    let dispute_window = dispute_window
        .parse()
        .map_err(|_| "dispute_window must be a u64".to_string())?;
    let mut list = SorobanVec::new(env);
    for signer in signers {
        list.push_back(parse_address(env, signer)?);
    }
    Ok(ResolutionSpec::Signers(SignerConfig {
        signers: list,
        threshold,
        dispute_window,
    }))
}

fn parse_asset(env: &Env, value: &str) -> Result<OracleAsset, String> {
    if let Some(address) = value.strip_prefix("stellar:") {
        Ok(OracleAsset::Stellar(parse_address(env, address)?))
    } else if let Some(symbol) = value.strip_prefix("other:") {
        Ok(OracleAsset::Other(Symbol::new(env, symbol)))
    } else {
        Err("asset must be `stellar:<address>` or `other:<symbol>`".into())
    }
}

pub fn parse_price(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [reflector, asset, threshold, direction, max_staleness] = args else {
        return Err(
            "price needs <reflector> <asset> <threshold> <direction> <max_staleness>".into(),
        );
    };
    let asset = parse_asset(env, asset)?;
    let direction = match direction.as_str() {
        "above" => PriceDirection::Above,
        "at-or-above" => PriceDirection::AtOrAbove,
        "below" => PriceDirection::Below,
        "at-or-below" => PriceDirection::AtOrBelow,
        other => {
            return Err(format!(
                "unknown direction '{other}': expected above|at-or-above|below|at-or-below"
            ))
        }
    };
    Ok(ResolutionSpec::Price(PriceConfig {
        reflector: parse_address(env, reflector)?,
        asset,
        threshold: threshold
            .parse()
            .map_err(|_| "threshold must be an i128".to_string())?,
        direction,
        max_staleness: max_staleness
            .parse()
            .map_err(|_| "max_staleness must be a u64".to_string())?,
    }))
}

pub fn parse_scalar(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [reflector, asset, lower, upper, max_staleness] = args else {
        return Err("scalar needs <reflector> <asset> <lower> <upper> <max_staleness>".into());
    };
    Ok(ResolutionSpec::Scalar(ScalarPriceConfig {
        reflector: parse_address(env, reflector)?,
        asset: parse_asset(env, asset)?,
        lower: lower
            .parse()
            .map_err(|_| "lower must be an i128".to_string())?,
        upper: upper
            .parse()
            .map_err(|_| "upper must be an i128".to_string())?,
        max_staleness: max_staleness
            .parse()
            .map_err(|_| "max_staleness must be a u64".to_string())?,
    }))
}

pub fn parse_weighted_keys(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [weight_threshold, dispute_window, keys @ ..] = args else {
        return Err(
            "weighted-keys needs <weight_threshold> <dispute_window_secs> <pubkey>:<weight>..."
                .into(),
        );
    };
    if keys.is_empty() {
        return Err("weighted-keys needs at least one <pubkey_hex64>:<weight>".into());
    }
    let mut signers = SorobanVec::new(env);
    for entry in keys {
        let (pubkey, weight) = entry
            .split_once(':')
            .ok_or_else(|| format!("'{entry}' is not <pubkey_hex64>:<weight>"))?;
        signers.push_back(WeightedKey {
            pubkey: BytesN::from_array(env, &parse_hex32(pubkey)?),
            weight: weight
                .parse()
                .map_err(|_| format!("weight in '{entry}' must be a u32"))?,
        });
    }
    Ok(ResolutionSpec::WeightedKeys(WeightedKeyConfig {
        signers,
        weight_threshold: weight_threshold
            .parse()
            .map_err(|_| "weight_threshold must be a u32".to_string())?,
        dispute_window: dispute_window
            .parse()
            .map_err(|_| "dispute_window must be a u64".to_string())?,
    }))
}

fn parse_escalation(env: &Env, value: &str) -> Result<Escalation, String> {
    if value == "guardian" {
        return Ok(Escalation::Guardian);
    }
    let committee = value
        .strip_prefix("committee:")
        .and_then(|rest| rest.split_once(':'))
        .ok_or_else(|| {
            format!("escalation '{value}' is not `guardian` or `committee:<k>:<addr>,...`")
        })?;
    let k = committee
        .0
        .parse()
        .map_err(|_| "committee k must be a u32".to_string())?;
    let mut members = SorobanVec::new(env);
    for member in committee.1.split(',') {
        members.push_back(parse_address(env, member)?);
    }
    Ok(Escalation::Committee(members, k))
}

pub fn parse_signers_disputable(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [threshold, dispute_window, bond, timeout, escalation, signers @ ..] = args else {
        return Err("signers-disputable needs <threshold> <dispute_window_secs> <bond_stroops> <escalation_timeout_secs> <escalation> <signer>...".into());
    };
    let ResolutionSpec::Signers(base) = parse_signers(
        env,
        &[
            [threshold.clone(), dispute_window.clone()].as_slice(),
            signers,
        ]
        .concat(),
    )?
    else {
        unreachable!("parse_signers returns ResolutionSpec::Signers")
    };
    Ok(ResolutionSpec::SignersDisputable(DisputableSignerConfig {
        signers: base.signers,
        threshold: base.threshold,
        dispute_window: base.dispute_window,
        dispute_bond: bond
            .parse()
            .map_err(|_| "bond must be an i128".to_string())?,
        escalation: parse_escalation(env, escalation)?,
        escalation_timeout: timeout
            .parse()
            .map_err(|_| "escalation_timeout must be a u64".to_string())?,
    }))
}

pub fn parse_cat_signers(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    let [outcome_count, threshold, dispute_window, signers @ ..] = args else {
        return Err(
            "cat-signers needs <outcome_count> <threshold> <dispute_window_secs> <signer>...".into(),
        );
    };
    if signers.is_empty() {
        return Err("cat-signers needs at least one signer address".into());
    }
    let mut list = SorobanVec::new(env);
    for signer in signers {
        list.push_back(parse_address(env, signer)?);
    }
    Ok(ResolutionSpec::CategoricalSigners(CatSignerConfig {
        signers: list,
        threshold: threshold
            .parse()
            .map_err(|_| "threshold must be a u32".to_string())?,
        dispute_window: dispute_window
            .parse()
            .map_err(|_| "dispute_window must be a u64".to_string())?,
        outcome_count: outcome_count
            .parse()
            .map_err(|_| "outcome_count must be a u32".to_string())?,
    }))
}

fn parse_rule(env: &Env, args: &[String]) -> Result<ResolutionSpec, String> {
    match args {
        [kind, rest @ ..] if kind == "signers" => parse_signers(env, rest),
        [kind, rest @ ..] if kind == "price" => parse_price(env, rest),
        [kind, rest @ ..] if kind == "weighted-keys" => parse_weighted_keys(env, rest),
        [kind, rest @ ..] if kind == "signers-disputable" => parse_signers_disputable(env, rest),
        [kind, rest @ ..] if kind == "cat-signers" => parse_cat_signers(env, rest),
        [kind, rest @ ..] if kind == "scalar" => parse_scalar(env, rest),
        _ => Err(
            "expected `signers`, `price`, `weighted-keys`, `signers-disputable`, `cat-signers` or `scalar`"
                .into(),
        ),
    }
}

fn commitment(env: &Env, rule: ResolutionSpec, v2: Option<V2Params>) -> Result<[u8; 32], String> {
    let hash = match v2 {
        None => legacy_spec_hash(env, &rule),
        Some(params) => spec_v2_hash(
            env,
            &ResolutionSpecV2 {
                version: 2,
                network_id: BytesN::from_array(env, &params.network_id),
                market_core: parse_address(env, &params.market_core)?,
                salt: BytesN::from_array(env, &params.salt),
                rule,
            },
        ),
    };
    Ok(hash.to_array())
}

/// Splits `--v2 --salt .. --network-passphrase .. --market-core ..` out of
/// `args`, returning the parsed V2 parameters (if requested) and the rest.
fn take_v2_flags(env: &Env, args: &[String]) -> Result<(Option<V2Params>, Vec<String>), String> {
    let (mut v2, mut salt, mut passphrase, mut market_core) = (false, None, None, None);
    let mut rest = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |flag: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "--v2" => v2 = true,
            "--salt" => salt = Some(value("--salt")?),
            "--network-passphrase" => passphrase = Some(value("--network-passphrase")?),
            "--market-core" => market_core = Some(value("--market-core")?),
            _ => rest.push(arg.clone()),
        }
    }
    if !v2 {
        if salt.is_some() || passphrase.is_some() || market_core.is_some() {
            return Err("--salt/--network-passphrase/--market-core require --v2".into());
        }
        return Ok((None, rest));
    }
    let (Some(salt), Some(passphrase), Some(market_core)) = (salt, passphrase, market_core) else {
        return Err("--v2 requires --salt, --network-passphrase and --market-core".into());
    };
    let params = V2Params {
        salt: parse_hex32(&salt)?,
        network_id: network_id(env, &passphrase),
        market_core,
    };
    Ok((Some(params), rest))
}

/// Runs one invocation and returns the text to print on success.
pub fn run(args: &[String]) -> Result<String, CliError> {
    let env = Env::default();
    if args.first().map(String::as_str) == Some("gen-salt") {
        return Ok(to_hex(&gen_salt()?));
    }
    let (v2, rest) = take_v2_flags(&env, args)?;
    match rest.as_slice() {
        [cmd, expected, rule @ ..] if cmd == "verify" => {
            let expected = parse_hex32(expected)?;
            let actual = commitment(&env, parse_rule(&env, rule)?, v2)?;
            if expected == actual {
                Ok("match".into())
            } else {
                Err(CliError::Mismatch {
                    expected: to_hex(&expected),
                    actual: to_hex(&actual),
                })
            }
        }
        [_, ..] => Ok(to_hex(&commitment(&env, parse_rule(&env, &rest)?, v2)?)),
        [] => Err(CliError::Usage("missing command".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G1: &str = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
    const G2: &str = "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW";
    const G3: &str = "GAJ7BAGE252F636J2HNCRCSFLALJRBY3YQK6DE7Q7DWZECWIR2VOTYZL";
    const C1: &str = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";
    const C2: &str = "CCILJXZCHKAIBTMJ7NSQE756OGLKTOYNSWNNZXWAYZZA4ECAUEC2CNVF";
    const C3: &str = "CCAMJLLDELRB4PCMI5Z526NOEPM7IMUUY2MX6ERSUFOTQBALUGEXCREV";
    const TESTNET: &str = "Test SDF Network ; September 2015";
    const PUBNET: &str = "Public Global Stellar Network ; September 2015";

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn hash_of(parts: &[&str]) -> String {
        match run(&args(parts)) {
            Ok(out) => out,
            Err(CliError::Usage(e)) => panic!("usage error: {e}"),
            Err(CliError::Mismatch { .. }) => panic!("unexpected mismatch"),
        }
    }

    /// The same vectors as `golden` in contracts/resolver: the CLI parsers and
    /// the contract types must produce byte-identical commitments.
    #[test]
    fn golden_legacy_vectors() {
        let vectors: [(&[&str], &str); 6] = [
            (
                &["signers", "1", "5", G1],
                "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4",
            ),
            (
                &["signers", "2", "3600", G1, G2, G3],
                "4373448f97b0dd998a70efd9a1bfd3b3b8639bebaf682d9fc083c11f248a99ee",
            ),
            (
                &["price", C1, "other:XLM", "2000", "above", "10"],
                "b6f2458326d5f76bd9b53a93a103ea6c0fed7129c5496e91e3faef9a9a23d469",
            ),
            (
                &[
                    "price",
                    C1,
                    &format!("stellar:{C2}"),
                    "100",
                    "at-or-above",
                    "300",
                ],
                "fa4cb1bbf39e94a2e699906ddd7228bd0b23ff8c4e968828485dcf3c644dadc2",
            ),
            (
                &["price", C1, "other:XLM", "0", "below", "600"],
                "0236202a346acee0cc18c7c47e4e31b67efa559dc2ff6ac66783f9ea5254f03d",
            ),
            (
                &[
                    "price",
                    C1,
                    &format!("stellar:{C3}"),
                    "7500000000000",
                    "at-or-below",
                    "86400",
                ],
                "c9e1a0fb8443cdf1ea0190af347ff45f54bec12499f3b5111ff81b96b4794570",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hash_of(spec), expected);
        }
    }

    /// Re-derived from hand-built XDR (no Soroban) when this vector was added.
    #[test]
    fn golden_weighted_keys_vector() {
        let (a, b) = ("11".repeat(32), "22".repeat(32));
        assert_eq!(
            hash_of(&[
                "weighted-keys",
                "2",
                "60",
                &format!("{a}:2"),
                &format!("{b}:1")
            ]),
            "1359f80e3d5870663fd88223fc88ae327efb98b585dfd4f853af952a964defda"
        );
    }

    /// The same vectors as `golden_legacy_cat_signer_spec_hashes` in
    /// contracts/resolver: CLI parsing and the contract types must produce
    /// byte-identical commitments.
    #[test]
    fn golden_cat_signers_vectors() {
        let vectors: [(&[&str], &str); 2] = [
            (
                &["cat-signers", "2", "1", "5", G1],
                "16db57d51742d266dccd1a70539afc160971c942605a0ae8f15b5a18cd1b2837",
            ),
            (
                &["cat-signers", "3", "2", "3600", G1, G2, G3],
                "21b750237b5cb3f54bdc71ec55a1d8073a3b860f6cb3cb3b9717570dc42092e7",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hash_of(spec), expected);
        }
    }

    /// Re-derived from hand-built XDR (no Soroban) when these vectors were added.
    #[test]
    fn golden_signers_disputable_vectors() {
        let committee = format!("committee:2:{G2},{G3}");
        let vectors: [(&[&str], &str); 2] = [
            (
                &[
                    "signers-disputable",
                    "1",
                    "100",
                    "250000000",
                    "1000",
                    "guardian",
                    G1,
                ],
                "04010c92f3d4389e3b6b54edf0740c7b6b58f0d5d79aa91253eafbd720716bcc",
            ),
            (
                &[
                    "signers-disputable",
                    "1",
                    "100",
                    "250000000",
                    "1000",
                    &committee,
                    G1,
                ],
                "4b0cd91d8a638b3ea4c819f43b1878afa2bf031055c1dbb33b4ae774fa5748ce",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hash_of(spec), expected);
        }
    }

    /// The same vectors as `golden_legacy_scalar_spec_hashes` in
    /// contracts/resolver: CLI parsing and the contract types must produce
    /// byte-identical commitments, and the scalar space must not collide with
    /// the price space it mirrors.
    #[test]
    fn golden_scalar_vectors() {
        let vectors: [(&[&str], &str); 2] = [
            (
                &["scalar", C1, "other:XLM", "100", "250", "10"],
                "e97c4bccc39a4538850b22e703019c3b69971a00b99bc73117cc67e044e26822",
            ),
            (
                &[
                    "scalar",
                    C1,
                    &format!("stellar:{C2}"),
                    "0",
                    "1000000000000",
                    "300",
                ],
                "1d94380e9112c6f80f7542106dcc75ffc1426a634da2a07440fac72d2033fa08",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hash_of(spec), expected);
        }
        assert_ne!(
            hash_of(&["scalar", C1, "other:XLM", "100", "250", "10"]),
            hash_of(&["price", C1, "other:XLM", "2000", "above", "10"]),
        );
    }

    const SALT: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const V2_GOLDEN: &str = "27e995544f9f631be41177890b7a1be7e17c667e4e531aa08e5089dd899566ae";

    fn v2_args<'a>(salt: &'a str, passphrase: &'a str, market_core: &'a str) -> Vec<&'a str> {
        vec![
            "--v2",
            "--salt",
            salt,
            "--network-passphrase",
            passphrase,
            "--market-core",
            market_core,
            "signers",
            "1",
            "5",
            G1,
        ]
    }

    #[test]
    fn golden_v2_vector() {
        assert_eq!(hash_of(&v2_args(SALT, TESTNET, C2)), V2_GOLDEN);
    }

    #[test]
    fn v2_hash_changes_with_every_binding() {
        let base = hash_of(&v2_args(SALT, TESTNET, C2));
        let other_salt = "ff".repeat(32);
        for variant in [
            v2_args(&other_salt, TESTNET, C2),
            v2_args(SALT, PUBNET, C2),
            v2_args(SALT, TESTNET, C3),
        ] {
            assert_ne!(hash_of(&variant), base);
        }
        assert_ne!(hash_of(&["signers", "1", "5", G1]), base);
    }

    #[test]
    fn network_id_matches_passphrase_hash() {
        use soroban_sdk::testutils::Ledger;
        let env = Env::default();
        assert_eq!(
            to_hex(&network_id(&env, TESTNET)),
            "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472"
        );
        assert_eq!(
            to_hex(&network_id(&env, PUBNET)),
            "7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979"
        );
        env.ledger().set_network_id(network_id(&env, TESTNET));
        assert_eq!(
            env.ledger().network_id().to_array(),
            network_id(&env, TESTNET)
        );
    }

    #[test]
    fn verify_accepts_match_and_reports_mismatch() {
        let hash = hash_of(&["signers", "1", "5", G1]);
        assert_eq!(
            hash_of(&["verify", &hash, "signers", "1", "5", G1]),
            "match"
        );
        let wrong = hash_of(&["signers", "1", "6", G1]);
        let Err(CliError::Mismatch { expected, actual }) =
            run(&args(&["verify", &wrong, "signers", "1", "5", G1]))
        else {
            panic!("expected a mismatch");
        };
        assert_eq!((expected, actual), (wrong, hash));
    }

    #[test]
    fn gen_salt_is_32_random_bytes() {
        let (a, b) = (hash_of(&["gen-salt"]), hash_of(&["gen-salt"]));
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_malformed_input() {
        for bad in [
            args(&["signers", "1", "5"]),
            args(&["signers", "x", "5", G1]),
            args(&["signers", "1", "5", "not-an-address"]),
            args(&["price", C1, "bogus", "1", "above", "1"]),
            args(&["cat-signers", "3", "2", "100"]),
            args(&["cat-signers", "x", "2", "100", G1]),
            args(&["cat-signers", "3", "2", "100", "not-an-address"]),
            args(&["scalar", C1, "other:XLM", "100", "250"]),
            args(&["scalar", C1, "bogus", "100", "250", "10"]),
            args(&["scalar", C1, "other:XLM", "x", "250", "10"]),
            args(&["scalar", C1, "other:XLM", "100", "250", "x"]),
            args(&["weighted-keys", "2", "60", "nocolon"]),
            args(&["weighted-keys", "2", "60", "zz:1"]),
            args(&[
                "signers-disputable",
                "1",
                "100",
                "250000000",
                "1000",
                "sometimes",
                G1,
            ]),
            args(&[
                "signers-disputable",
                "1",
                "100",
                "x",
                "1000",
                "guardian",
                G1,
            ]),
            args(&["--v2", "signers", "1", "5", G1]),
            args(&["--salt", SALT, "signers", "1", "5", G1]),
            args(&["verify", "abcd", "signers", "1", "5", G1]),
            args(&[]),
        ] {
            assert!(matches!(run(&bad), Err(CliError::Usage(_))), "{bad:?}");
        }
    }
}
