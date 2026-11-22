/**
 * Agent lifecycle: create market, trade, resolve, redeem.
 *
 * This is a placeholder implementation that demonstrates the workflow.
 * In production, you would use the generated contract client classes
 * from @oracledesk/bindings-* packages.
 */

import { AgentConfig } from './config';
import { SignerSpec, signerSpecHash } from './spec';
import { buildCreateTrace, buildBuyTrace, traceHash, canonicalizeTrace } from './trace';
import { createHash } from 'crypto';

export interface LifecycleContext {
  config: AgentConfig;
  marketId?: number;
  resolutionSpec?: SignerSpec;
}

/**
 * Phase 1: Create a market with a resolution commitment.
 */
export async function createMarket(context: LifecycleContext, question: string): Promise<number> {
  console.log('\n=== Phase 1: Create Market ===');
  console.log(`Question: ${question}`);

  // Step 1: Define resolution commitment
  const resolutionSpec: SignerSpec = {
    signers: [context.config.agentPublicKey],  // For this example, agent is a signer
    threshold: 1,
    dispute_window: 604800,  // 7 days
  };
  context.resolutionSpec = resolutionSpec;

  const resolutionHash = signerSpecHash(resolutionSpec);
  console.log(`Resolution hash: ${resolutionHash.toString('hex')}`);

  // Step 2: Question hash
  const questionHash = createHash('sha256').update(JSON.stringify({ question })).digest();
  console.log(`Question hash: ${questionHash.toString('hex')}`);

  // Step 3: Publish a trace for market creation
  const createTrace = buildCreateTrace(question, 0, context.config.seedAmount, 'Market creation');
  const traceContent = JSON.stringify(createTrace);
  console.log(`Trace (before publish): ${traceContent}`);

  // Step 4: Call treasury.agent_create_market or agent_create_market_with_bounty
  // In production:
  // const marketId = await treasury.agent_create_market({
  //   agent: config.agentPublicKey,
  //   seed_amount: config.seedAmount,
  //   question_hash: questionHash,
  //   resolution_hash: resolutionHash,
  //   close_time: config.closeTime,
  // });

  const marketId = 1;  // Placeholder
  context.marketId = marketId;
  console.log(`✓ Market created: ${marketId}`);

  return marketId;
}

/**
 * Phase 2: Trade the market (buy shares).
 */
export async function tradeMarket(context: LifecycleContext): Promise<void> {
  console.log('\n=== Phase 2: Trade Market ===');

  if (!context.marketId) throw new Error('Market not created');

  // Step 1: Build a buy trace
  const buyTrace = buildBuyTrace(
    context.marketId,
    'Yes',
    context.config.seedAmount / 2n,
    'Model predicts 70% probability; market is 60%.',
    'EV+ at current price',
  );

  // Step 2: Publish trace (BEFORE trading)
  const traceContent = JSON.stringify(buyTrace);
  console.log(`Publishing trace: ${traceContent}`);

  // In production:
  // await reasoningRegistry.publish_trace({
  //   reasoner: config.agentPublicKey,
  //   content: traceContent,
  // });

  console.log('✓ Trace published');

  // Step 3: Execute the buy
  console.log(`Buying 50M YES shares on market ${context.marketId}`);

  // In production:
  // const result = await marketCore.buy({
  //   trader: config.agentPublicKey,
  //   market_id: context.marketId,
  //   outcome: 'Yes',
  //   collateral_in: context.config.seedAmount / 2n,
  //   min_shares_out: (context.config.seedAmount / 2n) * 4n / 5n,  // 80% slippage protection
  // });

  console.log('✓ Buy executed');
}

/**
 * Phase 3: Reveal the resolution spec.
 */
export async function revealSpec(context: LifecycleContext): Promise<void> {
  console.log('\n=== Phase 3: Reveal Resolution Spec ===');

  if (!context.marketId || !context.resolutionSpec) {
    throw new Error('Market not created or spec not defined');
  }

  console.log(`Revealing signer spec for market ${context.marketId}`);

  // In production:
  // await resolver.register_signer_spec({
  //   market_id: context.marketId,
  //   config: context.resolutionSpec,
  // });

  console.log('✓ Spec revealed');
}

/**
 * Phase 4: Finalize the market.
 */
export async function finalizeMarket(context: LifecycleContext): Promise<void> {
  console.log('\n=== Phase 4: Finalize Market ===');

  if (!context.marketId) throw new Error('Market not created');

  console.log(`Finalizing market ${context.marketId}`);

  // In production:
  // await resolver.finalize_signers_for({
  //   caller: config.agentPublicKey,
  //   market_id: context.marketId,
  // });

  console.log('✓ Market finalized');
}

/**
 * Phase 5: Redeem and claim.
 */
export async function redeemAndClaim(context: LifecycleContext): Promise<bigint> {
  console.log('\n=== Phase 5: Redeem and Claim ===');

  if (!context.marketId) throw new Error('Market not created');

  console.log(`Redeeming position on market ${context.marketId}`);

  // In production:
  // const payout = await marketCore.redeem({
  //   holder: config.agentPublicKey,
  //   market_id: context.marketId,
  // });

  const payout = context.config.seedAmount;  // Placeholder: assume we win
  console.log(`✓ Redeemed: ${payout.toString()} stroops`);

  // If we created the market, also claim LP fees
  console.log('Claiming pool remainder...');
  // In production:
  // const remainder = await marketCore.claim_pool_remainder({
  //   market_id: context.marketId,
  // });

  const remainder = context.config.seedAmount / 10n;  // Placeholder
  console.log(`✓ Pool remainder: ${remainder.toString()} stroops`);

  return payout + remainder;
}

/**
 * Run the full lifecycle with error handling.
 */
export async function runLifecycle(config: AgentConfig): Promise<void> {
  const context: LifecycleContext = { config };

  try {
    // Phase 1: Create market
    const question = 'Will ETH close above $3,000 on 2024-12-31?';
    await createMarket(context, question);

    // Phase 2: Trade
    await tradeMarket(context);

    // Wait for close_time (or hardcode for testing)
    console.log('\n⏳ Waiting for market to close...');
    console.log(`Close time: ${new Date(config.closeTime * 1000).toISOString()}`);

    // Phase 3: Reveal spec
    await revealSpec(context);

    // Phase 4: Finalize (after dispute window)
    console.log('\n⏳ Waiting for dispute window to close...');
    await finalizeMarket(context);

    // Phase 5: Redeem
    const totalPayout = await redeemAndClaim(context);

    console.log('\n✅ Lifecycle complete!');
    console.log(`Total return: ${totalPayout.toString()} stroops`);
  } catch (error) {
    console.error('❌ Lifecycle failed:', error);
    throw error;
  }
}
