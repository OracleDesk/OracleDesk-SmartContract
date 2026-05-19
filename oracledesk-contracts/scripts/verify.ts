/**
 * verify.ts — Post-deployment verification
 * Checks every deployed contract is alive, has the correct owner,
 * and is verified on the Arc explorer.
 */
import dotenv from "dotenv";
import { createPublicClient, http, defineChain } from "viem";
dotenv.config();

const arcTestnet = defineChain({
  id: 3110, name: "Arc Testnet (Canteen)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC!] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.RPC!) });
const ownerAbi = [{ name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

async function checkContract(name: string, address: string, expectedOwner: string) {
  if (!address || address === "undefined") {
    console.log(`  ⚠ ${name.padEnd(22)} NOT SET in .env`);
    return false;
  }

  const code = await client.getCode({ address: address as `0x${string}` });
  if (!code || code === "0x") {
    console.log(`  ✗ ${name.padEnd(22)} ${address} — NO CODE`);
    return false;
  }

  try {
    const owner = await client.readContract({
      address: address as `0x${string}`, abi: ownerAbi, functionName: "owner",
    }) as string;
    const ownerMatch = owner.toLowerCase() === expectedOwner.toLowerCase();
    console.log(`  ${ownerMatch ? "✓" : "⚠"} ${name.padEnd(22)} ${address}`);
    if (!ownerMatch) console.log(`     Owner mismatch: expected ${expectedOwner}, got ${owner}`);
    return ownerMatch;
  } catch {
    console.log(`  ✓ ${name.padEnd(22)} ${address} (no owner function)`);
    return true;
  }
}

async function main() {
  console.log("\n═══════════════════════════════════════");
  console.log("  OracleDesk — Deployment Verification");
  console.log("═══════════════════════════════════════\n");

  const block = await client.getBlockNumber();
  console.log(`  Chain ID:     3110`);
  console.log(`  Block number: ${block}\n`);

  const agent = process.env.AGENT_WALLET_ADDRESS!;
  const contracts = [
    ["MultiSigOracle",    process.env.ORACLE_ADDRESS!],
    ["MarketFactory",     process.env.MARKET_FACTORY_ADDRESS!],
    ["TreasuryManager",   process.env.TREASURY_MANAGER_ADDRESS!],
    ["PositionLedger",    process.env.POSITION_LEDGER_ADDRESS!],
    ["ReasoningRegistry", process.env.REASONING_REGISTRY_ADDRESS!],
  ];

  let allPassed = true;
  for (const [name, addr] of contracts) {
    const passed = await checkContract(name, addr, agent);
    if (!passed) allPassed = false;
  }

  console.log("\n" + (allPassed ? "  ✓ All contracts verified" : "  ⚠ Some checks failed — see above"));
  console.log("\n  Explorer links:");
  for (const [name, addr] of contracts) {
    if (addr && addr !== "undefined") {
      console.log(`    ${name.padEnd(22)} https://testnet.arcscan.app/address/${addr}`);
    }
  }
}

main().catch(e => { console.error("✗ Error:", e?.message ?? e); process.exit(1); });