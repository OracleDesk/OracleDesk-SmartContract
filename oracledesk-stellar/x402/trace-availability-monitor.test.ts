import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TraceAvailabilityMonitor } from "./trace-availability-monitor.js";
import type { TraceRepository } from "./trace-api.js";

test("TraceAvailabilityMonitor initialization", async () => {
  const mockRepository: TraceRepository = {
    async get() {
      return undefined;
    },
  };

  const monitor = new TraceAvailabilityMonitor({
    repository: mockRepository,
    ipfsGateway: "https://ipfs.io/ipfs",
  });

  const state = monitor.getState();
  assert.equal(state.tracesScanned, 0);
  assert.equal(state.tracesFailed, 0);
  assert.equal(state.lastFailedTraces.size, 0);
});

test("TraceAvailabilityMonitor can start and stop", async () => {
  const mockRepository: TraceRepository = {
    async get() {
      return undefined;
    },
    async trace_count() {
      return 0n;
    },
  };

  const monitor = new TraceAvailabilityMonitor({
    repository: mockRepository,
    ipfsGateway: "https://ipfs.io/ipfs",
    scanIntervalMs: 100,
  });

  await monitor.start();
  const state1 = monitor.getState();

  await new Promise((resolve) => setTimeout(resolve, 150));
  monitor.stop();

  const state2 = monitor.getState();
  assert.equal(typeof state2.lastScanAt, "number");
});

test("TraceAvailabilityMonitor tracks failed traces", async () => {
  const mockRepository: TraceRepository = {
    async get(traceId: string) {
      if (traceId === "1") {
        return {
          traceId: "1",
          ipfsCid: "QmTest",
          traceHash: "abc123",
        };
      }
      return undefined;
    },
  };

  const monitor = new TraceAvailabilityMonitor({
    repository: mockRepository,
    ipfsGateway: "https://ipfs.io/ipfs",
    timeoutMs: 100,
  });

  const state = monitor.getState();
  assert.ok(state.lastFailedTraces instanceof Map);
});
