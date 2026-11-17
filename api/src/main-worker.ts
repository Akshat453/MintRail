/** Payments worker: ``node api/dist/main-worker.js`` (queue ``payments``). */
import { configureLogging, getSettings, makeDb, makePool, Worker } from "@mintrail/shared";

import { JunctionClient } from "./junction-client.js";
import { QUEUE } from "./services/payments.js";
import { buildRegistry } from "./worker.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 2, statementTimeoutMs: settings.db_statement_timeout_ms });
const junction = new JunctionClient(settings.junction_url, settings.junction_api_key, settings.junction_timeout_s * 1000);
await new Worker(makeDb(pool), buildRegistry(settings, junction), {
  queues: [QUEUE],
  batchSize: settings.worker_batch_size,
  pollIntervalS: Math.min(settings.worker_poll_interval_s, 0.25),
  visibilityTimeoutS: settings.worker_visibility_timeout_s,
}).runForever();
await pool.end();
