import { defineConfig } from "drizzle-kit";

/**
 * One migration history for the whole database (ADR-0001); each service owns
 * its tables. Generate with ``pnpm db:generate --name <slug>`` after a schema
 * change; apply with ``pnpm db:migrate`` (packages/shared/src/main-migrate.ts).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./packages/shared/dist/jobs.js",
    "./ledger/dist/schema.js",
    "./conductor/dist/schema.js",
    "./junction/dist/schema.js",
    "./signal/dist/schema.js",
    "./api/dist/schema/index.js",
  ],
  out: "./drizzle",
  dbCredentials: { url: process.env.MINTRAIL_DATABASE_URL ?? "postgres://mintrail:mintrail@localhost:15432/mintrail" },
});
