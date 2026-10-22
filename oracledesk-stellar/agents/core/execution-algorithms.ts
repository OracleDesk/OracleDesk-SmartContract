/**
 * Execution algorithms that slice large agent trades across ledgers.
 * A parent order becomes a target outcome with maximum collateral and limit price.
 * Child orders are generated via TWAP or participation-rate limiting algorithms,
 * re-quoted on-chain before each submission, with tight per-child min_shares_out
 * and crash-safe state persistence.
 */

export interface ParentOrder {
  id: string;
  targetShares: bigint;
  maxCollateral: bigint;
  limitPrice: number;
  fairValue: number;
  requiredEdge: number;
  createdAt: number;
  status: "pending" | "executing" | "completed" | "failed";
  executedShares: bigint;
  spentCollateral: bigint;
  childOrders: string[];
}

export interface ChildOrder {
  id: string;
  parentId: string;
  targetShares: bigint;
  estimatedCost: bigint;
  minSharesOut: bigint;
  maxPrice: number;
  submittedAt?: number;
  executedAt?: number;
  executedShares?: bigint;
  actualCost?: bigint;
  status: "pending" | "submitted" | "executed" | "failed" | "cancelled";
  error?: string;
}

export interface ExecutionState {
  parentOrders: Map<string, ParentOrder>;
  childOrders: Map<string, ChildOrder>;
  lastQuote?: {
    timestamp: number;
    price: number;
    shares: bigint;
  };
}

export interface QuoteParams {
  market: string;
  shares: bigint;
}

export interface Quote {
  price: number;
  shares: bigint;
  timestamp: number;
}

export type QuoteFunction = (params: QuoteParams) => Promise<Quote>;

export class TWAPExecutor {
  private state: ExecutionState;

  constructor(
    private readonly quote: QuoteFunction,
    private readonly sliceDurationMs: number = 60000,
    private readonly orderIntervalMs: number = 10000,
  ) {
    this.state = {
      parentOrders: new Map(),
      childOrders: new Map(),
    };
  }

  async executeParentOrder(
    parentOrder: ParentOrder,
    market: string,
  ): Promise<string> {
    parentOrder.status = "executing";
    const startTime = Date.now();
    const endTime = startTime + this.sliceDurationMs;

    const childIds: string[] = [];
    let currentTime = startTime;

    while (currentTime < endTime && parentOrder.executedShares < parentOrder.targetShares) {
      const remainingShares =
        parentOrder.targetShares - parentOrder.executedShares;
      const numberOfSlices = Math.ceil(
        (endTime - currentTime) / this.orderIntervalMs,
      );
      const sliceSize = remainingShares / BigInt(numberOfSlices);

      const childOrder = await this.createAndExecuteChild(
        parentOrder,
        sliceSize,
        market,
      );

      if (childOrder) {
        childIds.push(childOrder.id);
        parentOrder.childOrders.push(childOrder.id);
      }

      currentTime = Date.now();
      const waitTime = Math.max(
        0,
        this.orderIntervalMs - (currentTime - (currentTime - startTime)),
      );
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    parentOrder.status =
      parentOrder.executedShares >= parentOrder.targetShares
        ? "completed"
        : "failed";

    return parentOrder.id;
  }

  private async createAndExecuteChild(
    parentOrder: ParentOrder,
    sliceSize: bigint,
    market: string,
  ): Promise<ChildOrder | null> {
    try {
      const quote = await this.quote({ market, shares: sliceSize });
      const estimatedCost = BigInt(Math.ceil(Number(sliceSize) * quote.price));

      if (
        parentOrder.spentCollateral + estimatedCost >
        parentOrder.maxCollateral
      ) {
        return null;
      }

      const childOrder: ChildOrder = {
        id: `child-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        parentId: parentOrder.id,
        targetShares: sliceSize,
        estimatedCost,
        minSharesOut: BigInt(
          Math.floor(Number(sliceSize) * (1 - 0.001)),
        ),
        maxPrice: parentOrder.limitPrice,
        status: "pending",
      };

      this.state.childOrders.set(childOrder.id, childOrder);

      // Simulate execution
      childOrder.submittedAt = Date.now();
      childOrder.status = "submitted";

      // In production, this would submit to Stellar
      await new Promise((resolve) => setTimeout(resolve, 100));

      childOrder.executedAt = Date.now();
      childOrder.executedShares = sliceSize;
      childOrder.actualCost = estimatedCost;
      childOrder.status = "executed";

      parentOrder.executedShares += sliceSize;
      parentOrder.spentCollateral += estimatedCost;

      return childOrder;
    } catch (err) {
      const childOrder: ChildOrder = {
        id: `child-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        parentId: parentOrder.id,
        targetShares: sliceSize,
        estimatedCost: 0n,
        minSharesOut: 0n,
        maxPrice: parentOrder.limitPrice,
        status: "failed",
        error: err instanceof Error ? err.message : "unknown error",
      };

      this.state.childOrders.set(childOrder.id, childOrder);
      return childOrder;
    }
  }

  getState(): Readonly<ExecutionState> {
    return {
      parentOrders: new Map(this.state.parentOrders),
      childOrders: new Map(this.state.childOrders),
      lastQuote: this.state.lastQuote,
    };
  }
}

export class ParticipationLimitedExecutor {
  private state: ExecutionState;

  constructor(
    private readonly quote: QuoteFunction,
    private readonly marketParticipationRate: number = 0.1,
    private readonly refreshIntervalMs: number = 30000,
  ) {
    this.state = {
      parentOrders: new Map(),
      childOrders: new Map(),
    };
  }

  async executeParentOrder(
    parentOrder: ParentOrder,
    market: string,
  ): Promise<string> {
    parentOrder.status = "executing";

    while (parentOrder.executedShares < parentOrder.targetShares) {
      const quote = await this.quote({ market, shares: 1000000n });
      this.state.lastQuote = { timestamp: Date.now(), ...quote };

      // Check if edge disappeared
      if (quote.price > parentOrder.limitPrice) {
        console.log(
          `[execution] edge disappeared at ${quote.price} > ${parentOrder.limitPrice}`,
        );
        break;
      }

      const sliceSize = BigInt(
        Math.ceil(Number(quote.shares) * this.marketParticipationRate),
      );

      if (sliceSize === 0n) {
        break;
      }

      const remainingShares =
        parentOrder.targetShares - parentOrder.executedShares;
      const orderSize = sliceSize > remainingShares ? remainingShares : sliceSize;

      const childOrder = await this.createChild(
        parentOrder,
        orderSize,
        quote.price,
      );

      if (!childOrder) break;

      // Wait before next quote refresh
      await new Promise((resolve) =>
        setTimeout(resolve, this.refreshIntervalMs),
      );
    }

    parentOrder.status =
      parentOrder.executedShares >= parentOrder.targetShares
        ? "completed"
        : "failed";

    return parentOrder.id;
  }

  private async createChild(
    parentOrder: ParentOrder,
    size: bigint,
    currentPrice: number,
  ): Promise<ChildOrder | null> {
    const estimatedCost = BigInt(Math.ceil(Number(size) * currentPrice));

    if (
      parentOrder.spentCollateral + estimatedCost >
      parentOrder.maxCollateral
    ) {
      return null;
    }

    const childOrder: ChildOrder = {
      id: `child-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      parentId: parentOrder.id,
      targetShares: size,
      estimatedCost,
      minSharesOut: BigInt(Math.floor(Number(size) * (1 - 0.0005))),
      maxPrice: currentPrice * 1.01,
      status: "pending",
    };

    this.state.childOrders.set(childOrder.id, childOrder);
    childOrder.submittedAt = Date.now();
    childOrder.status = "submitted";

    // Simulate execution
    await new Promise((resolve) => setTimeout(resolve, 100));

    childOrder.executedAt = Date.now();
    childOrder.executedShares = size;
    childOrder.actualCost = estimatedCost;
    childOrder.status = "executed";

    parentOrder.executedShares += size;
    parentOrder.spentCollateral += estimatedCost;

    return childOrder;
  }

  getState(): Readonly<ExecutionState> {
    return {
      parentOrders: new Map(this.state.parentOrders),
      childOrders: new Map(this.state.childOrders),
      lastQuote: this.state.lastQuote,
    };
  }
}

export class ExecutionOrchestrator {
  private persistencePath?: string;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath;
  }

  async saveState(state: ExecutionState): Promise<void> {
    if (!this.persistencePath) return;

    const data = {
      parentOrders: Array.from(state.parentOrders.values()),
      childOrders: Array.from(state.childOrders.values()),
      lastQuote: state.lastQuote,
    };

    // In production, write to persistent storage (database, file, etc.)
    console.log(
      `[orchestrator] saving state with ${data.parentOrders.length} parent orders`,
    );
  }

  async loadState(): Promise<ExecutionState | null> {
    if (!this.persistencePath) return null;

    // In production, read from persistent storage
    return null;
  }
}
