import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { Interface, AbiCoder } from "ethers";
import crypto from "crypto";

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS!;
const USDC_ADDRESS    = "0x3600000000000000000000000000000000000000";
const WALLET_ID       = process.env.CIRCLE_WALLET_ID!;
const AGENT_ADDRESS   = process.env.AGENT_WALLET_ADDRESS!;
const ORACLE_ADDRESS  = process.env.ORACLE_ADDRESS!; // the resolution oracle wallet

// Step 1: USDC Approval — allow factory to pull liquidity seed from agent wallet
async function approveUsdc(seedAmount: bigint): Promise<string> {
  const iface = new Interface([
    "function approve(address spender, uint256 amount) returns (bool)"
  ]);
  const calldata = iface.encodeFunctionData("approve", [
    FACTORY_ADDRESS,
    seedAmount
  ]);

  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress: USDC_ADDRESS,
    callData: calldata,
    blockchain: "ARC-TESTNET",
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  return tx.data?.id!;
}

// Step 2: Deposit liquidity seed into factory
async function depositToFactory(seedAmount: bigint): Promise<string> {
  const iface = new Interface([
    "function depositLiquidity(uint256 amount)"
  ]);
  const calldata = iface.encodeFunctionData("depositLiquidity", [seedAmount]);

  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress: FACTORY_ADDRESS,
    callData: calldata,
    blockchain: "ARC-TESTNET",
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  return tx.data?.id!;
}

// Step 3: Call createMarket on the factory
async function callCreateMarket(params: {
  question:         string;
  expiryTimestamp:  number;
  initialYesPrice:  number;  // basis points: 6800 = 68%
  liquiditySeedUsdc: number; // in USDC (whole units, not wei)
  reasoningCid:     string;
  reasoningJson:    string;  // full trace content for hashing
}): Promise<string> {

  // Compute SHA-256 hash of the full reasoning trace
  const sha256Hash = "0x" + crypto
    .createHash("sha256")
    .update(params.reasoningJson)
    .digest("hex");

  // Convert USDC to 6-decimal representation
  const seedAmount = BigInt(params.liquiditySeedUsdc) * BigInt(1e6);

  const iface = new Interface([
    `function createMarket(
      string calldata _question,
      address _oracle,
      uint256 _expiryTimestamp,
      uint256 _initialYesPrice,
      uint256 _liquiditySeedUsdc,
      address _agentWallet,
      string calldata _reasoningCid,
      bytes32 _sha256Hash
    ) returns (address)`
  ]);

  const calldata = iface.encodeFunctionData("createMarket", [
    params.question,
    ORACLE_ADDRESS,
    params.expiryTimestamp,
    params.initialYesPrice,
    seedAmount,
    AGENT_ADDRESS,
    params.reasoningCid,
    sha256Hash,
  ]);

  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress: FACTORY_ADDRESS,
    callData: calldata,
    blockchain: "ARC-TESTNET",
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  return tx.data?.id!;
}

// ── Full flow: approve → deposit → createMarket ───────────────────────────────

export async function createMarket(params: {
  question:          string;
  expiryTimestamp:   number;
  initialYesPriceBps: number;
  liquiditySeedUsdc: number;
  reasoningCid:      string;
  reasoningJson:     string;
}) {
  const seedAmount = BigInt(params.liquiditySeedUsdc) * BigInt(1e6);

  console.log(`Creating market: "${params.question}"`);
  console.log(`Initial YES price: ${params.initialYesPriceBps / 100}%`);
  console.log(`Liquidity seed: $${params.liquiditySeedUsdc} USDC`);

  // 1. Approve USDC transfer
  const approveTxId = await approveUsdc(seedAmount);
  console.log("Approval tx:", approveTxId);
  await waitForTx(approveTxId);

  // 2. Deposit seed into factory
  const depositTxId = await depositToFactory(seedAmount);
  console.log("Deposit tx:", depositTxId);
  await waitForTx(depositTxId);

  // 3. Create the market
  const createTxId = await callCreateMarket({
    question:          params.question,
    expiryTimestamp:   params.expiryTimestamp,
    initialYesPrice:   params.initialYesPriceBps,
    liquiditySeedUsdc: params.liquiditySeedUsdc,
    reasoningCid:      params.reasoningCid,
    reasoningJson:     params.reasoningJson,
  });
  console.log("CreateMarket tx:", createTxId);
  const receipt = await waitForTx(createTxId);

  console.log("Market deployed at:", receipt.contractAddress);
  return receipt;
}

// ── Poll Circle API until tx is COMPLETE or FAILED ───────────────────────────

async function waitForTx(txId: string, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const tx = await client.getTransaction({ id: txId });
    const state = tx.data?.transaction?.state;

    if (state === "COMPLETE") return tx.data!.transaction!;
    if (state === "FAILED")   throw new Error(`Transaction ${txId} failed`);
    console.log(`  Waiting... (${state})`);
  }
  throw new Error(`Transaction ${txId} timed out`);
}