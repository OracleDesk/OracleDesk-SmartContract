/**
 * Picks the agents' {@link TraceStore} from config. `TRACE_STORE=local|ipfs`
 * defaults to `local` in dry-run and `ipfs` in live mode. Live mode refuses
 * the local store (whose `local://` "CIDs" no buyer can fetch) unless
 * `ALLOW_LOCAL_TRACE_STORE=1`.
 */
import { IpfsTraceStore, KuboProvider, PinningServiceProvider, type PinProvider } from "./ipfs-store.js";
import { LocalTraceStore, type TraceStore } from "./trace.js";

export type TraceStoreKind = "local" | "ipfs";

export const DEFAULT_IPFS_GATEWAY_URL = "https://ipfs.io/ipfs";

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return n;
}

export function createTraceStore(
  env: NodeJS.ProcessEnv,
  mode: "dry-run" | "live",
): { store: TraceStore; kind: TraceStoreKind } {
  const kind = (env.TRACE_STORE || (mode === "live" ? "ipfs" : "local")) as TraceStoreKind;

  if (kind === "local") {
    if (mode === "live" && env.ALLOW_LOCAL_TRACE_STORE !== "1") {
      throw new Error(
        "live mode refuses TRACE_STORE=local: its local:// CIDs cannot be fetched by trace buyers. " +
          "Configure TRACE_STORE=ipfs, or set ALLOW_LOCAL_TRACE_STORE=1 to override.",
      );
    }
    return { store: new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces"), kind };
  }
  if (kind !== "ipfs") throw new Error(`TRACE_STORE must be local or ipfs, got '${kind}'`);

  const acceptQueued = env.IPFS_ACCEPT_QUEUED === "1";
  const providers: PinProvider[] = [];
  if (env.IPFS_KUBO_API_URL) {
    providers.push(new KuboProvider({ apiUrl: env.IPFS_KUBO_API_URL, authHeader: env.IPFS_KUBO_AUTH || undefined }));
  }
  if (env.IPFS_PINNING_ENDPOINT) {
    if (!env.IPFS_PINNING_TOKEN) throw new Error("IPFS_PINNING_ENDPOINT needs IPFS_PINNING_TOKEN");
    if (!env.IPFS_KUBO_API_URL && !env.IPFS_PINNING_ORIGINS) {
      // The Pinning Service API pins by CID only; something must serve the bytes.
      throw new Error("IPFS_PINNING_ENDPOINT alone cannot upload content: also set IPFS_KUBO_API_URL");
    }
    providers.push(
      new PinningServiceProvider({
        endpoint: env.IPFS_PINNING_ENDPOINT,
        token: env.IPFS_PINNING_TOKEN,
        origins: env.IPFS_PINNING_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
        acceptQueued,
      }),
    );
  }
  if (providers.length === 0) {
    throw new Error("TRACE_STORE=ipfs needs IPFS_KUBO_API_URL (and optionally IPFS_PINNING_ENDPOINT)");
  }

  const store = new IpfsTraceStore({
    providers,
    minPins: positiveInt(env, "IPFS_MIN_PINS", 1),
    pinTimeoutMs: positiveInt(env, "IPFS_PIN_TIMEOUT_MS", 60_000),
    retries: positiveInt(env, "IPFS_PIN_RETRIES", 3),
    gatewayUrl: env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL,
    acceptQueued,
  });
  return { store, kind };
}
