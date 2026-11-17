/**
 * ``node api/dist/main-migrate.js``: apply Drizzle migrations (adopting M1/Alembic
 * databases), then create the bootstrap Railyard admin from MINTRAIL_BOOTSTRAP_ADMIN_*.
 */
import { fileURLToPath } from "node:url";

import { getSettings, makeDb, makePool, runMigrations } from "@mintrail/shared";

import { StaffService } from "./services/staff.js";

const settings = getSettings();
const folder = process.env.MINTRAIL_MIGRATIONS_DIR ?? fileURLToPath(new URL("../../drizzle", import.meta.url));
const pool = makePool(settings.database_url, { max: 2 });
try {
  const r = await runMigrations(pool, folder);
  console.log(`migrations: applied ${r.appliedCount}${r.adoptedFromAlembic ? " (adopted M1 Alembic database)" : ""}`);
  const { bootstrap_admin_email: email, bootstrap_admin_password: password } = settings;
  if (!email || !password) {
    console.log("bootstrap admin: MINTRAIL_BOOTSTRAP_ADMIN_EMAIL/PASSWORD unset; skipping");
  } else {
    const created = await makeDb(pool).transaction((tx) => new StaffService(tx, settings).ensureBootstrapAdmin(email, password));
    console.log(`bootstrap admin ${email}: ${created ? "created" : "already exists"}`);
  }
} finally {
  await pool.end();
}
