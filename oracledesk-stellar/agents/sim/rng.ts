/**
 * Deterministic randomness for the simulator: xoshiro128** streams seeded
 * through splitmix64. `fork(label)` derives an independent stream from the
 * parent's seed and a label (never from how many numbers the parent has
 * drawn), so adding an agent or a market never perturbs any other stream.
 * Nothing in agents/sim may use Math.random.
 */

const MASK64 = (1n << 64n) - 1n;

/** One splitmix64 step: returns [next state, output]. */
export function splitmix64(state: bigint): [bigint, bigint] {
  const s = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return [s, z ^ (z >> 31n)];
}

/** FNV-1a 64 of a label, for fork(). */
function fnv1a64(label: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(label)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | undefined;

  constructor(readonly seed: bigint) {
    let state = seed & MASK64;
    const words: number[] = [];
    while (words.length < 4) {
      const [next, out] = splitmix64(state);
      state = next;
      words.push(Number(out & 0xffffffffn), Number(out >> 32n));
    }
    [this.s0, this.s1, this.s2, this.s3] = words as [number, number, number, number];
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Independent stream named `label`, a pure function of (seed, label). */
  fork(label: string): Rng {
    return new Rng(splitmix64((this.seed ^ fnv1a64(label)) & MASK64)[1]);
  }

  /** xoshiro128** next uint32. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0;
    this.s1 >>>= 0;
    this.s2 >>>= 0;
    return result;
  }

  /** Uniform in [0, 1) with 53 bits. */
  float(): number {
    const hi = this.nextU32() >>> 5;
    const lo = this.nextU32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`int(${n})`);
    return Number(this.bigBelow(BigInt(n)));
  }

  /** Uniform bigint in [0, n) by rejection sampling (no modulo bias). */
  bigBelow(n: bigint): bigint {
    if (n <= 0n) throw new Error(`bigBelow(${n})`);
    const bits = n.toString(2).length;
    const words = Math.ceil(bits / 32);
    const excess = BigInt(words * 32 - bits);
    for (;;) {
      let v = 0n;
      for (let i = 0; i < words; i++) v = (v << 32n) | BigInt(this.nextU32());
      v >>= excess;
      if (v < n) return v;
    }
  }

  /** Uniform bigint in [lo, hi]. */
  bigBetween(lo: bigint, hi: bigint): bigint {
    if (hi < lo) throw new Error(`bigBetween(${lo}, ${hi})`);
    return lo + this.bigBelow(hi - lo + 1n);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Standard normal (Box–Muller, caching the second deviate). */
  normal(): number {
    if (this.spareNormal !== undefined) {
      const v = this.spareNormal;
      this.spareNormal = undefined;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.float();
    const v = this.float();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareNormal = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}
