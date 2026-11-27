/**
 * ChainStateReader: concurrent Soroban RPC reads for market and portfolio state.
 * Uses getLedgerEntries for atomic multi-key reads to ensure ledger consistency.
 */
import type { Server as StellarServer } from "@stellar/stellar-sdk/rpc";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { ChainMarket, PortfolioState, Snapshot, MarketStatus } from "./types.js";

const MAX_LEDGER_DRIFT = Number(process.env.AGENT_MAX_LEDGER_DRIFT ?? 2);
const RPC_TIMEOUT_MS = Number(process.env.AGENT_RPC_TIMEOUT_MS ?? 30_000);

interface RpcLedgerEntry {
  key: Buffer | Uint8Array;
  val: Buffer | Uint8Array;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

export interface ChainStateReaderOptions {
  marketContractId: string;
  portfolioContractId: string;
  server: StellarServer;
  /** Abort signal to cancel in-flight reads */
  signal?: AbortSignal;
}

export class ChainStateReader {
  private readonly opts: ChainStateReaderOptions;

  constructor(opts: ChainStateReaderOptions) {
    this.opts = opts;
  }

  async readSnapshot(marketIds: bigint[]): Promise<Snapshot> {
    const errors: Snapshot["errors"] = [];

    // Fetch portfolio and markets concurrently
    const [portfolioResult, marketResults] = await Promise.allSettled([
      Promise.resolve(defaultPortfolio()),
      this.readMarkets(marketIds, errors),
    ]);

    const portfolio = portfolioResult.status === "fulfilled"
      ? portfolioResult.value
      : (() => {
          errors.push({ scope: "portfolio", message: String(portfolioResult.reason) });
          return defaultPortfolio();
        })();

    const { markets, ledgerRange } = marketResults.status === "fulfilled"
      ? marketResults.value
      : (() => {
          errors.push({ scope: "markets", message: String(marketResults.reason) });
          return { markets: new Map<bigint, ChainMarket>(), ledgerRange: { min: 0, max: 0 } };
        })();

    const consistent = ledgerRange.max - ledgerRange.min <= MAX_LEDGER_DRIFT;

    return {
      ledgers: ledgerRange,
      consistent,
      ledgerCloseTime: BigInt(Math.floor(Date.now() / 1000)),
      markets,
      portfolio,
      errors,
    };
  }

  private async readMarkets(
    marketIds: bigint[],
    errors: Snapshot["errors"],
  ): Promise<{ markets: Map<bigint, ChainMarket>; ledgerRange: { min: number; max: number } }> {
    if (marketIds.length === 0) return { markets: new Map(), ledgerRange: { min: 0, max: 0 } };

    // Build ledger keys for each market
    const keys = marketIds.flatMap((id) => [
      buildMarketKey(this.opts.marketContractId, id),
      buildSettleKey(this.opts.marketContractId, id),
    ]);

    const entries = await withTimeout(
      this.opts.server.getLedgerEntries(...keys),
      RPC_TIMEOUT_MS,
      "getLedgerEntries(markets) timed out",
    );

    const markets = new Map<bigint, ChainMarket>();
    let minLedger = Infinity;
    let maxLedger = 0;

    const marketEntries: RpcLedgerEntry[] = [];
    const settleEntries: RpcLedgerEntry[] = [];
    for (const entry of (entries as any).entries ?? []) {
      const typed = entry as RpcLedgerEntry;
      minLedger = Math.min(minLedger, typed.lastModifiedLedgerSeq);
      maxLedger = Math.max(maxLedger, typed.lastModifiedLedgerSeq);
      try {
        (isMarketEntry(typed) ? marketEntries : settleEntries).push(typed);
      } catch (e) {
        errors.push({ scope: "market-decode", message: String(e) });
      }
    }

    for (let i = 0; i < marketEntries.length; i++) {
      try {
        const market = decodeMarketEntry(marketEntries[i]!, marketIds[i]!);
        market.closed = settleEntries[i] ? decodeSettleEntry(settleEntries[i]!) : false;
        markets.set(market.marketId, market);
      } catch (e) {
        errors.push({ scope: "market-decode", message: String(e) });
      }
    }

    return {
      markets,
      ledgerRange: { min: minLedger === Infinity ? 0 : minLedger, max: maxLedger },
    };
  }

}

// ── XDR helpers ──────────────────────────────────────────────────────────────

function buildMarketKey(contractId: string, marketId: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Market"),
        xdr.ScVal.scvU64(xdr.Uint64.fromString(String(marketId))),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function buildSettleKey(contractId: string, marketId: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Settle"),
        xdr.ScVal.scvU64(xdr.Uint64.fromString(String(marketId))),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function decodeMarketEntry(entry: RpcLedgerEntry, marketId: bigint): ChainMarket {
  const scval = xdr.ScVal.fromXDR(Buffer.from(entry.val));
  const map = scval.map() ?? [];
  const get = (key: string) => map.find((e) => e.key().sym?.().toString() === key)?.val();

  return {
    marketId,
    creator: get("creator")?.address()?.accountId()?.toString() ?? "",
    questionHash: Buffer.from(get("question_hash")?.bytes() ?? []).toString("hex"),
    resolutionHash: Buffer.from(get("resolution_hash")?.bytes() ?? []).toString("hex"),
    metaUri: get("meta_uri")?.str()?.toString() ?? "",
    category: get("category")?.sym()?.toString() ?? "",
    closeTime: BigInt(get("close_time")?.u64()?.toString() ?? "0"),
    feeBps: Number(get("fee_bps")?.u32() ?? 0),
    status: decodeStatus(get("status")),
    reserveYes: BigInt(get("reserve_yes")?.i128()?.toString() ?? "0"),
    reserveNo: BigInt(get("reserve_no")?.i128()?.toString() ?? "0"),
    setsMinted: BigInt(get("sets_minted")?.i128()?.toString() ?? "0"),
    feesAccrued: BigInt(get("fees_accrued")?.i128()?.toString() ?? "0"),
    lpClaimed: get("lp_claimed")?.b() ?? false,
    closed: false,
  };
}

function isMarketEntry(entry: RpcLedgerEntry): boolean {
  const map = xdr.ScVal.fromXDR(Buffer.from(entry.val)).map() ?? [];
  return map.some((e) => e.key().sym?.().toString() === "creator");
}

function decodeSettleEntry(entry: RpcLedgerEntry): boolean {
  const map = xdr.ScVal.fromXDR(Buffer.from(entry.val)).map() ?? [];
  return map.find((e) => e.key().sym?.().toString() === "closed")?.val()?.b() ?? false;
}

function decodePortfolioEntry(entry: RpcLedgerEntry): PortfolioState {
  const scval = xdr.ScVal.fromXDR(Buffer.from(entry.val));
  const map = scval.map() ?? [];
  const get = (key: string) => map.find((e) => e.key().sym?.().toString() === key)?.val();

  const configMap = get("config")?.map() ?? [];
  const getC = (key: string) => configMap.find((e) => e.key().sym?.().toString() === key)?.val();

  const dailyMap = get("daily")?.map() ?? [];
  const getD = (key: string) => dailyMap.find((e) => e.key().sym?.().toString() === key)?.val();

  return {
    treasury: get("treasury")?.address()?.accountId()?.toString() ?? "",
    config: {
      agent: getC("agent")?.address()?.accountId()?.toString() ?? "",
      maxTrade: BigInt(getC("max_trade")?.i128()?.toString() ?? "0"),
      maxMarket: BigInt(getC("max_market")?.i128()?.toString() ?? "0"),
      maxDaily: BigInt(getC("max_daily")?.i128()?.toString() ?? "0"),
    },
    availableCapital: BigInt(get("available_capital")?.i128()?.toString() ?? "0"),
    daily: {
      dayStart: BigInt(getD("day_start")?.u64()?.toString() ?? "0"),
      amount: BigInt(getD("amount")?.i128()?.toString() ?? "0"),
    },
    positions: new Map(),
  };
}

function decodeStatus(val: xdr.ScVal | undefined): MarketStatus {
  const sym = val?.vec()?.[0]?.sym()?.toString() ?? val?.sym()?.toString();
  if (sym === "Open") return "open";
  if (sym === "Resolved") {
    return val?.vec()?.[1]?.sym()?.toString() === "No" ? "resolved_no" : "resolved_yes";
  }
  if (sym === "Void") return "void";
  return "open";
}

function defaultPortfolio(): PortfolioState {
  return {
    treasury: "",
    config: { agent: "", maxTrade: 0n, maxMarket: 0n, maxDaily: 0n },
    availableCapital: 0n,
    daily: { dayStart: 0n, amount: 0n },
    positions: new Map(),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}
