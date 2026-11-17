/** Platform API server: ``node api/dist/main-server.js`` (port 8000). */
import { configureLogging, getSettings, log, makeDb, makePool } from "@mintrail/shared";

import { createApp } from "./app.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: settings.db_pool_size, statementTimeoutMs: settings.db_statement_timeout_ms });
const port = Number(process.env.PORT ?? 8000);
const server = createApp({ settings, db: makeDb(pool) }).listen(port, "0.0.0.0", () => log.info({ port }, "platform api listening"));
const shutdown = () => server.close(() => void pool.end());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
