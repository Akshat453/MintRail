/**
 * Postgres plumbing shared by every service: pool, Drizzle instance, column
 * helpers that keep money exact, and timestamp formatting compatible with M1.
 */
import { customType } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";

import { parseJson, stringifyJson } from "./json.js";

// int8 → bigint for raw queries (count(*), sums). Drizzle bigint columns convert too.
pg.types.setTypeParser(20, (v: string) => BigInt(v));
// numeric → string (never float)
pg.types.setTypeParser(1700, (v: string) => v);

// biome-ignore lint: Drizzle's generic schema slot.
export type Tx = PgDatabase<NodePgQueryResultHKT, any, any>;
// biome-ignore lint: see above
export type Db = NodePgDatabase<any> & { $client: pg.Pool };

export function makePool(url: string, opts: { max?: number; statementTimeoutMs?: number } = {}): pg.Pool {
  const timeout = Math.trunc(opts.statementTimeoutMs ?? 15_000);
  // Session settings as startup options: no extra round trip, no race with the first query.
  return new pg.Pool({ connectionString: url, max: opts.max ?? 10, options: `-c statement_timeout=${timeout} -c TimeZone=UTC` });
}

export function makeDb(pool: pg.Pool): Db {
  return drizzle(pool) as Db;
}

/** jsonb whose integers round-trip as bigint (never JS number). */
export const jsonbExact = <T = unknown>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => "jsonb",
    toDriver: (value) => stringifyJson(value),
    fromDriver: (value) => parseJson(typeof value === "string" ? value : JSON.stringify(value)) as T,
  })(name);

/** bytea as Buffer. */
export const bytea = (name: string) =>
  customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
    toDriver: (v) => v,
    fromDriver: (v) => v,
  })(name);

/**
 * Postgres timestamptz text ("2026-11-16 18:28:34.17603+00") → M1 API format
 * ("2026-11-16T18:28:34.176030Z"; fraction omitted when zero, like Python isoformat).
 */
export function apiTime(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) value = value.toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (!m) return value;
  const off = m[4] ?? "Z";
  if (off !== "Z" && !/^\+00(:?00)?$/.test(off)) {
    return apiTime(new Date(value.replace(" ", "T")).toISOString());
  }
  const frac = (m[3] ?? "").padEnd(6, "0").slice(0, 6);
  return `${m[1]}T${m[2]}${/^0*$/.test(frac) ? "" : `.${frac}`}Z`;
}
