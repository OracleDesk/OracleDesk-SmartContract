import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TWAPExecutor,
  ParticipationLimitedExecutor,
  type ParentOrder,
} from "./execution-algorithms.js";

async function createMockQuote() {
  return {
    price: 0.5,
    shares: 2000000n,
    timestamp: Date.now(),
  };
}

test("TWAPExecutor creates parent order", async () => {
  const executor = new TWAPExecutor(createMockQuote, 1000, 100);

  const parentOrder: ParentOrder = {
    id: "parent-1",
    targetShares: 1000000n,
    maxCollateral: 600000n,
    limitPrice: 0.6,
    fairValue: 0.5,
    requiredEdge: 0.01,
    createdAt: Date.now(),
    status: "pending",
    executedShares: 0n,
    spentCollateral: 0n,
    childOrders: [],
  };

  const executionId = await executor.executeParentOrder(parentOrder, "market-1");
  assert.ok(executionId);
  assert.equal(parentOrder.status, "completed" || "failed");
});

test("TWAPExecutor generates child orders", async () => {
  const executor = new TWAPExecutor(createMockQuote, 1000, 100);

  const parentOrder: ParentOrder = {
    id: "parent-2",
    targetShares: 1000000n,
    maxCollateral: 600000n,
    limitPrice: 0.6,
    fairValue: 0.5,
    requiredEdge: 0.01,
    createdAt: Date.now(),
    status: "pending",
    executedShares: 0n,
    spentCollateral: 0n,
    childOrders: [],
  };

  await executor.executeParentOrder(parentOrder, "market-1");

  assert.ok(parentOrder.executedShares > 0n);
  assert.ok(parentOrder.spentCollateral > 0n);
  assert.ok(parentOrder.childOrders.length > 0);
});

test("ParticipationLimitedExecutor respects participation rate", async () => {
  const executor = new ParticipationLimitedExecutor(
    createMockQuote,
    0.1,
    100,
  );

  const parentOrder: ParentOrder = {
    id: "parent-3",
    targetShares: 1000000n,
    maxCollateral: 600000n,
    limitPrice: 0.6,
    fairValue: 0.5,
    requiredEdge: 0.01,
    createdAt: Date.now(),
    status: "pending",
    executedShares: 0n,
    spentCollateral: 0n,
    childOrders: [],
  };

  await executor.executeParentOrder(parentOrder, "market-1");

  assert.ok(parentOrder.executedShares > 0n);
  assert.ok(parentOrder.executedShares <= parentOrder.targetShares);
});

test("ParticipationLimitedExecutor stops on edge disappearance", async () => {
  let callCount = 0;
  const executor = new ParticipationLimitedExecutor(
    async () => {
      callCount++;
      if (callCount > 2) {
        // Edge disappears: price exceeds limit
        return {
          price: 0.65,
          shares: 2000000n,
          timestamp: Date.now(),
        };
      }
      return {
        price: 0.5,
        shares: 2000000n,
        timestamp: Date.now(),
      };
    },
    0.1,
    10,
  );

  const parentOrder: ParentOrder = {
    id: "parent-4",
    targetShares: 10000000n,
    maxCollateral: 6000000n,
    limitPrice: 0.6,
    fairValue: 0.5,
    requiredEdge: 0.01,
    createdAt: Date.now(),
    status: "pending",
    executedShares: 0n,
    spentCollateral: 0n,
    childOrders: [],
  };

  await executor.executeParentOrder(parentOrder, "market-1");

  // Should not execute full target due to edge disappearance
  assert.ok(parentOrder.executedShares < parentOrder.targetShares);
  assert.equal(parentOrder.status, "failed");
});

test("ExecutionState persists correctly", async () => {
  const executor = new TWAPExecutor(createMockQuote, 100, 50);

  const parentOrder: ParentOrder = {
    id: "parent-5",
    targetShares: 100000n,
    maxCollateral: 60000n,
    limitPrice: 0.6,
    fairValue: 0.5,
    requiredEdge: 0.01,
    createdAt: Date.now(),
    status: "pending",
    executedShares: 0n,
    spentCollateral: 0n,
    childOrders: [],
  };

  await executor.executeParentOrder(parentOrder, "market-1");

  const state = executor.getState();
  assert.ok(state.parentOrders.size > 0 || state.childOrders.size > 0);
});
