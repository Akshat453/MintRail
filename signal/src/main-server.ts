/** Signal HTTP service: ``node signal/dist/main-server.js`` (port 8200). */
import { configureLogging, getSettings, log, makeDb, makePool } from "@mintrail/shared";

import { createSignalApp } from "./app.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 4, statementTimeoutMs: settings.db_statement_timeout_ms });
const port = Number(process.env.PORT ?? 8200);
const server = createSignalApp(settings, makeDb(pool)).listen(port, "0.0.0.0", () => log.info({ port }, "signal listening"));
const shutdown = () => server.close(() => void pool.end());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
