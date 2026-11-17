/** Ledger worker process: ``node ledger/dist/main.js`` (queue ``ledger``). */
import { configureLogging, getSettings, makeDb, makePool, Worker } from "@mintrail/shared";

import { registry } from "./jobs.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 2, statementTimeoutMs: settings.db_statement_timeout_ms });
await new Worker(makeDb(pool), registry, {
  queues: ["ledger"],
  batchSize: settings.worker_batch_size,
  pollIntervalS: settings.worker_poll_interval_s,
  visibilityTimeoutS: settings.worker_visibility_timeout_s,
}).runForever();
await pool.end();
