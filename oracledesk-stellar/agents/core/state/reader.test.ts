import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { ChainStateReader } from "./reader.js";

function mapValue(entries: Array<[string, xdr.ScVal]>): Buffer {
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  ).toXDR();
}

test("reads market-core Market and Settle entries and exposes closure", async () => {
  const creator = new Address(Keypair.random().publicKey()).toScAddress();
  const market = mapValue([
    ["creator", xdr.ScVal.scvAddress(creator)],
    ["question_hash", xdr.ScVal.scvBytes(Buffer.alloc(32, 1))],
    ["resolution_hash", xdr.ScVal.scvBytes(Buffer.alloc(32, 2))],
    ["meta_uri", xdr.ScVal.scvString("ipfs://market")],
    ["category", xdr.ScVal.scvSymbol("Other")],
    ["status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Resolved"), xdr.ScVal.scvSymbol("Yes")])],
    ["lp_claimed", xdr.ScVal.scvBool(true)],
  ]);
  const settle = mapValue([["closed", xdr.ScVal.scvBool(true)]]);
  const server = {
    getLedgerEntries: async () => ({
      entries: [
        { val: market, lastModifiedLedgerSeq: 20 },
        { val: settle, lastModifiedLedgerSeq: 21 },
      ],
    }),
  } as any;

  const reader = new ChainStateReader({
    marketContractId: StrKey.encodeContract(Buffer.alloc(32, 3)),
    portfolioContractId: StrKey.encodeContract(Buffer.alloc(32, 4)),
    server,
  });
  const snapshot = await reader.readSnapshot([7n]);
  const result = snapshot.markets.get(7n);
  assert.equal(result?.marketId, 7n);
  assert.equal(result?.status, "resolved_yes");
  assert.equal(result?.closed, true);
  assert.deepEqual(snapshot.ledgers, { min: 20, max: 21 });
});
