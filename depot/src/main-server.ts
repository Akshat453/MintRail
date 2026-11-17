/** Depot internal API: ``node depot/dist/main-server.js`` (port 8300). */
import { JunctionClient } from "@mintrail/api";
import { configureLogging, getSettings, log, makeDb, makePool } from "@mintrail/shared";

import { createDepotApp } from "./app.js";
import { junctionFeed } from "./fx.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 4, statementTimeoutMs: Math.max(settings.db_statement_timeout_ms, 120_000) });
const fx = junctionFeed(new JunctionClient(settings.junction_url, settings.junction_api_key, settings.junction_timeout_s * 1000));
const port = Number(process.env.PORT ?? 8300);
const server = createDepotApp(settings, makeDb(pool), fx).listen(port, "0.0.0.0", () => log.info({ port }, "depot listening"));
const shutdown = () => server.close(() => void pool.end());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
