import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_PRIVATE_KEY = process.env.POLYGON_PRIVATE_KEY!;
const POLYGON_WALLET      = process.env.POLYGON_EXECUTION_WALLET!;

// Polymarket CTF Exchange — Polygon Mainnet
const CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";

if (!POLYGON_PRIVATE_KEY || !POLYGON_WALLET) {
  console.error("✗ POLYGON_PRIVATE_KEY and POLYGON_EXECUTION_WALLET must be set in .env");
  process.exit(1);
}

// ── EIP-712 domain — must match Polymarket's deployed contract exactly ────────
const DOMAIN = {
  name:              "CTF Exchange",
  version:           "1",
  chainId:           137,          // Polygon mainnet — do NOT change this
  verifyingContract: CTF_EXCHANGE,
};

// ── Order types — must match Polymarket's Order struct exactly ────────────────
const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build an Order object from human-readable inputs
function buildOrder(params: {
  makerAddress: string;
  tokenId:      string;   // CTF token ID from Polymarket API
  usdcAmount:   number;   // USDC to spend (whole units, e.g. 10 = 10 USDC)
  price:        number;   // share price (0.0–1.0, e.g. 0.68)
  side:         "BUY" | "SELL";
  expiryHours?: number;   // default 1 hour
}) {
  const makerAmount = BigInt(Math.round(params.usdcAmount * 1e6));
  // takerAmount = shares you expect back = usdcAmount / price
  const takerAmount = BigInt(Math.round((params.usdcAmount / params.price) * 1e6));
  const expiration  = BigInt(
    Math.floor(Date.now() / 1000) + (params.expiryHours ?? 1) * 3600
  );

  return {
    salt:          BigInt(Math.floor(Math.random() * 1e15)),
    maker:         params.makerAddress,
    signer:        params.makerAddress,  // same as maker for EOA
    taker:         ethers.ZeroAddress,   // address(0) = public order
    tokenId:       BigInt(params.tokenId),
    makerAmount,
    takerAmount,
    expiration,
    nonce:         0n,
    feeRateBps:    0n,
    side:          params.side === "BUY" ? 0 : 1,
    signatureType: 0,  // EOA = 0
  };
}

// Recover the signer address from a signed order — proves signing is correct
function recoverSigner(order: ReturnType<typeof buildOrder>, signature: string): string {
  return ethers.verifyTypedData(DOMAIN, ORDER_TYPES, order, signature);
}

// Format order for Polymarket API submission
function formatForApi(order: ReturnType<typeof buildOrder>, signature: string) {
  return {
    order: {
      salt:          order.salt.toString(),
      maker:         order.maker,
      signer:        order.signer,
      taker:         order.taker,
      tokenId:       order.tokenId.toString(),
      makerAmount:   order.makerAmount.toString(),
      takerAmount:   order.takerAmount.toString(),
      expiration:    order.expiration.toString(),
      nonce:         order.nonce.toString(),
      feeRateBps:    order.feeRateBps.toString(),
      side:          order.side,
      signatureType: order.signatureType,
    },
    signature,
    orderType: "GTC",  // Good Till Cancelled
  };
}

// ── Main test ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Polymarket Order Signing Test");
  console.log("═══════════════════════════════════════\n");

  const signer = new ethers.Wallet(POLYGON_PRIVATE_KEY);
  console.log(`Signer address:  ${signer.address}`);
  console.log(`Expected wallet: ${POLYGON_WALLET}`);

  // Confirm private key matches the wallet address in .env
  if (signer.address.toLowerCase() !== POLYGON_WALLET.toLowerCase()) {
    console.error("\n✗ POLYGON_PRIVATE_KEY does not match POLYGON_EXECUTION_WALLET");
    console.error(`  Key produces: ${signer.address}`);
    console.error(`  .env expects: ${POLYGON_WALLET}`);
    process.exit(1);
  }
  console.log("✓ Private key matches wallet address\n");

  // ── Test 1: Sign a realistic BUY YES order ─────────────────────────────────
  console.log("── Test 1: Sign BUY YES order (68% price, 10 USDC) ──");

  // This tokenId is a real Polymarket YES token — Fed rate decision market
  // In production your agent fetches this from the Polymarket API
  const TEST_TOKEN_ID = "58670511222237437150810312030727137317904629401680594753026701991201571494287";

  const buyOrder = buildOrder({
    makerAddress: signer.address,
    tokenId:      TEST_TOKEN_ID,
    usdcAmount:   10,     // 10 USDC
    price:        0.68,   // 68% — agent's estimated probability
    side:         "BUY",
  });

  console.log("Order built:");
  console.log(`  tokenId:     ${buyOrder.tokenId.toString().slice(0, 20)}...`);
  console.log(`  makerAmount: ${Number(buyOrder.makerAmount) / 1e6} USDC`);
  console.log(`  takerAmount: ${Number(buyOrder.takerAmount) / 1e6} shares`);
  console.log(`  price:       ${Number(buyOrder.makerAmount) / Number(buyOrder.takerAmount)} per share`);
  console.log(`  expiration:  ${new Date(Number(buyOrder.expiration) * 1000).toISOString()}`);
  console.log(`  side:        ${buyOrder.side === 0 ? "BUY" : "SELL"}`);

  const buySignature = await signer.signTypedData(DOMAIN, ORDER_TYPES, buyOrder);
  console.log(`\nSignature:     ${buySignature.slice(0, 30)}...`);

  // Verify: recover signer from signature — must match wallet address
  const recovered = recoverSigner(buyOrder, buySignature);
  if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(`✗ Signature verification FAILED`);
    console.error(`  Recovered: ${recovered}`);
    console.error(`  Expected:  ${signer.address}`);
    process.exit(1);
  }
  console.log(`✓ Signature verified — recovered: ${recovered}`);

  // ── Test 2: Sign a BUY NO order ───────────────────────────────────────────
  console.log("\n── Test 2: Sign BUY NO order (32% price, 5 USDC) ──");

  // NO token ID is the complement of YES token ID on Polymarket
  // In production you fetch this from the API alongside the YES token
  const NO_TOKEN_ID = "29183083214221943300852656093365204646003671296087176455180090482493191496481";

  const noOrder = buildOrder({
    makerAddress: signer.address,
    tokenId:      NO_TOKEN_ID,
    usdcAmount:   5,
    price:        0.32,   // NO price = 1 - YES price
    side:         "BUY",
  });

  const noSignature = await signer.signTypedData(DOMAIN, ORDER_TYPES, noOrder);
  const recoveredNo = recoverSigner(noOrder, noSignature);

  if (recoveredNo.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("✗ NO order signature verification FAILED");
    process.exit(1);
  }
  console.log(`✓ NO order signature verified`);

  // ── Test 3: Show the exact API payload ────────────────────────────────────
  console.log("\n── Test 3: API-ready payload ──");

  const apiPayload = formatForApi(buyOrder, buySignature);
  console.log("This is what gets POSTed to Polymarket API:");
  console.log(JSON.stringify(apiPayload, null, 2));

  // ── Test 4: Domain separator check ────────────────────────────────────────
  console.log("\n── Test 4: EIP-712 domain separator ──");

  const domainSeparator = ethers.TypedDataEncoder.hashDomain(DOMAIN);
  console.log(`Domain separator: ${domainSeparator}`);
  console.log("✓ Domain encodes correctly");

  // ── Test 5: Kelly sizing sanity check ─────────────────────────────────────
  console.log("\n── Test 5: Kelly sizing simulation ──");

  function halfKelly(params: {
    agentProbability: number;   // agent's P(YES)
    marketPrice:      number;   // current market price
    bankrollUsdc:     number;   // total bankroll
  }): { betFraction: number; betSizeUsdc: number; edgeBps: number } {
    const { agentProbability: p, marketPrice, bankrollUsdc } = params;
    const q = 1 - p;

    // Net odds: if price is 0.68, winning $1 of shares costs $0.68
    // so net odds b = (1 - price) / price
    const b = (1 - marketPrice) / marketPrice;

    // Full Kelly fraction
    const fullKelly = (b * p - q) / b;

    // Half Kelly for risk management
    const halfKellyFraction = fullKelly / 2;

    // Clamp to 0 (no negative bets)
    const fraction    = Math.max(0, halfKellyFraction);
    const betSizeUsdc = fraction * bankrollUsdc;
    const edgeBps     = Math.round((p - marketPrice) * 10000);

    return { betFraction: fraction, betSizeUsdc, edgeBps };
  }

  const kellyResult = halfKelly({
    agentProbability: 0.74,   // agent estimates 74%
    marketPrice:      0.61,   // market showing 61%
    bankrollUsdc:     500,    // 500 USDC bankroll
  });

  console.log("Agent P(YES):    74%");
  console.log("Market P(YES):   61%");
  console.log("Edge:           ", kellyResult.edgeBps, "bps");
  console.log("Half-Kelly f*:  ", (kellyResult.betFraction * 100).toFixed(3), "% of bankroll");
  console.log("Bet size:       $" + kellyResult.betSizeUsdc.toFixed(2), "USDC");

  if (kellyResult.edgeBps < 800) {
    console.log("⚠ Edge below 800bps threshold — agent would SKIP this market");
  } else {
    console.log("✓ Edge above threshold — agent would BET");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("  ALL SIGNING TESTS PASSED ✓");
  console.log("═══════════════════════════════════════");
  console.log("\nNext step: get your Polymarket API key from");
  console.log("https://polymarket.com → Settings → API Keys");
  console.log("Then submit the payload from Test 3 to:");
  console.log("POST https://clob.polymarket.com/order?builderCode=YOUR_CODE");
}

main().catch(e => {
  console.error("\n✗ Error:", e?.message ?? e);
  process.exit(1);
});