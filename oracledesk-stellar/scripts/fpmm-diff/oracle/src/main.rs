//! JSON-lines RPC over `contracts/market-core/src/math.rs`.
//!
//! Request:  {"id": 17, "fn": "calc_sell", "args": ["1000","1000","100",0]}
//! Response: {"id": 17, "ok": {"shares_in":"212", ...}}
//!        or {"id": 17, "err": "InvalidInput"}
//!
//! Amounts are decimal strings on both sides: i128 does not fit a JSON double.
//! The driver in `scripts/fpmm-diff/diff.py` starts this process once and
//! streams batches through it.

use market_core::math::{self, MathError, Settlement};
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};

fn arg_i128(args: &[Value], i: usize) -> Result<i128, MathError> {
    match args.get(i) {
        Some(Value::String(s)) => s.parse().map_err(|_| MathError::Overflow),
        Some(Value::Number(n)) => n.as_i64().map(i128::from).ok_or(MathError::Overflow),
        _ => Err(MathError::InvalidInput),
    }
}

fn err_name(e: MathError) -> &'static str {
    match e {
        MathError::Overflow => "Overflow",
        MathError::InvalidInput => "InvalidInput",
        MathError::InsufficientLiquidity => "InsufficientLiquidity",
    }
}

/// Canonicalise one result map (all values already decimal strings).
fn run(fn_name: &str, args: &[Value]) -> Result<Map<String, Value>, MathError> {
    let a = |i: usize| arg_i128(args, i);
    let s = |i: usize| -> Result<String, MathError> {
        match args.get(i) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(MathError::InvalidInput),
        }
    };
    let mut out = Map::new();
    match fn_name {
        "mul_div_floor" => {
            out.insert(
                "value".into(),
                json!(math::mul_div_floor(a(0)?, a(1)?, a(2)?)?.to_string()),
            );
        }
        "mul_div_ceil" => {
            out.insert(
                "value".into(),
                json!(math::mul_div_ceil(a(0)?, a(1)?, a(2)?)?.to_string()),
            );
        }
        "price_yes_bps" => {
            out.insert(
                "value".into(),
                json!(math::price_yes_bps(a(0)?, a(1)?)?.to_string()),
            );
        }
        "seed_reserves" => {
            let r = math::seed_reserves(a(0)?, a(1)? as u32)?;
            out.insert("reserve_yes".into(), json!(r.reserve_yes.to_string()));
            out.insert("reserve_no".into(), json!(r.reserve_no.to_string()));
            out.insert("creator_yes".into(), json!(r.creator_yes.to_string()));
            out.insert("creator_no".into(), json!(r.creator_no.to_string()));
        }
        "calc_buy" => {
            let q = math::calc_buy(a(0)?, a(1)?, a(2)?, a(3)? as u32)?;
            out.insert("shares_out".into(), json!(q.shares_out.to_string()));
            out.insert("fee".into(), json!(q.fee.to_string()));
            out.insert("net".into(), json!(q.net.to_string()));
            out.insert(
                "new_reserve_bought".into(),
                json!(q.new_reserve_bought.to_string()),
            );
            out.insert(
                "new_reserve_other".into(),
                json!(q.new_reserve_other.to_string()),
            );
        }
        "calc_sell" => {
            let q = math::calc_sell(a(0)?, a(1)?, a(2)?, a(3)? as u32)?;
            out.insert("shares_in".into(), json!(q.shares_in.to_string()));
            out.insert("fee".into(), json!(q.fee.to_string()));
            out.insert("gross".into(), json!(q.gross.to_string()));
            out.insert(
                "new_reserve_sold".into(),
                json!(q.new_reserve_sold.to_string()),
            );
            out.insert(
                "new_reserve_other".into(),
                json!(q.new_reserve_other.to_string()),
            );
        }
        "settle_value" => {
            let kind = match s(0)?.as_str() {
                "yes" => Settlement::Yes,
                "no" => Settlement::No,
                "void" => Settlement::Void,
                _ => Err(MathError::InvalidInput)?,
            };
            out.insert(
                "value".into(),
                json!(math::settle_value(kind, a(1)?, a(2)?).to_string()),
            );
        }
        "price_after" => {
            let is_yes = match args.first() {
                Some(Value::Bool(b)) => *b,
                Some(Value::String(s)) => s == "true" || s == "yes",
                _ => Err(MathError::InvalidInput)?,
            };
            out.insert(
                "value".into(),
                json!(math::price_after(is_yes, a(1)?, a(2)?)?.to_string()),
            );
        }
        "buy_within_limit" => {
            out.insert(
                "value".into(),
                json!(math::buy_within_limit(a(0)?, a(1)?, a(2)? as u32)?.to_string()),
            );
        }
        "sell_within_limit" => {
            out.insert(
                "value".into(),
                json!(math::sell_within_limit(a(0)?, a(1)?, a(2)? as u32)?.to_string()),
            );
        }
        "calc_sell_shares" => {
            let q = math::calc_sell_shares(a(0)?, a(1)?, a(2)?, a(3)? as u32)?;
            out.insert("collateral_out".into(), json!(q.collateral_out.to_string()));
            out.insert("fee".into(), json!(q.fee.to_string()));
            out.insert("gross".into(), json!(q.gross.to_string()));
            out.insert(
                "new_reserve_sold".into(),
                json!(q.new_reserve_sold.to_string()),
            );
            out.insert(
                "new_reserve_other".into(),
                json!(q.new_reserve_other.to_string()),
            );
        }
        "split_fee" => {
            let (protocol, lp) = math::split_fee(a(0)?, a(1)? as u32)?;
            out.insert("protocol".into(), json!(protocol.to_string()));
            out.insert("lp".into(), json!(lp.to_string()));
        }
        "settle_upper" => {
            let kind = match s(0)?.as_str() {
                "yes" => Settlement::Yes,
                "no" => Settlement::No,
                "void" => Settlement::Void,
                _ => Err(MathError::InvalidInput)?,
            };
            out.insert(
                "value".into(),
                json!(math::settle_upper(kind, a(1)?, a(2)?).to_string()),
            );
        }
        "merge_max" => {
            out.insert("value".into(), json!(math::merge_max(a(0)?, a(1)?).to_string()));
        }
        "isqrt" => {
            let n = a(0)?;
            if n < 0 {
                return Err(MathError::InvalidInput);
            }
            out.insert("value".into(), json!(math::isqrt(n as u128).to_string()));
        }
        _ => return Err(MathError::InvalidInput),
    }
    Ok(out)
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(stdout, "{}", json!({"fatal": e.to_string()}));
                let _ = stdout.flush();
                continue;
            }
        };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let fn_name = value.get("fn").and_then(Value::as_str).unwrap_or("");
        let empty = Vec::new();
        let args = value
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let response = match run(fn_name, args) {
            Ok(ok) => json!({"id": id, "ok": Value::Object(ok)}),
            Err(e) => json!({"id": id, "err": err_name(e)}),
        };
        let _ = writeln!(stdout, "{response}");
        // Batch protocol: the driver sends a chunk and waits for every reply.
        // Flushing per line is cheap relative to a host invocation.
        let _ = stdout.flush();
    }
}
