/**
 * CPython's ``random.Random`` (MT19937) for the subset Junction uses:
 * string seeding (version 2: seed ‖ sha512(seed)), ``random()``, ``uniform()``
 * and ``choices(weights=…, k=1)``. Bit-for-bit compatible, so a given
 * ``MINTRAIL_JUNCTION_SEED`` and payment id produce the same outcome as M1.
 */
import { createHash } from "node:crypto";

const N = 624;
const M = 397;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: string) {
    const bytes = Buffer.from(seed, "utf8");
    const full = Buffer.concat([bytes, createHash("sha512").update(bytes).digest()]);
    let a = BigInt(`0x${full.toString("hex")}`);
    const key: number[] = [];
    while (a > 0n) {
      key.push(Number(a & 0xffffffffn));
      a >>= 32n;
    }
    if (key.length === 0) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  private genrandUint32(): number {
    const mag01 = [0, 0x9908b0df];
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (this.mt[kk]! & 0x80000000) | (this.mt[kk + 1]! & 0x7fffffff);
        this.mt[kk] = this.mt[kk + M]! ^ (y >>> 1) ^ mag01[y & 1]!;
      }
      for (; kk < N - 1; kk++) {
        const y = (this.mt[kk]! & 0x80000000) | (this.mt[kk + 1]! & 0x7fffffff);
        this.mt[kk] = this.mt[kk + (M - N)]! ^ (y >>> 1) ^ mag01[y & 1]!;
      }
      const y = (this.mt[N - 1]! & 0x80000000) | (this.mt[0]! & 0x7fffffff);
      this.mt[N - 1] = this.mt[M - 1]! ^ (y >>> 1) ^ mag01[y & 1]!;
      this.mti = 0;
    }
    let y = this.mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** [0, 1) with 53-bit resolution, exactly as CPython. */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864 + b) * (1 / 9007199254740992);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** ``choices(population, weights=weights, k=1)[0]``. */
  choice<T>(population: readonly T[], weights: readonly number[]): T {
    const cum: number[] = [];
    let acc = 0;
    for (const w of weights) {
      acc += w;
      cum.push(acc);
    }
    const total = cum[cum.length - 1]! + 0;
    const x = this.random() * total;
    // bisect_right(cum, x, 0, n - 1)
    let lo = 0;
    let hi = population.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x < cum[mid]!) hi = mid;
      else lo = mid + 1;
    }
    return population[lo]!;
  }
}

/** Python ``round(x, 2)`` for the non-tie values produced here. */
export const round2 = (x: number): number => Number(x.toFixed(2));
