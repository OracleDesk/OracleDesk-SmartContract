/**
 * ChainStateReader: concurrent Soroban RPC reads for market and portfolio state.
 * Uses getLedgerEntries for atomic multi-key reads to ensure ledger consistency.
 */
import type { Server as StellarServer } from "@stellar/stellar-sdk/rpc";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { ChainMarket, PortfolioState, Snapshot, MarketStatus, ResolutionMode } from "./types.js";

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
      this.readPortfolio(),
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
    const keys = marketIds.map((id) => buildMarketKey(this.opts.marketContractId, id));

    const entries = await withTimeout(
      this.opts.server.getLedgerEntries(...keys),
      RPC_TIMEOUT_MS,
      "getLedgerEntries(markets) timed out",
    );

    const markets = new Map<bigint, ChainMarket>();
    let minLedger = Infinity;
    let maxLedger = 0;

    for (const entry of (entries as any).entries ?? []) {
      const typed = entry as RpcLedgerEntry;
      minLedger = Math.min(minLedger, typed.lastModifiedLedgerSeq);
      maxLedger = Math.max(maxLedger, typed.lastModifiedLedgerSeq);
      try {
        const market = decodeMarketEntry(typed);
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

  private async readPortfolio(): Promise<PortfolioState> {
    const key = buildPortfolioKey(this.opts.portfolioContractId);
    const entries = await withTimeout(
      this.opts.server.getLedgerEntries(key),
      RPC_TIMEOUT_MS,
      "getLedgerEntries(portfolio) timed out",
    );
    const first = ((entries as any).entries ?? [])[0];
    if (!first) return defaultPortfolio();
    return decodePortfolioEntry(first as RpcLedgerEntry);
  }
}

// ── XDR helpers ──────────────────────────────────────────────────────────────

function buildMarketKey(contractId: string, marketId: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("MarketState"),
          val: xdr.ScVal.scvU64(xdr.Uint64.fromString(String(marketId))),
        }),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function buildPortfolioKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvSymbol("PortfolioState"),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function decodeMarketEntry(entry: RpcLedgerEntry): ChainMarket {
  const scval = xdr.ScVal.fromXDR(Buffer.from(entry.val));
  const map = scval.map() ?? [];
  const get = (key: string) => map.find((e) => e.key().sym?.().toString() === key)?.val();

  return {
    marketId: BigInt(get("market_id")?.u64()?.toString() ?? "0"),
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
    resolution: decodeResolution(get("resolution")),
  };
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
  const sym = val?.sym()?.toString();
  if (sym === "Open") return "open";
  if (sym === "ResolvedYes") return "resolved_yes";
  if (sym === "ResolvedNo") return "resolved_no";
  if (sym === "Void") return "void";
  return "open";
}

function decodeResolution(val: xdr.ScVal | undefined): ResolutionMode {
  const variant = val?.map()?.[0]?.key()?.sym()?.toString();
  if (!variant) return "unrevealed";
  const modes: Record<string, ResolutionMode> = {
    Unrevealed: "unrevealed",
    Price: "price",
    Signers: "signers",
    Finalized: "finalized",
  };
  return modes[variant] ?? "unknown";
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
