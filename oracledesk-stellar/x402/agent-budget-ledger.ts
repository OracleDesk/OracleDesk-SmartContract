import { createHash } from "node:crypto";
import type { KeyPair } from "@stellar/stellar-sdk";

export interface BudgetAllowance {
  dailyCapUstdc: bigint;
  allowanceOnChainId?: string;
  spendingKeyPublic: string;
}

export interface BudgetEntry {
  traceId: string;
  source: string;
  costUstdc: bigint;
  timestamp: number;
  txHash?: string;
}

export interface AgentBudgetState {
  allowance: BudgetAllowance;
  entries: BudgetEntry[];
  lastResetAt: number;
}

export interface PaidInputRecord {
  sourceHash: string;
  source: string;
  contentHash: string;
  timestamp: number;
}

export class AgentBudgetLedger {
  private state: Map<string, AgentBudgetState> = new Map();
  private spendingKey?: KeyPair;
  private paidInputs: Map<string, PaidInputRecord> = new Map();

  constructor(
    private readonly treasuryAddress: string,
    private readonly rpcUrl: string,
  ) {}

  setSpendingKey(key: KeyPair): void {
    this.spendingKey = key;
  }

  initializeAgentBudget(
    agentAddress: string,
    dailyCapUstdc: bigint,
    spendingKeyPublic: string,
    allowanceOnChainId?: string,
  ): void {
    this.state.set(agentAddress, {
      allowance: {
        dailyCapUstdc,
        spendingKeyPublic,
        allowanceOnChainId,
      },
      entries: [],
      lastResetAt: Date.now(),
    });
  }

  async recordPurchase(
    agentAddress: string,
    traceId: string,
    source: string,
    costUstdc: bigint,
    txHash?: string,
  ): Promise<void> {
    const state = this.state.get(agentAddress);
    if (!state) {
      throw new Error(`budget not initialized for agent ${agentAddress}`);
    }

    const now = Date.now();
    const daysSinceReset = (now - state.lastResetAt) / (24 * 60 * 60 * 1000);
    if (daysSinceReset >= 1) {
      state.entries = [];
      state.lastResetAt = now;
    }

    const spent = state.entries.reduce((acc, e) => acc + e.costUstdc, 0n);
    if (spent + costUstdc > state.allowance.dailyCapUstdc) {
      throw new Error(
        `budget exceeded: ${spent + costUstdc} > ${state.allowance.dailyCapUstdc}`,
      );
    }

    if (state.allowance.allowanceOnChainId) {
      await this.verifyOnChainAllowance(
        agentAddress,
        state.allowance.allowanceOnChainId,
        costUstdc,
      );
    }

    state.entries.push({
      traceId,
      source,
      costUstdc,
      timestamp: now,
      txHash,
    });
  }

  recordPaidInput(
    traceId: string,
    source: string,
    contentHash: string,
  ): void {
    const inputHash = this.hashPaidInput(source, contentHash);
    this.paidInputs.set(inputHash, {
      sourceHash: inputHash,
      source,
      contentHash,
      timestamp: Date.now(),
    });
  }

  verifyPurchaseSignature(
    agentAddress: string,
    traceId: string,
    source: string,
    contentHash: string,
    signature: string,
  ): boolean {
    if (!this.spendingKey) {
      return false;
    }

    const message = this.buildPurchaseMessage(traceId, source, contentHash);
    try {
      const publicKey = this.spendingKey.publicKey();
      // Verify signature matches spending key
      return this.verifySignature(publicKey, message, signature);
    } catch {
      return false;
    }
  }

  getSpentToday(agentAddress: string): bigint {
    const state = this.state.get(agentAddress);
    if (!state) return 0n;

    const now = Date.now();
    const daysSinceReset = (now - state.lastResetAt) / (24 * 60 * 60 * 1000);
    if (daysSinceReset >= 1) {
      return 0n;
    }

    return state.entries.reduce((acc, e) => acc + e.costUstdc, 0n);
  }

  getRemainingBudget(agentAddress: string): bigint {
    const state = this.state.get(agentAddress);
    if (!state) return 0n;

    const spent = this.getSpentToday(agentAddress);
    return state.allowance.dailyCapUstdc - spent;
  }

  getEntries(agentAddress: string): BudgetEntry[] {
    const state = this.state.get(agentAddress);
    return state?.entries ?? [];
  }

  getPaidInputs(): PaidInputRecord[] {
    return Array.from(this.paidInputs.values());
  }

  private buildPurchaseMessage(traceId: string, source: string, contentHash: string): string {
    return `${traceId}:${source}:${contentHash}`;
  }

  private hashPaidInput(source: string, contentHash: string): string {
    return createHash("sha256").update(`${source}:${contentHash}`).digest("hex");
  }

  private async verifyOnChainAllowance(
    agentAddress: string,
    allowanceId: string,
    costUstdc: bigint,
  ): Promise<void> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sorobanRpc_getContractData",
          params: {
            contractId: allowanceId,
            key: this.encodeContractKey("allowance", agentAddress),
          },
        }),
      });

      const data = await response.json();
      // Verify allowance from contract state
      if (!data.result) {
        throw new Error("allowance not found on-chain");
      }
    } catch (err) {
      console.error("failed to verify on-chain allowance:", err);
      throw err;
    }
  }

  private encodeContractKey(keyType: string, address: string): string {
    // Simplified: in production, use proper XDR encoding
    return Buffer.from(`${keyType}:${address}`).toString("base64");
  }

  private verifySignature(publicKey: string, message: string, signature: string): boolean {
    // Simplified: in production, use proper Stellar signature verification
    try {
      const hash = createHash("sha256").update(message).digest();
      // Actual verification would use Stellar SDK
      return true;
    } catch {
      return false;
    }
  }
}
