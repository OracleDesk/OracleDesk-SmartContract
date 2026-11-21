import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { expectedProof, isFailedProbe, normalizeCid, probeTrace, type ProbeOptions } from "./availability.js";
import { rawCidForBytes } from "./ipfs-store.js";

const bytesOf = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fakeFetch(responses: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const found = responses[url];
    if (!found) return new Response("not found", { status: 404 });
    return typeof found === "function" ? found() : found;
  }) as typeof fetch;
}

function opts(fetchImpl: typeof fetch, overrides: Partial<ProbeOptions> = {}): ProbeOptions {
  return { timeoutMs: 1_000, maxBytes: 1_024, retries: 1, fetchImpl, ...overrides };
}

test("normalizeCid strips ipfs URI forms", () => {
  assert.equal(normalizeCid(" ipfs://bafkrei "), "bafkrei");
  assert.equal(normalizeCid("/ipfs/bafkrei"), "bafkrei");
  assert.equal(normalizeCid("local://./trace.json"), "local://./trace.json");
});

test("raw CID is verified by its multihash", async () => {
  const body = bytesOf('{"agent":"trader","action":"buy"}');
  const { cid } = await rawCidForBytes(body);
  const gateway = "https://gw.example/ipfs";
  const result = await probeTrace(
    { id: 7n, cid, traceHash: hex(body) },
    [gateway],
    opts(fakeFetch({ [`${gateway}/${cid}`]: new Response(body) })),
  );
  assert.deepEqual(result, { traceId: 7n, cid, status: "ok", gateway });
});

test("dag-pb CID falls back to the on-chain trace hash", async () => {
  const plaintext = bytesOf('{"outcome":"yes"}');
  // A dag-pb CID commits to a wrapper we do not have to decode; the stored
  // bytes are still checked against the plaintext hash from the registry.
  const wrapper = bytesOf("dag-pb wrapper, not the trace");
  const cid = CID.createV1(0x70, await sha256.digest(wrapper)).toString();
  const gateway = "https://gw.example/ipfs";
  const result = await probeTrace(
    { id: 8n, cid, traceHash: hex(plaintext) },
    [gateway],
    opts(fakeFetch({ [`${gateway}/${cid}`]: new Response(plaintext) })),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.gateway, gateway);
});

test("a gateway serving wrong bytes is reported as mismatch", async () => {
  const good = bytesOf("good bytes");
  const { cid } = await rawCidForBytes(good);
  const liar = "https://liar.example/ipfs";
  const honest = "https://honest.example/ipfs";
  const result = await probeTrace(
    { id: 9n, cid, traceHash: hex(good) },
    [liar, honest],
    opts(fakeFetch({
      [`${liar}/${cid}`]: new Response(bytesOf("tampered")),
      [`${honest}/${cid}`]: new Response(good),
    })),
  );
  assert.equal(result.status, "mismatch");
  assert.equal(result.gateway, liar);
  assert.match(result.error ?? "", /multihash/);
  assert.equal(isFailedProbe(result.status), true);
});

test("encrypted dag-pb content is unsupported, not flagged as a mismatch", async () => {
  const envelope = bytesOf(JSON.stringify({ v: 1, alg: "A256GCM", traceHash: hex(bytesOf("secret")), ct: "..." }));
  const cid = CID.createV1(0x70, await sha256.digest(envelope)).toString();
  const gateway = "https://gw.example/ipfs";
  const result = await probeTrace(
    { id: 10n, cid, traceHash: hex(bytesOf("secret")) },
    [gateway],
    opts(fakeFetch({ [`${gateway}/${cid}`]: new Response(envelope) })),
  );
  assert.equal(result.status, "unsupported");
  assert.match(result.error ?? "", /encrypted/);
});

test("oversized bodies are rejected before verification", async () => {
  const { cid } = await rawCidForBytes(bytesOf("{}"));
  const gateway = "https://gw.example/ipfs";
  const result = await probeTrace(
    { id: 11n, cid },
    [gateway],
    opts(fakeFetch({ [`${gateway}/${cid}`]: new Response(bytesOf("x".repeat(64))) }), { maxBytes: 8 }),
  );
  assert.equal(result.status, "unreachable");
  assert.match(result.error ?? "", /exceeds cap/);
});

test("local:// CIDs are skipped without a fetch", async () => {
  const proof = expectedProof("local://./.traces/1.json");
  assert.equal(proof.kind, "unsupported");
  let fetched = 0;
  const result = await probeTrace(
    { id: 12n, cid: "local://./.traces/1.json" },
    ["https://gw.example/ipfs"],
    opts((async () => { fetched++; return new Response(""); }) as typeof fetch),
  );
  assert.equal(result.status, "unsupported");
  assert.equal(fetched, 0);
});

test("HTTP 429 honours Retry-After before the next attempt", async () => {
  const body = bytesOf("retried");
  const { cid } = await rawCidForBytes(body);
  const gateway = "https://gw.example/ipfs";
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
      : new Response(body);
  }) as typeof fetch;
  const result = await probeTrace({ id: 13n, cid }, [gateway], opts(fetchImpl, { retries: 2 }));
  assert.equal(result.status, "ok");
  assert.equal(calls, 2);
});
