/**
 * The schema contract:
 *   - the baseline migration alone pg_dumps *identically* to docs/contract/schema-m1.sql
 *     (the frozen M1 schema);
 *   - the full chain pg_dumps identically to docs/contract/schema-m2.sql (regenerate with
 *     ``MINTRAIL_UPDATE_CONTRACT=1`` after an intended schema change, and review the diff);
 *   - an existing M1 (Alembic) database is adopted in place and upgraded with data untouched.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import { runMigrations } from "../src/migrate.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS = `${ROOT}drizzle`;
let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
}, 120_000);
afterAll(async () => {
  await container?.stop();
});

function normalise(dump: string): string[] {
  const s = dump
    .replace(/CREATE TABLE public\.alembic_version \([^;]*\);\n/, "")
    .replace(/ALTER TABLE ONLY public\.alembic_version\n {4}ADD CONSTRAINT alembic_version_pkc PRIMARY KEY \(version_num\);\n/, "");
  return s.split("\n").filter((l) => l && !l.startsWith("--") && !l.startsWith("\\") && !l.startsWith("SET ") && !l.includes("set_config"));
}

async function freshDb(name: string): Promise<string> {
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return container.getConnectionUri().replace(/\/[^/]+$/, `/${name}`);
}

async function dump(dbName: string): Promise<string> {
  const r = await container.exec([
    "pg_dump",
    "-U",
    container.getUsername(),
    "-d",
    dbName,
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--exclude-schema=drizzle",
  ]);
  return r.output;
}

/** A copy of the migrations folder truncated to the first ``n`` journal entries. */
function migrationsUpTo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mr-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(`${dir}/meta/_journal.json`, JSON.stringify(journal));
  return dir;
}

test("the baseline migration reproduces the frozen M1 schema exactly (pg_dump)", async () => {
  const url = await freshDb("contract_m1_only");
  const pool = new pg.Pool({ connectionString: url });
  const r = await runMigrations(pool, migrationsUpTo(1));
  await pool.end();
  expect(r).toEqual({ adoptedFromAlembic: false, appliedCount: 1 });
  expect(normalise(await dump("contract_m1_only"))).toEqual(normalise(readFileSync(`${ROOT}docs/contract/schema-m1.sql`, "utf8")));
}, 120_000);

test("the full migration chain reproduces docs/contract/schema-m2.sql (pg_dump)", async () => {
  const url = await freshDb("contract_fresh");
  const pool = new pg.Pool({ connectionString: url });
  const r = await runMigrations(pool, MIGRATIONS);
  await pool.end();
  expect(r).toEqual({ adoptedFromAlembic: false, appliedCount: 3 });
  const actual = await dump("contract_fresh");
  if (process.env.MINTRAIL_UPDATE_CONTRACT === "1") writeFileSync(`${ROOT}docs/contract/schema-m2.sql`, actual);
  expect(normalise(actual)).toEqual(normalise(readFileSync(`${ROOT}docs/contract/schema-m2.sql`, "utf8")));
}, 120_000);

test("an M1 (Alembic 0002) database is adopted in place, data untouched", async () => {
  const url = await freshDb("contract_m1");
  // Recreate an M1 database: the contract schema + alembic_version + a row of data.
  const contract = readFileSync(`${ROOT}docs/contract/schema-m1.sql`, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("\\"))
    .join("\n");
  execFileSync(
    "docker",
    ["exec", "-i", container.getId(), "psql", "-q", "-U", container.getUsername(), "-d", "contract_m1", "-v", "ON_ERROR_STOP=1"],
    { input: contract },
  );
  const pool = new pg.Pool({ connectionString: url });
  await pool.query("SET search_path = public");
  await pool.query("INSERT INTO public.alembic_version VALUES ('0002')");
  await pool.query(
    "INSERT INTO public.stations (id, legal_name, display_name, email, business_category, country, default_currency, status, kyc_status, settlement_schedule, fee_plan, auto_capture, rate_limit_per_sec, rate_limit_burst) VALUES ('mer_legacy','L','L','l@x.example','5814','IN','INR','active','verified','T+2','standard',true,25,50)",
  );
  const r = await runMigrations(pool, MIGRATIONS);
  expect(r).toEqual({ adoptedFromAlembic: true, appliedCount: 2 }); // baseline adopted, M2 migrations applied
  expect((await pool.query("SELECT id, kyc_status FROM public.stations")).rows).toEqual([{ id: "mer_legacy", kyc_status: "verified" }]);
  expect((await pool.query("SELECT count(*)::int AS n FROM public.refunds")).rows).toEqual([{ n: 0 }]);
  // Idempotent: a second run is a no-op.
  expect(await runMigrations(pool, MIGRATIONS)).toEqual({ adoptedFromAlembic: false, appliedCount: 0 });
  await pool.end();
}, 120_000);

test("refuses to adopt an older Alembic revision", async () => {
  const url = await freshDb("contract_old");
  const pool = new pg.Pool({ connectionString: url });
  await pool.query("CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY); INSERT INTO alembic_version VALUES ('0001')");
  await expect(runMigrations(pool, MIGRATIONS)).rejects.toThrow(/Alembic revision 0001/);
  await pool.end();
}, 120_000);
