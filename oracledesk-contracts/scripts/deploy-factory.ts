import dotenv from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { readFileSync } from "fs";

dotenv.config();

const walletClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const contractClient = initiateSmartContractPlatformClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

async function main() {
  try {
    // Read compiled output from Foundry
    const artifact = JSON.parse(
      readFileSync("out/PredictionMarket.sol/PredictionMarket.json", "utf-8")
    );

    // BUG 3 FIX: must be "ARC-TESTNET" not "ARC"
    const blockchain = "ARC-TESTNET";

    const walletId      = process.env.CIRCLE_WALLET_ID!;
    const walletAddress = process.env.AGENT_WALLET_ADDRESS!;

    if (!walletId || !walletAddress) {
      throw new Error("CIRCLE_WALLET_ID and AGENT_WALLET_ADDRESS must be set in .env");
    }

    // BUG 1 FIX: bytecode must include 0x prefix, NO manual constructor encoding
    const bytecode = artifact.bytecode.object as string;
    const finalBytecode = bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`;

    // BUG 2 FIX: abiJson must be sent as a separate field — a JSON string of the ABI array
    const abiJson = JSON.stringify(artifact.abi);

    console.log("Deploying PredictionMarket...");
    console.log("  Blockchain:     ", blockchain);
    console.log("  Owner address:  ", walletAddress);
    console.log("  Wallet ID:      ", walletId);
    console.log("  Bytecode length:", finalBytecode.length);

    // BUG 1+2+3+4 FIX: correct parameter structure per Circle docs
    const response = await contractClient.deployContract({
      name: "OracleDesk PredictionMarket",
      description: "OracleDesk prediction market contract",
      blockchain,
      walletId,
      abiJson,
      bytecode: finalBytecode,
      constructorParameters: [
        walletAddress,
      ],
      fee: {           // ← nested object, not flat feeLevel
        type: "level",
        config: {
          feeLevel: "MEDIUM",
        },
      },
    });

    const contractId   = response.data?.contractId;
    const transactionId = response.data?.transactionId;

    console.log("\n✓ Deployment initiated");
    console.log("  Contract ID:    ", contractId);
    console.log("  Transaction ID: ", transactionId);

    if (!transactionId) {
      throw new Error("No transactionId returned — check Circle console for errors");
    }

    // Poll until COMPLETE or FAILED
    console.log("\nPolling for confirmation...");
    for (let i = 1; i <= 60; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const tx    = await walletClient.getTransaction({ id: transactionId });
      const state = tx.data?.transaction?.state;

      console.log(`  [${i}/60] State: ${state}`);

      if (state === "COMPLETE") {
        const contractAddress = tx.data?.transaction?.contractAddress;
        console.log("\n✓ PredictionMarket deployed successfully!");
        console.log("  Contract address:", contractAddress);
        console.log("\nAdd this to your .env:");
        console.log(`  PREDICTION_MARKET_ADDRESS=${contractAddress}`);
        return;
      }

      if (state === "FAILED") {
        const reason = tx.data?.transaction?.failureReason ?? "unknown";
        console.error("\n✗ Deployment failed:", reason);
        process.exit(1);
      }
    }

    console.error("Timed out waiting for deployment");
    process.exit(1);

  } catch (error: any) {
    // Print the full API error body if available — much more useful than the summary
    if (error?.response?.data) {
      console.error("Circle API error body:", JSON.stringify(error.response.data, null, 2));
    }
    console.error("Deployment error:", error?.message ?? error);
    process.exit(1);
  }
}

await main();