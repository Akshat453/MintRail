/**
 * Prefixed, time-sortable identifiers: ``<prefix>_<26 lowercase Crockford base32>``
 * — a ULID body (48-bit ms timestamp + 80 random bits). See ADR-0005.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { InvalidRequestError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const BODY_LEN = 26;
const BODY_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

export const IdPrefix = {
  STATION: "mer",
  API_KEY: "key",
  ORDER: "ord",
  PAYMENT: "pay",
  REFUND: "rfd",
  DISPUTE: "dsp",
  SETTLEMENT: "stl",
  PAYOUT: "pout",
  WEBHOOK: "whk",
  EVENT: "evt",
  STAFF: "stf",
  STAFF_SESSION: "ses",
  BLOCKLIST_ENTRY: "blk",
  LEDGER_ACCOUNT: "lac",
  LEDGER_TRANSACTION: "ltx",
  REQUEST: "req",
  // M2
  PAYOUT_BATCH: "pbat",
  DASHBOARD_USER: "usr",
  DASHBOARD_SESSION: "dss",
  DERAILMENT: "drl",
  EVIDENCE_FILE: "file",
  RECONCILIATION: "rcn",
  FX_RATE: "fxr",
  WEBHOOK_DELIVERY: "whd",
} as const;
export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

export function encodeBody(value: bigint): string {
  let v = value;
  const chars: string[] = [];
  for (let i = 0; i < BODY_LEN; i++) {
    chars.push(CROCKFORD[Number(v % 32n)]!);
    v /= 32n;
  }
  return chars.reverse().join("");
}

/** Optional deterministic id source (seed data only); production always uses the clock + CSPRNG. */
export interface IdSource {
  nowMs(): bigint;
  random80(): bigint;
}
let idSource: IdSource | null = null;
const scopedSource = new AsyncLocalStorage<IdSource>();
export function setIdSource(source: IdSource | null): void {
  idSource = source;
}
/** Run ``fn`` with its own id source (deterministic even when several such calls interleave). */
export const withIdSource = <T>(source: IdSource, fn: () => Promise<T>): Promise<T> => scopedSource.run(source, fn);

export function newId(prefix: IdPrefix, timestampMs?: bigint): string {
  const src = scopedSource.getStore() ?? idSource;
  const ts = timestampMs ?? src?.nowMs() ?? BigInt(Date.now());
  if (ts < 0n || ts >= 1n << 48n) throw new RangeError("timestamp out of range");
  const rand = src ? src.random80() & ((1n << 80n) - 1n) : BigInt(`0x${randomBytes(10).toString("hex")}`);
  return `${prefix}_${encodeBody((ts << 80n) | rand)}`;
}

/** Deterministic id from explicit parts (seed data, fixtures): ``rand80`` supplies the 80 random bits. */
export function idFrom(prefix: IdPrefix, timestampMs: bigint, rand80: bigint): string {
  if (timestampMs < 0n || timestampMs >= 1n << 48n) throw new RangeError("timestamp out of range");
  return `${prefix}_${encodeBody((timestampMs << 80n) | (rand80 & ((1n << 80n) - 1n)))}`;
}

export function isValidId(value: unknown, prefix: IdPrefix): boolean {
  if (typeof value !== "string") return false;
  const idx = value.indexOf("_");
  if (idx < 0) return false;
  return value.slice(0, idx) === prefix && BODY_RE.test(value.slice(idx + 1));
}

/** Validate ``value`` as an ID of the given kind, raising MR_INVALID_REQUEST. */
export function parseId(value: string, prefix: IdPrefix, param = "id"): string {
  if (!isValidId(value, prefix)) {
    throw new InvalidRequestError(`${pyRepr(value)} is not a valid ${prefix}_ identifier`, { param });
  }
  return value;
}

export function idTimestampMs(value: string): bigint {
  const body = value.slice(value.indexOf("_") + 1);
  if (!BODY_RE.test(body)) throw new RangeError(`malformed id ${value}`);
  let n = 0n;
  for (const ch of body) n = n * 32n + BigInt(CROCKFORD.indexOf(ch));
  return n >> 80n;
}
