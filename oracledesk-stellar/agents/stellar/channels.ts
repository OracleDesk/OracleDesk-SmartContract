import { Keypair, rpc } from "@stellar/stellar-sdk";
import { AsyncMutex } from "../runtime/locks.js";

export interface Channel {
  address: string;
  signer: (tx: unknown) => Promise<unknown>;
  nextSeq: bigint;
  mutex: AsyncMutex;
  retired: boolean;
}

export interface ChannelLease {
  channel: Channel;
  sequence: bigint;
  release(outcome: "applied" | "unused" | "unknown"): void;
}

export interface ChannelJournal {
  write(record: {
    id: string;
    stage: "reserved" | "signed" | "submitting" | "submitted" | "uncertain" | "expired" | "superseded";
    source?: string;
    sequence?: string;
    hash?: string;
  }): Promise<void>;
  latestById?(id: string): Promise<unknown[]>;
}

/** A pool of independent Stellar transaction sources. */
export class ChannelPool {
  private readonly channels: Channel[];

  constructor(channels: Channel[], private readonly server: rpc.Server, private readonly journal: ChannelJournal) {
    this.channels = channels;
  }

  static fromSecrets(secrets: string[], server: rpc.Server, journal: ChannelJournal): ChannelPool {
    const channels = secrets.map((secret) => {
      const keypair = Keypair.fromSecret(secret);
      return {
        address: keypair.publicKey(),
        signer: async () => keypair,
        nextSeq: 0n,
        mutex: new AsyncMutex(),
        retired: false,
      } satisfies Channel;
    });
    return new ChannelPool(channels, server, journal);
  }

  /** Least busy non-retired channel. */
  async acquire(intent: string, signal: AbortSignal): Promise<ChannelLease> {
    if (signal.aborted) throw new Error("channel acquisition aborted");
    for (;;) {
      const candidates = this.channels.filter((channel) => !channel.retired);
      if (candidates.length === 0) throw new Error("no active channel accounts");
      candidates.sort((a, b) => a.mutex.queued - b.mutex.queued);
      const channel = candidates[0];
      let acquired = false;
      await channel.mutex.run(async () => {
        acquired = true;
      });
      if (acquired) {
        const sequence = channel.nextSeq;
        await this.journal.write({ id: intent, stage: "reserved", source: channel.address, sequence: sequence.toString() });
        let released = false;
        return {
          channel,
          sequence,
          release: (outcome) => {
            if (released) return;
            released = true;
            if (outcome === "unused") {
              channel.nextSeq = channel.nextSeq === sequence ? channel.nextSeq : channel.nextSeq;
              void this.journal.write({ id: intent, stage: "expired", source: channel.address, sequence: sequence.toString() });
            }
          },
        };
      }
    }
  }

  async resync(address: string): Promise<bigint> {
    const channel = this.channels.find((item) => item.address === address);
    if (!channel) throw new Error(`unknown channel ${address}`);
    const account = await this.server.getAccount(address);
    channel.nextSeq = BigInt(account.sequenceNumber()) + 1n;
    return channel.nextSeq;
  }

  async recover(): Promise<void> {
    for (const channel of this.channels) {
      await this.resync(channel.address);
    }
  }
}
