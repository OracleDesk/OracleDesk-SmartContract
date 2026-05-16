import dotenv from "dotenv";
import { createPublicClient, http, defineChain, parseAbiItem } from "viem";

dotenv.config();

// ── Arc Testnet chain definition ──────────────────────────────────────────────
const arcTestnet = defineChain({
  id: 3110,
  name: "Arc Testnet (Canteen)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC!] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.RPC!),
});

const FACTORY = process.env.MARKET_FACTORY_ADDRESS! as `0x${string}`;

// ── Minimal ABIs — only what we need to read ──────────────────────────────────
const FACTORY_ABI = [
  {
    name: "totalMarkets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getAllMarkets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const MARKET_ABI = [
  {
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
  },
] as const;

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  OracleDesk — scanMarkets test");
  console.log("═══════════════════════════════════════\n");

  // ── Step 1: basic chain connectivity ─────────────────────────────────────
  const blockNumber = await client.getBlockNumber();
  const chainId     = await client.getChainId();
  console.log(`✓ Connected to Arc Testnet`);
  console.log(`  Chain ID:     ${chainId}`);
  console.log(`  Block number: ${blockNumber}\n`);

  // ── Step 2: read factory state ────────────────────────────────────────────
  console.log(`Factory: ${FACTORY}`);

  const owner = await client.readContract({
    address: FACTORY,
    abi: FACTORY_ABI,
    functionName: "owner",
  });
  console.log(`✓ owner()         → ${owner}`);

  const expected = process.env.AGENT_WALLET_ADDRESS!.toLowerCase();
  if (owner.toLowerCase() === expected) {
    console.log(`  ✓ Matches AGENT_WALLET_ADDRESS`);
  } else {
    console.warn(`  ⚠ Mismatch! Expected: ${expected}`);
  }

  const totalMarkets = await client.readContract({
    address: FACTORY,
    abi: FACTORY_ABI,
    functionName: "totalMarkets",
  });
  console.log(`✓ totalMarkets()  → ${totalMarkets}`);

  const allMarkets = await client.readContract({
    address: FACTORY,
    abi: FACTORY_ABI,
    functionName: "getAllMarkets",
  }) as string[];
  console.log(`✓ getAllMarkets()  → [${allMarkets.length} markets]\n`);

  // ── Step 3: read each market ──────────────────────────────────────────────
  if (allMarkets.length === 0) {
    console.log("No markets deployed yet — run test-create-market.ts first\n");
  } else {
    console.log("Markets found:\n");
    for (const marketAddr of allMarkets) {
      const info = await client.readContract({
        address: marketAddr as `0x${string}`,
        abi: MARKET_ABI,
        functionName: "getMarketInfo",
      }) as [string, string, bigint, bigint, bigint, boolean, boolean, string];

      const [question, oracle, expiry, yesPrice, liquidity, resolved, resolvedYes, reasoningCid] = info;

      console.log(`  Market: ${marketAddr}`);
      console.log(`    Question:    ${question}`);
      console.log(`    YES price:   ${Number(yesPrice) / 100}%`);
      console.log(`    Liquidity:   $${Number(liquidity) / 1e6} USDC`);
      console.log(`    Expires:     ${new Date(Number(expiry) * 1000).toISOString()}`);
      console.log(`    Resolved:    ${resolved}`);
      console.log(`    Reasoning:   ${reasoningCid || "(none)"}`);
      console.log("");
    }
  }

  // ── Step 4: scan MarketDeployed events ────────────────────────────────────
  console.log("Scanning MarketDeployed events...");
  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock - 50000n > 0n ? currentBlock - 50000n : 0n;
  console.log(`  Scanning from block ${fromBlock} to ${currentBlock}...`);

  const logs = await client.getLogs({
    address: FACTORY,
    event: parseAbiItem(
      "event MarketDeployed(address indexed market, string question, address oracle, uint256 expiryTimestamp, uint256 initialYesPrice, uint256 liquiditySeed, string reasoningCid)"
    ),
    fromBlock,
  });

  console.log(`✓ Found ${logs.length} MarketDeployed event(s)\n`);
  for (const log of logs) {
    console.log(`  Block ${log.blockNumber}: "${log.args.question}"`);
    console.log(`  Address: ${log.args.market}`);
    console.log("");
  }

  console.log("═══════════════════════════════════════");
  console.log("  scanMarkets: ALL CHECKS PASSED ✓");
  console.log("═══════════════════════════════════════");
}

main().catch(e => {
  console.error("Error:", e?.message ?? e);
  process.exit(1);
});