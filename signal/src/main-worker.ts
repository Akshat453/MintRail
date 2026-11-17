/** Signal delivery worker: ``node signal/dist/main-worker.js``. */
import { configureLogging, getSettings, makeDb, makePool } from "@mintrail/shared";

import { SignalEngine } from "./delivery.js";
import { signalOptions } from "./options.js";
import { SignalWorker } from "./worker.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, {
  max: settings.signal_concurrency + 2,
  statementTimeoutMs: settings.db_statement_timeout_ms,
});
const engine = new SignalEngine(makeDb(pool), signalOptions(settings));
const worker = new SignalWorker(engine, pool, settings.signal_poll_interval_s);
process.once("SIGTERM", () => worker.stop());
process.once("SIGINT", () => worker.stop());
await worker.runForever();
await engine.close();
await pool.end();
