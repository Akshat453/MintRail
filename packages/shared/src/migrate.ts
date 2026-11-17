/**
 * Apply Drizzle migrations, adopting databases created by M1's Alembic history.
 *
 * An M1 database (``alembic_version = '0002'``) already has exactly the baseline
 * schema (proven by the schema-contract test), so the baseline is *recorded* as
 * applied — same hash/timestamp Drizzle computes — instead of re-run. No data
 * is touched. Later migrations then apply normally.
 */
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { makeDb } from "./db.js";

export const M1_ALEMBIC_HEAD = "0002";

export interface MigrateResult {
  adoptedFromAlembic: boolean;
  appliedCount: number;
}

export async function runMigrations(pool: pg.Pool, migrationsFolder: string): Promise<MigrateResult> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const baseline = migrations[0];
  if (!baseline) throw new Error(`no migrations found in ${migrationsFolder}`);

  const client = await pool.connect();
  let adopted = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mintrail:migrate'))");
    const { rows: alembic } = await client.query<{ exists: boolean }>("SELECT to_regclass('public.alembic_version') IS NOT NULL AS exists");
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    const { rows: applied } = await client.query('SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"');
    if (alembic[0]?.exists && applied[0].n === 0) {
      const { rows } = await client.query<{ version_num: string }>("SELECT version_num FROM alembic_version");
      const version = rows[0]?.version_num;
      if (version !== M1_ALEMBIC_HEAD) {
        throw new Error(
          `database is at Alembic revision ${version ?? "<none>"}; upgrade it to ${M1_ALEMBIC_HEAD} with the M1 release before adopting`,
        );
      }
      await client.query('INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)', [
        baseline.hash,
        baseline.folderMillis,
      ]);
      adopted = true;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const before = await pool.query('SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"');
  await drizzleMigrate(makeDb(pool), { migrationsFolder });
  const after = await pool.query('SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"');
  return { adoptedFromAlembic: adopted, appliedCount: after.rows[0].n - before.rows[0].n };
}
