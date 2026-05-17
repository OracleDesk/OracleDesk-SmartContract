import { createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ethers } from "ethers";

// Polygon Amoy testnet (use mainnet for real Polymarket)
const polygonAmoy = defineChain({
  id: 80002,
  name: "Polygon Amoy",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-amoy.polygon.technology"] } },
});

// ── Contract addresses ────────────────────────────────────────────────────────
// Mainnet Polymarket — use these for real bets
const CTF_EXCHANGE    = "0xE111180000d2663C0091e4f400237545B87B996B";
const USDC_POLYGON    = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ── EIP-712 domain for Polymarket CTF Exchange ────────────────────────────────
const DOMAIN = {
  name:              "CTF Exchange",
  version:           "1",
  chainId:           137,            // Polygon mainnet
  verifyingContract: CTF_EXCHANGE,
};

// ── EIP-712 types for the Order struct ───────────────────────────────────────
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

export interface PlaceOrderParams {
  tokenId:     string;   // CTF ERC-1155 token ID from Polymarket API
  usdcAmount:  number;   // USDC to spend (whole units, e.g. 10 = 10 USDC)
  price:       number;   // Price per share (0–1), e.g. 0.68
  side:        "BUY" | "SELL";
  builderCode: string;   // Your Polymarket builder code (referral)
}

export async function placePolymarketOrder(
  params: PlaceOrderParams,
  polygonPrivateKey: string
): Promise<{ orderId: string; polygonTxHash: string }> {

  const account  = privateKeyToAccount(polygonPrivateKey as `0x${string}`);
  const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
  const signer   = new ethers.Wallet(polygonPrivateKey, provider);

  const ONE_USDC   = 1_000_000n;
  const makerAmount = BigInt(Math.round(params.usdcAmount * 1e6)); // USDC in 6 decimals
  // takerAmount = shares expected = makerAmount / price
  const takerAmount = BigInt(Math.round(params.usdcAmount / params.price * 1e6));

  const order = {
    salt:          BigInt(Math.floor(Math.random() * 1e15)),
    maker:         account.address,
    signer:        account.address,
    taker:         ethers.ZeroAddress,    // public order
    tokenId:       BigInt(params.tokenId),
    makerAmount,
    takerAmount,
    expiration:    BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
    nonce:         0n,
    feeRateBps:    0n,
    side:          params.side === "BUY" ? 0 : 1,
    signatureType: 0,  // EOA
  };

  // Sign the order using EIP-712
  const signature = await signer.signTypedData(DOMAIN, ORDER_TYPES, order);

  // Submit to Polymarket API
  // Builder code is passed as a query parameter — this is how referral fees work
  const apiUrl = `https://clob.polymarket.com/order?builderCode=${params.builderCode}`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Polymarket API key goes here (obtained from their site)
      // "Authorization": `Bearer ${process.env.POLYMARKET_API_KEY}`
    },
    body: JSON.stringify({
      order: {
        ...order,
        salt:          order.salt.toString(),
        tokenId:       order.tokenId.toString(),
        makerAmount:   order.makerAmount.toString(),
        takerAmount:   order.takerAmount.toString(),
        expiration:    order.expiration.toString(),
        nonce:         order.nonce.toString(),
        feeRateBps:    order.feeRateBps.toString(),
      },
      signature,
      orderType: "GTC",  // Good Till Cancelled
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Polymarket API error: ${JSON.stringify(result)}`);
  }

  return {
    orderId:       result.orderID,
    polygonTxHash: result.transactionHash ?? "",
  };
}