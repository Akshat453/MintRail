/** Junction HTTP server: ``node junction/dist/main-server.js`` (port 8100). */
import { configureLogging, getSettings, log, makeDb, makePool } from "@mintrail/shared";

import { createApp } from "./app.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 5, statementTimeoutMs: settings.db_statement_timeout_ms });
const port = Number(process.env.PORT ?? 8100);
const server = createApp(settings, makeDb(pool)).listen(port, "0.0.0.0", () => log.info({ port }, "junction listening"));
const shutdown = () => server.close(() => void pool.end());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
