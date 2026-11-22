export type Severity = 'info' | 'warning' | 'high' | 'critical';

export type RuleType =
  | 'market_core_config_changed'
  | 'market_voided'
  | 'treasury_unexpected_transfer'
  | 'treasury_config_or_pause_changed'
  | 'market_stuck_unresolved'
  | 'treasury_utilization_threshold'
  | 'market_core_solvency_deficit'
  | 'registry_agent_anomaly'
  | 'ledger_entry_near_archival';

export interface RuleConfig {
  id: string;
  type: RuleType;
  severity: Severity;
  escalateSeverity?: Severity;
  cooldownSeconds?: number;
  criticalThresholdStroops?: string;
  graceAfterCloseSeconds?: number;
  escalateAfterSeconds?: number;
  dailyUsageWarnPct?: number;
  toleranceStroops?: string;
  archivalMarginLedgers?: number;
  description?: string;
}

export interface MarketCoreConfigSnapshot {
  admin: string;
  collateral: string;
  treasury: string;
  resolver: string;
  defaultFeeBps: number;
  paused: boolean;
}

export interface TreasuryRiskConfigSnapshot {
  marketCore: string;
  collateral: string;
  maxTrade: bigint;
  maxMarket: bigint;
  maxDaily: bigint;
  paused: boolean;
}

export type MarketStatus = 'Open' | 'Resolved' | 'Void';
export type ResolverState = 'Unconfigured' | 'SignersPending' | 'Finalized';

export interface MarketSnapshot {
  marketId: number;
  closeTime: number;
  status: MarketStatus;
  outcome: 'Yes' | 'No' | null;
  reserveYes: bigint;
  reserveNo: bigint;
  setsMinted: bigint;
  feesAccrued: bigint;
  lpClaimed: boolean;
  /** Cumulative payouts observed via `Redeemed` events for this market. */
  redeemedPayoutTotal: bigint;
  /** Cached reserves at resolution prior to `claim_pool_remainder`. */
  reservesAtResolution?: { yes: bigint; no: bigint };
  /** Computed pool remainder claimed when `lpClaimed` flips true. */
  claimedPoolPayout?: bigint;
  /** Resolver state and signer dispute window (seconds) if configured. */
  resolverState?: ResolverState;
  disputeWindowSeconds?: number;
}

export interface LedgerEntryTtlSnapshot {
  contractName: string;
  contractId: string;
  liveUntilLedgerSeq: number;
}

export interface DecodedSacTransferEvent {
  kind: 'sac_transfer';
  ledger: number;
  from: string;
  to: string;
  amount: bigint;
  txHash?: string;
}

export interface DecodedMarketResolvedEvent {
  kind: 'market_resolved';
  ledger: number;
  timestamp: number;
  marketId: number;
  outcome: 'Yes' | 'No' | null;
}

export interface DecodedTradeAuthorizedEvent {
  kind: 'trade_authorized';
  ledger: number;
  marketId: number;
  agent: string;
  amount: bigint;
  marketTotal: bigint;
  dailyTotal: bigint;
}

export interface DecodedAgentRegisteredEvent {
  kind: 'agent_registered';
  ledger: number;
  agent: string;
}

export interface DecodedRedeemedEvent {
  kind: 'redeemed';
  ledger: number;
  marketId: number;
  holder: string;
  payout: bigint;
}

export type MonitorEvent =
  | DecodedSacTransferEvent
  | DecodedMarketResolvedEvent
  | DecodedTradeAuthorizedEvent
  | DecodedAgentRegisteredEvent
  | DecodedRedeemedEvent;

export interface ExpectedDeploymentState {
  deployer: string;
  agent: string;
  expectedAgents?: string[];
  contracts: {
    usdc: string;
    market_core: string;
    resolver: string;
    treasury: string;
    reasoning_registry: string;
  };
  defaultFeeBps?: number;
  treasuryRiskConfig?: {
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
  };
}

export interface MonitorSnapshot {
  nowUnixSeconds: number;
  currentLedger: number;
  expected: ExpectedDeploymentState;
  marketCoreConfig: MarketCoreConfigSnapshot;
  treasuryConfig: TreasuryRiskConfigSnapshot;
  treasuryDailyUsage: bigint;
  marketCoreCollateralBalance: bigint;
  agentRegistered: boolean;
  markets: MarketSnapshot[];
  ledgerEntries: LedgerEntryTtlSnapshot[];
  events: MonitorEvent[];
  /** True when full Redeemed history since deploy is unavailable. */
  approximateSolvencyMode?: boolean;
}

export interface AlertFinding {
  dedupKey: string;
  ruleId: string;
  ruleType: RuleType;
  severity: Severity;
  title: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface AlertNotification {
  action: 'trigger' | 'resolve';
  dedupKey: string;
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  timestamp: string;
  details?: Record<string, string | number | boolean | null>;
}
