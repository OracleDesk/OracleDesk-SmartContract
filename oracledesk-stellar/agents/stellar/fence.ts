import {
  Account,
  Keypair,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface FenceAnchorOptions {
  window?: number;
  feeStroops?: number;
}

export async function anchorFence(
  server: rpc.Server,
  networkPassphrase: string,
  signerSecret: string,
  sourceAddress: string,
  options: FenceAnchorOptions = {},
): Promise<string> {
  const window = options.window ?? 64;
  if (!Number.isInteger(window) || window < 1) throw new RangeError("fence sequence window must be positive");

  const accountRecord = await server.getAccount(sourceAddress);
  const current = BigInt(accountRecord.sequenceNumber);
  const bumpTo = current + BigInt(window);
  const account = new Account(sourceAddress, accountRecord.sequenceNumber);
  const tx = new TransactionBuilder(account, {
    fee: String(options.feeStroops ?? 100),
    networkPassphrase,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: bumpTo.toString() }))
    .setTimeout(30)
    .build();
  tx.sign(Keypair.fromSecret(signerSecret));
  const response = await server.sendTransaction(tx);
  if (response.status !== "PENDING" && response.status !== "DUPLICATE") {
    throw new Error(`fence anchor failed: ${String(response.status)}`);
  }
  return tx.hash().toString("hex");
}
