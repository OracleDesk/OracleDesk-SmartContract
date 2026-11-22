import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AgentBudgetLedger } from "./agent-budget-ledger.js";

test("AgentBudgetLedger initializes budget", () => {
  const ledger = new AgentBudgetLedger(
    "GDQOQ5RSMKLS4WJUDPK3PNXC2JLMQ72QRXBFB2LZWV6IECFIXLB4RO",
    "https://soroban-testnet.stellar.org",
  );

  ledger.initializeAgentBudget(
    "GCLIENT123",
    1000000n,
    "GSPENDING123",
  );

  const remaining = ledger.getRemainingBudget("GCLIENT123");
  assert.equal(remaining, 1000000n);
});

test("AgentBudgetLedger records purchases", async () => {
  const ledger = new AgentBudgetLedger(
    "GDQOQ5RSMKLS4WJUDPK3PNXC2JLMQ72QRXBFB2LZWV6IECFIXLB4RO",
    "https://soroban-testnet.stellar.org",
  );

  ledger.initializeAgentBudget("GCLIENT123", 1000000n, "GSPENDING123");

  await ledger.recordPurchase(
    "GCLIENT123",
    "trace-1",
    "signal-api.example.com",
    100000n,
  );

  const spent = ledger.getSpentToday("GCLIENT123");
  assert.equal(spent, 100000n);

  const remaining = ledger.getRemainingBudget("GCLIENT123");
  assert.equal(remaining, 900000n);
});

test("AgentBudgetLedger prevents budget overrun", async () => {
  const ledger = new AgentBudgetLedger(
    "GDQOQ5RSMKLS4WJUDPK3PNXC2JLMQ72QRXBFB2LZWV6IECFIXLB4RO",
    "https://soroban-testnet.stellar.org",
  );

  ledger.initializeAgentBudget("GCLIENT123", 100000n, "GSPENDING123");

  await ledger.recordPurchase(
    "GCLIENT123",
    "trace-1",
    "signal-api.example.com",
    50000n,
  );

  assert.rejects(
    () =>
      ledger.recordPurchase(
        "GCLIENT123",
        "trace-2",
        "signal-api.example.com",
        60000n,
      ),
    /budget exceeded/,
  );
});

test("AgentBudgetLedger records paid inputs", () => {
  const ledger = new AgentBudgetLedger(
    "GDQOQ5RSMKLS4WJUDPK3PNXC2JLMQ72QRXBFB2LZWV6IECFIXLB4RO",
    "https://soroban-testnet.stellar.org",
  );

  ledger.recordPaidInput(
    "trace-123",
    "signal-provider.example.com",
    "abc123def456",
  );

  const inputs = ledger.getPaidInputs();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].source, "signal-provider.example.com");
});

test("AgentBudgetLedger fetches entries", async () => {
  const ledger = new AgentBudgetLedger(
    "GDQOQ5RSMKLS4WJUDPK3PNXC2JLMQ72QRXBFB2LZWV6IECFIXLB4RO",
    "https://soroban-testnet.stellar.org",
  );

  ledger.initializeAgentBudget("GCLIENT123", 1000000n, "GSPENDING123");

  await ledger.recordPurchase(
    "GCLIENT123",
    "trace-1",
    "source-1",
    50000n,
  );

  const entries = ledger.getEntries("GCLIENT123");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].traceId, "trace-1");
  assert.equal(entries[0].costUstdc, 50000n);
});
