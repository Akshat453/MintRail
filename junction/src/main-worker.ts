/** Junction worker: ``node junction/dist/main-worker.js`` (queue ``junction``). */
import { configureLogging, getSettings, makeDb, makePool, Worker } from "@mintrail/shared";

import { QUEUE } from "./bank.js";
import { buildRegistry } from "./worker.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 2, statementTimeoutMs: settings.db_statement_timeout_ms });
const fetchWithTimeout: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
await new Worker(makeDb(pool), buildRegistry(settings, fetchWithTimeout), {
  queues: [QUEUE],
  batchSize: settings.worker_batch_size,
  pollIntervalS: Math.min(settings.worker_poll_interval_s, 0.25),
  visibilityTimeoutS: settings.worker_visibility_timeout_s,
}).runForever();
await pool.end();
