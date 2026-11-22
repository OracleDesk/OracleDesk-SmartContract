/**
 * Configuration loading and validation for the reference agent.
 * Loads contract addresses, network config, and agent credentials from environment.
 */

export interface AgentConfig {
  // Network
  rpcUrl: string;
  networkPassphrase: string;

  // Contract addresses (Soroban contract IDs)
  marketCoreId: string;
  resolverId: string;
  treasuryId: string;
  reasoningRegistryId: string;
  collateralToken: string;

  // Agent credentials
  agentSecret: string;
  agentPublicKey: string;

  // Admin account (for setup; not used in trading)
  adminPublicKey: string;

  // Market parameters
  seedAmount: bigint;
  bountyAmount: bigint;
  closeTime: number; // Unix timestamp
}

/**
 * Load and validate configuration from environment variables.
 */
export function loadConfig(): AgentConfig {
  const rpcUrl = process.env.STELLAR_RPC_URL || 'http://localhost:8000/soroban/rpc';
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Standalone Network; February 2021';

  const marketCoreId = process.env.MARKET_CORE_ID || '';
  const resolverId = process.env.RESOLVER_ID || '';
  const treasuryId = process.env.TREASURY_ID || '';
  const reasoningRegistryId = process.env.REASONING_REGISTRY_ID || '';
  const collateralToken = process.env.COLLATERAL_TOKEN || '';

  const agentSecret = process.env.AGENT_SECRET || '';
  const agentPublicKey = process.env.AGENT_PUBLIC_KEY || '';
  const adminPublicKey = process.env.ADMIN_PUBLIC_KEY || '';

  const seedAmount = BigInt(process.env.SEED_AMOUNT || '1000000000'); // 100 USDC
  const bountyAmount = BigInt(process.env.BOUNTY_AMOUNT || '100000000'); // 10 USDC
  const closeTime = parseInt(process.env.CLOSE_TIME || '', 10) || Math.floor(Date.now() / 1000) + 86400; // 24h from now

  // Validate required fields
  const missingVars = [];
  if (!rpcUrl) missingVars.push('STELLAR_RPC_URL');
  if (!marketCoreId) missingVars.push('MARKET_CORE_ID');
  if (!resolverId) missingVars.push('RESOLVER_ID');
  if (!treasuryId) missingVars.push('TREASURY_ID');
  if (!reasoningRegistryId) missingVars.push('REASONING_REGISTRY_ID');
  if (!collateralToken) missingVars.push('COLLATERAL_TOKEN');
  if (!agentSecret) missingVars.push('AGENT_SECRET');
  if (!agentPublicKey) missingVars.push('AGENT_PUBLIC_KEY');

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  return {
    rpcUrl,
    networkPassphrase,
    marketCoreId,
    resolverId,
    treasuryId,
    reasoningRegistryId,
    collateralToken,
    agentSecret,
    agentPublicKey,
    adminPublicKey,
    seedAmount,
    bountyAmount,
    closeTime,
  };
}

/**
 * Print configuration (for debugging; mask secrets).
 */
export function printConfig(config: AgentConfig): void {
  console.log('Configuration Loaded:');
  console.log(`  Network RPC: ${config.rpcUrl}`);
  console.log(`  Network Passphrase: ${config.networkPassphrase}`);
  console.log(`  Market-Core: ${config.marketCoreId}`);
  console.log(`  Resolver: ${config.resolverId}`);
  console.log(`  Treasury: ${config.treasuryId}`);
  console.log(`  Reasoning Registry: ${config.reasoningRegistryId}`);
  console.log(`  Agent: ${config.agentPublicKey}`);
  console.log(`  Seed Amount: ${config.seedAmount.toString()} stroops`);
  console.log(`  Bounty Amount: ${config.bountyAmount.toString()} stroops`);
  console.log(`  Close Time: ${new Date(config.closeTime * 1000).toISOString()}`);
}
