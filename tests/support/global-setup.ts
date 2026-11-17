/**
 * Integration tests get a real PostgreSQL 16: ``MINTRAIL_TEST_DATABASE_URL`` (CI
 * service container / a local DB that will be wiped) or a Testcontainers one.
 * The schema is built by the real migrations, triggers included.
 */
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { runMigrations } from "@mintrail/shared";

import "./db.js"; // ProvidedContext augmentation

export const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.MINTRAIL_TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    url = container.getConnectionUri();
  } else {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.end();
  }
  const pool = new pg.Pool({ connectionString: url });
  await runMigrations(pool, MIGRATIONS);
  await pool.end();
  project.provide("databaseUrl", url);
  return async () => {
    await container?.stop();
  };
}
