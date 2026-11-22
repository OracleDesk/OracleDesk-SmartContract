/**
 * Reference Agent: Main Entry Point
 *
 * This demonstrates a complete OracleDesk agent workflow:
 * 1. Create a market with a resolution commitment
 * 2. Trade the market
 * 3. Publish reasoning traces
 * 4. Resolve the market
 * 5. Redeem and claim winnings
 */

import { loadConfig, printConfig } from './config';
import { verifyGoldenVectors as verifySpecVectors } from './spec';
import { verifyGoldenVectors as verifyTraceVectors } from './trace';
import { runLifecycle } from './lifecycle';

/**
 * Main execution.
 */
async function main(): Promise<void> {
  console.log('🤖 OracleDesk Reference Agent');
  console.log('=' .repeat(70));

  try {
    // Load configuration
    console.log('\n📋 Loading configuration...');
    const config = loadConfig();
    printConfig(config);

    // Verify golden vectors (catch encoding mismatches)
    console.log('\n🔍 Verifying golden vectors...');
    if (!verifySpecVectors()) {
      throw new Error('Spec hash golden vectors mismatch (encoding issue)');
    }
    if (!verifyTraceVectors()) {
      throw new Error('Trace canonicalization golden vectors mismatch');
    }
    console.log('✓ Golden vectors verified');

    // Run the full lifecycle
    console.log('\n🚀 Starting agent lifecycle...');
    await runLifecycle(config);

    console.log('\n📊 Agent Workflow Complete');
    console.log('=' .repeat(70));
  } catch (error) {
    if (error instanceof Error) {
      console.error('\n❌ Error:', error.message);
      if (error.stack) {
        console.error('Stack:', error.stack);
      }
    } else {
      console.error('\n❌ Unknown error:', error);
    }
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
