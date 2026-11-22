/**
 * Merkle batch anchoring for reasoning traces (#54).
 *
 * An agent collects N trace hashes off-chain, builds a domain-separated
 * second-preimage resistant Merkle tree, and anchors only the 32-byte root
 * plus a manifest CID on-chain via publish_trace_batch.
 *
 * Tree definition:
 * - Leaves: sha256(0x00 || trace_hash)
 * - Inner nodes: sha256(0x01 || left || right)
 * - Odd nodes: promoted unchanged to the next layer
 * - MAX_LEAVES: 4096 (proof length <= 12)
 */

import { createHash } from "node:crypto";
import type { ReasoningTrace } from "./trace.js";

export const MAX_LEAVES = 4096;
export const MAX_PROOF_LEN = 12;
export const MERKLE_LEAF_PREFIX = Buffer.from([0x00]);
export const MERKLE_NODE_PREFIX = Buffer.from([0x01]);

function cleanHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

export function hashLeaf(traceHashHex: string): string {
  const norm = cleanHex(traceHashHex);
  if (norm.length !== 64) {
    throw new Error("traceHash must be 32 bytes hex");
  }
  return createHash("sha256")
    .update(MERKLE_LEAF_PREFIX)
    .update(Buffer.from(norm, "hex"))
    .digest("hex");
}

export function hashNode(leftHex: string, rightHex: string): string {
  const left = cleanHex(leftHex);
  const right = cleanHex(rightHex);
  if (left.length !== 64 || right.length !== 64) {
    throw new Error("node hashes must be 32 bytes hex");
  }
  return createHash("sha256")
    .update(MERKLE_NODE_PREFIX)
    .update(Buffer.from(left, "hex"))
    .update(Buffer.from(right, "hex"))
    .digest("hex");
}

export interface MerkleTree {
  root: string;
  leafCount: number;
  layers: string[][];
}

export function buildTree(traceHashesHex: string[]): MerkleTree {
  if (traceHashesHex.length === 0) {
    throw new Error("cannot build Merkle tree from empty leaves");
  }
  if (traceHashesHex.length > MAX_LEAVES) {
    throw new Error(`leaf count exceeds maximum ${MAX_LEAVES}`);
  }

  const leaves = traceHashesHex.map(hashLeaf);
  const layers: string[][] = [leaves];
  let currentLayer = leaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(hashNode(currentLayer[i], currentLayer[i + 1]));
      } else {
        // Odd node promoted unchanged
        nextLayer.push(currentLayer[i]);
      }
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return {
    root: currentLayer[0],
    leafCount: traceHashesHex.length,
    layers,
  };
}

export function proofFor(treeOrHashes: MerkleTree | string[], index: number): string[] {
  const tree = Array.isArray(treeOrHashes) ? buildTree(treeOrHashes) : treeOrHashes;
  if (index < 0 || index >= tree.leafCount) {
    throw new Error(`index ${index} out of bounds for leaf count ${tree.leafCount}`);
  }

  const proof: string[] = [];
  let currIdx = index;

  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const currLen = layer.length;

    if (currLen % 2 === 1 && currIdx === currLen - 1) {
      // Lone odd node promoted unchanged: no sibling in proof
    } else if (currIdx % 2 === 0) {
      // Sibling is on the right
      proof.push(layer[currIdx + 1]);
    } else {
      // Sibling is on the left
      proof.push(layer[currIdx - 1]);
    }

    currIdx = Math.floor(currIdx / 2);
  }

  return proof;
}

export function verifyInclusion(
  rootHex: string,
  leafCount: number,
  traceHashHex: string,
  index: number,
  proofHex: string[],
): boolean {
  if (leafCount <= 0 || leafCount > MAX_LEAVES) return false;
  if (index < 0 || index >= leafCount) return false;
  if (proofHex.length > MAX_PROOF_LEN) return false;

  let current = hashLeaf(traceHashHex);
  let currIdx = index;
  let currLen = leafCount;
  let proofIdx = 0;

  while (currLen > 1) {
    if (currLen % 2 === 1 && currIdx === currLen - 1) {
      // Lone odd node promoted without sibling
    } else {
      if (proofIdx >= proofHex.length) return false;
      const sibling = proofHex[proofIdx++];
      if (currIdx % 2 === 0) {
        current = hashNode(current, sibling);
      } else {
        current = hashNode(sibling, current);
      }
    }

    currIdx = Math.floor(currIdx / 2);
    currLen = Math.floor((currLen + 1) / 2);
  }

  return proofIdx === proofHex.length && cleanHex(current) === cleanHex(rootHex);
}

export interface QueuedBatchTrace {
  trace: ReasoningTrace;
  traceHash: string;
  cid: string;
}

export interface BatchManifest {
  version: "oracledesk.batch.manifest.v1";
  root: string;
  leafCount: number;
  publishedAt: number;
  traces: Array<{
    index: number;
    traceHash: string;
    cid: string;
    marketId: number | null;
    action: string;
  }>;
}

// ---------------------------------------------------------------------------
// V2 leaf encoding — binds agent / market / action / position (issue #308)
//
// v1 leaf: sha256(0x00 || trace_hash)
// v2 leaf: sha256(0x00 || 0x02 || trace_hash || agent_hash || market_id_be8 ||
//                         action_hash || position_be8)
//
// 0x02 is a version discriminant so a v2 leaf can never collide with v1.
// All string fields are sha256-hashed to give a fixed 32-byte slot.
// ---------------------------------------------------------------------------

export const MERKLE_V2_VERSION = Buffer.from([0x02]);
export const MERKLE_V2_MAX_POSITION = 2 ** 32 - 1;

export interface TraceLeafV2 {
  traceHash: string;
  agent: string;
  marketId: bigint;
  action: string;
  /** 0-based position of this trace in the batch (u32, big-endian 8 bytes). */
  position: number;
}

function hashField(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function marketIdToBuffer(marketId: bigint): Buffer {
  if (marketId < 0n || marketId > 0xffff_ffff_ffff_ffffn) {
    throw new Error("marketId must fit in a u64");
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(marketId);
  return buf;
}

function positionToBuffer(position: number): Buffer {
  if (!Number.isInteger(position) || position < 0 || position > MERKLE_V2_MAX_POSITION) {
    throw new Error("position must be a non-negative integer fitting in u32");
  }
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(position, 4);
  return buf;
}

/**
 * Hashes a single trace into a v2 Merkle leaf.
 * The leaf binds all four semantic fields to prevent cross-batch replay attacks.
 */
export function hashLeafV2(leaf: TraceLeafV2): string {
  const norm = cleanHex(leaf.traceHash);
  if (norm.length !== 64) throw new Error("traceHash must be 32 bytes hex");
  return createHash("sha256")
    .update(MERKLE_LEAF_PREFIX)      // 0x00 — leaf domain separator
    .update(MERKLE_V2_VERSION)       // 0x02 — v2 discriminant
    .update(Buffer.from(norm, "hex"))
    .update(hashField(leaf.agent))
    .update(marketIdToBuffer(leaf.marketId))
    .update(hashField(leaf.action))
    .update(positionToBuffer(leaf.position))
    .digest("hex");
}

export interface BatchManifestV2 {
  version: "oracledesk.batch.manifest.v2";
  root: string;
  leafCount: number;
  publishedAt: number;
  traces: Array<{
    index: number;
    traceHash: string;
    cid: string;
    agent: string;
    marketId: string;
    action: string;
  }>;
}

export interface BatchTraceProof {
  root: string;
  leafCount: number;
  index: number;
  leaf: TraceLeafV2;
  proof: string[];
}

/**
 * Builds a v2 Merkle tree from a list of leaf descriptors and returns the
 * tree plus an inclusion proof for the requested index.
 */
export function prove_batched_trace(
  leaves: TraceLeafV2[],
  proofIndex: number,
): { tree: MerkleTree; batchProof: BatchTraceProof } {
  if (leaves.length === 0) throw new Error("cannot build tree from empty leaves");
  if (leaves.length > MAX_LEAVES) throw new Error(`leaf count exceeds maximum ${MAX_LEAVES}`);
  if (proofIndex < 0 || proofIndex >= leaves.length) {
    throw new Error(`proofIndex ${proofIndex} out of bounds`);
  }

  const leafHashes = leaves.map((l) => hashLeafV2(l));

  // Build tree from raw leaf hashes (bypassing hashLeaf — leaves are already hashed)
  const layers: string[][] = [leafHashes];
  let currentLayer = leafHashes;
  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(hashNode(currentLayer[i], currentLayer[i + 1]));
      } else {
        nextLayer.push(currentLayer[i]);
      }
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const tree: MerkleTree = {
    root: currentLayer[0],
    leafCount: leaves.length,
    layers,
  };

  // Generate proof by walking up the tree
  const proof: string[] = [];
  let currIdx = proofIndex;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const currLen = layer.length;
    if (currLen % 2 === 1 && currIdx === currLen - 1) {
      // odd lone node — no sibling
    } else if (currIdx % 2 === 0) {
      proof.push(layer[currIdx + 1]);
    } else {
      proof.push(layer[currIdx - 1]);
    }
    currIdx = Math.floor(currIdx / 2);
  }

  return {
    tree,
    batchProof: {
      root: tree.root,
      leafCount: tree.leafCount,
      index: proofIndex,
      leaf: leaves[proofIndex],
      proof,
    },
  };
}

/**
 * Verifies a BatchTraceProof produced by prove_batched_trace.
 */
export function verifyBatchTraceProof(batchProof: BatchTraceProof): boolean {
  const { root, leafCount, index, leaf, proof } = batchProof;
  if (leafCount <= 0 || leafCount > MAX_LEAVES) return false;
  if (index < 0 || index >= leafCount) return false;
  if (proof.length > MAX_PROOF_LEN) return false;

  let current = hashLeafV2(leaf);
  let currIdx = index;
  let currLen = leafCount;
  let proofIdx = 0;

  while (currLen > 1) {
    if (currLen % 2 === 1 && currIdx === currLen - 1) {
      // odd lone node
    } else {
      if (proofIdx >= proof.length) return false;
      const sibling = proof[proofIdx++];
      current = currIdx % 2 === 0
        ? hashNode(current, sibling)
        : hashNode(sibling, current);
    }
    currIdx = Math.floor(currIdx / 2);
    currLen = Math.floor((currLen + 1) / 2);
  }

  return proofIdx === proof.length && cleanHex(current) === cleanHex(root);
}

export class BatchCollector {
  private queue: QueuedBatchTrace[] = [];

  constructor(public readonly maxLeaves: number = MAX_LEAVES) {}

  add(item: QueuedBatchTrace): void {
    if (this.queue.length >= this.maxLeaves) {
      throw new Error(`batch is full (${this.maxLeaves} leaves)`);
    }
    this.queue.push(item);
  }

  get size(): number {
    return this.queue.length;
  }

  flush(): {
    tree: MerkleTree;
    manifest: BatchManifest;
    traces: QueuedBatchTrace[];
  } {
    if (this.queue.length === 0) {
      throw new Error("cannot flush empty batch");
    }

    const traces = [...this.queue];
    this.queue = [];

    const traceHashes = traces.map((t) => t.traceHash);
    const tree = buildTree(traceHashes);

    const manifest: BatchManifest = {
      version: "oracledesk.batch.manifest.v1",
      root: tree.root,
      leafCount: tree.leafCount,
      publishedAt: Math.floor(Date.now() / 1000),
      traces: traces.map((t, idx) => ({
        index: idx,
        traceHash: t.traceHash,
        cid: t.cid,
        marketId: t.trace.marketId,
        action: t.trace.action,
      })),
    };

    return { tree, manifest, traces };
  }
}
