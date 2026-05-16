import dotenv from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, defineChain, parseAbiItem, Interface } from "viem";
import { Interface } from "ethers";
import crypto from "crypto";

dotenv.config();

// ── Chain client (for reading back results) ───────────────────────────────────
const arcTestnet = defineChain({
  id: 3110,
  name: "Arc Testnet (Canteen)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC!] } },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.RPC!),
});

// ── Circle wallet client (for sending transactions) ───────────────────────────
const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

// ── Constants ─────────────────────────────────────────────────────────────────
const FACTORY      = process.env.MARKET_FACTORY_ADDRESS!;
const USDC         = process.env.USDC_ADDRESS!;
const WALLET_ID    = process.env.CIRCLE_WALLET_ID!;
const AGENT_ADDR   = process.env.AGENT_WALLET_ADDRESS!;
const ORACLE_ADDR  = process.env.ORACLE_ADDRESS ?? AGENT_ADDR; // fallback to agent for testing

const ONE_USDC     = BigInt(1_000_000);   // 1 USDC = 1e6 (6 decimals)
const SEED_USDC    = BigInt(10) * ONE_USDC; // 10 USDC seed for test market

// ── Helpers ───────────────────────────────────────────────────────────────────

// Send a contract call via Circle Wallets and wait for COMPLETE
async function sendTx(
  label: string,
  contractAddress: string,
  callData: string
): Promise<string> {
  console.log(`\n→ Sending: ${label}`);

  const tx = await circleClient.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress,
    callData,
    blockchain: "ARC-TESTNET",
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const txId = tx.data?.id!;
  console.log(`  Circle TX ID: ${txId}`);

  // Poll until confirmed
  for (let i = 1; i <= 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const result = await circleClient.getTransaction({ id: txId });
    const state  = result.data?.transaction?.state;
    process.stdout.write(`  [${i}/40] ${state}\r`);

    if (state === "COMPLETE") {
      const hash = result.data?.transaction?.txHash;
      console.log(`\n  ✓ ${label} confirmed`);
      console.log(`  TX hash: ${hash}`);
      console.log(`  Explorer: https://testnet.arcscan.app/tx/${hash}`);
      return hash!;
    }
    if (state === "FAILED") {
      const reason = result.data?.transaction?.failureReason;
      throw new Error(`${label} failed: ${reason}`);
    }
  }
  throw new Error(`${label} timed out`);
}

// ABI-encode a function call
function encodeCall(signature: string, args: unknown[]): string {
  const iface = new Interface([`function ${signature}`]);
  const name  = signature.split("(")[0];
  return iface.encodeFunctionData(name, args);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  OracleDesk — createMarket test");
  console.log("═══════════════════════════════════════");
  console.log(`  Factory:  ${FACTORY}`);
  console.log(`  Agent:    ${AGENT_ADDR}`);
  console.log(`  Oracle:   ${ORACLE_ADDR}`);
  console.log(`  Seed:     ${Number(SEED_USDC) / 1e6} USDC`);

  // ── Check agent wallet USDC balance first ─────────────────────────────────
  const balanceRaw = await publicClient.readContract({
    address: USDC as `0x${string}`,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [AGENT_ADDR as `0x${string}`],
  }) as bigint;

  const balanceUsdc = Number(balanceRaw) / 1e6;
  console.log(`\n  Agent USDC balance: $${balanceUsdc}`);

  if (balanceRaw < SEED_USDC) {
    console.error(`\n✗ Insufficient USDC. Need $${Number(SEED_USDC)/1e6}, have $${balanceUsdc}`);
    console.error("  Get testnet USDC at: https://faucet.circle.com");
    process.exit(1);
  }
  console.log("  ✓ Sufficient balance");

  // ── Step 1: Approve factory to pull USDC ──────────────────────────────────
  const approveCalldata = encodeCall(
    "approve(address,uint256)",
    [FACTORY, SEED_USDC]
  );
  await sendTx("USDC.approve(factory, 20 USDC)", USDC, approveCalldata);

  // ── Step 2: Deposit seed into factory ─────────────────────────────────────
  const depositCalldata = encodeCall(
    "depositLiquidity(uint256)",
    [SEED_USDC]
  );
  await sendTx("MarketFactory.depositLiquidity(20 USDC)", FACTORY, depositCalldata);

  // ── Step 3: Build the market parameters ───────────────────────────────────
  const question        = "Will the Fed raise rates at the June 12 2026 meeting?";
  const expiryTimestamp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days
  const initialYesPrice = 6800;    // 68% — agent's estimated probability
  const reasoningJson   = JSON.stringify({
    agent: "market_maker",
    decision_type: "create_market",
    timestamp: new Date().toISOString(),
    question,
    sources_used: [
      { source: "CME FedWatch", weight: 0.9, signal: "68% implied probability of hold" },
      { source: "Fed speeches", weight: 0.7, signal: "3 hawkish speeches this week" },
    ],
    probability_estimate: 0.68,
    confidence_interval: { lower: 0.60, upper: 0.76 },
  });

  // SHA-256 of the reasoning trace — what gets stored on Arc
  const sha256Hash = "0x" + crypto
    .createHash("sha256")
    .update(reasoningJson)
    .digest("hex");

  // For a real build: pin to IPFS first and use the real CID
  // For this test: use a placeholder CID
  const reasoningCid = "QmTestReasoningTrace123PlaceholderForHackathon";

  console.log(`\n  Market question: "${question}"`);
  console.log(`  Initial YES:     ${initialYesPrice / 100}%`);
  console.log(`  Expiry:          ${new Date(expiryTimestamp * 1000).toISOString()}`);
  console.log(`  Reasoning hash:  ${sha256Hash.slice(0, 20)}...`);

  // ── Step 4: Call createMarket ─────────────────────────────────────────────
  const createMarketCalldata = encodeCall(
    "createMarket(string,address,uint256,uint256,uint256,address,string,bytes32)",
    [
      question,
      ORACLE_ADDR,
      expiryTimestamp,
      initialYesPrice,
      SEED_USDC,
      AGENT_ADDR,
      reasoningCid,
      sha256Hash,
    ]
  );
  await sendTx("MarketFactory.createMarket()", FACTORY, createMarketCalldata);

  // ── Step 5: Read back — prove the market was created ─────────────────────
  console.log("\n→ Reading back from chain...");
  await new Promise(r => setTimeout(r, 2000)); // brief wait for indexing

  const totalMarkets = await publicClient.readContract({
    address: FACTORY as `0x${string}`,
    abi: [{ name: "totalMarkets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "totalMarkets",
  }) as bigint;

  const allMarkets = await publicClient.readContract({
    address: FACTORY as `0x${string}`,
    abi: [{ name: "getAllMarkets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }],
    functionName: "getAllMarkets",
  }) as string[];

  console.log(`  ✓ totalMarkets() → ${totalMarkets}`);
  console.log(`  ✓ Latest market: ${allMarkets[allMarkets.length - 1]}`);

  const latestMarket = allMarkets[allMarkets.length - 1] as `0x${string}`;

  const info = await publicClient.readContract({
    address: latestMarket,
    abi: [{
      name: "getMarketInfo",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [
        { name: "_question",        type: "string"  },
        { name: "_oracle",          type: "address" },
        { name: "_expiryTimestamp", type: "uint256" },
        { name: "_yesPrice",        type: "uint256" },
        { name: "_liquidity",       type: "uint256" },
        { name: "_resolved",        type: "bool"    },
        { name: "_resolvedYes",     type: "bool"    },
        { name: "_reasoningCid",    type: "string"  },
      ],
    }],
    functionName: "getMarketInfo",
  }) as [string, string, bigint, bigint, bigint, boolean, boolean, string];

  const [q, oracle, expiry, yesPrice, liquidity] = info;

  console.log(`\n  Market verified on chain:`);
  console.log(`    Question:  ${q}`);
  console.log(`    YES price: ${Number(yesPrice) / 100}%`);
  console.log(`    Liquidity: $${Number(liquidity) / 1e6} USDC`);
  console.log(`    Oracle:    ${oracle}`);
  console.log(`    Explorer:  https://testnet.arcscan.app/address/${latestMarket}`);

  console.log("\n═══════════════════════════════════════");
  console.log("  createMarket: ALL STEPS PASSED ✓");
  console.log("═══════════════════════════════════════");
  console.log("\nNow run test-scan.ts again — it should show this market.");
}

main().catch(e => {
  console.error("\n✗ Error:", e?.message ?? e);
  process.exit(1);
});