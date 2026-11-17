# Archived: Alembic migration history (M1, Python)

Kept for reference only; **never executed**. Since M1.5 (ADR-0011) the schema is owned by
Drizzle (`drizzle/0000_baseline.sql`). `packages/shared/src/migrate.ts` adopts a database at
Alembic revision `0002` in place, and refuses anything older.
