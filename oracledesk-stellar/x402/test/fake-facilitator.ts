import express from "express";
import type { Server } from "node:http";
/** Protocol-faithful HTTP fake. Knobs: advertised networks, validity, settlement
 * success and latency; calls retain network, bearer header and posted payload.
 * No Stellar RPC or real signature verification is performed. */
export async function fakeFacilitator(networks: string[]) {
  const calls: {
    kind: string;
    network?: string;
    auth?: string;
    payload?: unknown;
  }[] = [];
  const knobs = {
    valid: true,
    success: true,
    settleLatencyMs: 0,
    verifyLatencyMs: 0,
    beforeVerify: undefined as (() => Promise<void>) | undefined,
    beforeSettle: undefined as (() => Promise<void>) | undefined,
  };
  const app = express();
  app.use(express.json());
  app.get("/supported", (req, res) => {
    calls.push({ kind: "supported", auth: req.get("authorization") });
    res.json({
      kinds: networks.map((network) => ({
        x402Version: 2,
        scheme: "exact",
        network,
      })),
      extensions: [],
      signers: {},
    });
  });
  app.post("/verify", async (req, res) => {
    calls.push({
      kind: "verify",
      auth: req.get("authorization"),
      network: req.body.paymentRequirements.network,
      payload: req.body,
    });
    await knobs.beforeVerify?.();
    await new Promise((r) => setTimeout(r, knobs.verifyLatencyMs));
    res.json({
      isValid: knobs.valid,
      ...(knobs.valid
        ? { payer: "test-payer" }
        : { invalidReason: "invalid_payment" }),
    });
  });
  app.post("/settle", async (req, res) => {
    calls.push({
      kind: "settle",
      auth: req.get("authorization"),
      network: req.body.paymentRequirements.network,
      payload: req.body,
    });
    await knobs.beforeSettle?.();
    await new Promise((r) => setTimeout(r, knobs.settleLatencyMs));
    res.json({
      success: knobs.success,
      transaction: "fake-settlement-tx",
      network: req.body.paymentRequirements.network,
      payer: "test-payer",
      ...(!knobs.success ? { errorReason: "settlement_failed" } : {}),
    });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No server address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    knobs,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
