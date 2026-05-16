import { createPublicClient, http, parseAbiItem } from "viem";
import { defineChain } from "viem";

// Arc Testnet chain definition for viem
const arcTestnet = defineChain({
  id: 3110,
  name: "Arc Testnet (Canteen)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.RPC!],  // ← pulls from .env, uses Canteen node
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS! as `0x${string}`;

// Fetch all MarketDeployed events since block 0
export async function getAllMarketAddresses(): Promise<string[]> {
  const logs = await client.getLogs({
    address: FACTORY_ADDRESS,
    event: parseAbiItem(
      "event MarketDeployed(address indexed market, string question, address oracle, uint256 expiryTimestamp, uint256 initialYesPrice, uint256 liquiditySeed, string reasoningCid)"
    ),
    fromBlock: 0n,
  });

  return logs.map(log => log.args.market as string);
}

// Fetch current state of a single market
export async function getMarketState(marketAddress: string) {
  const data = await client.readContract({
    address: marketAddress as `0x${string}`,
    abi: [
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
        ]
      }
    ],
    functionName: "getMarketInfo",
  });

  return {
    question:        data[0],
    oracle:          data[1],
    expiryTimestamp: Number(data[2]),
    yesPrice:        Number(data[3]),  // basis points
    liquidity:       Number(data[4]),  // USDC (6 decimals)
    resolved:        data[5],
    resolvedYes:     data[6],
    reasoningCid:    data[7],
  };
}