/** Depot worker: ``node depot/dist/main-worker.js`` — queue ``depot`` + the daily scheduler. */
import { DEPOT_QUEUE, JunctionClient } from "@mintrail/api";
import { configureLogging, getSettings, log, makeDb, makePool, Worker } from "@mintrail/shared";

import { junctionFeed } from "./fx.js";
import { buildRegistry, scheduleDaily } from "./worker.js";

const settings = getSettings();
configureLogging(settings.log_level, settings.log_json);
const pool = makePool(settings.database_url, { max: 4, statementTimeoutMs: Math.max(settings.db_statement_timeout_ms, 120_000) });
const db = makeDb(pool);
const fx = junctionFeed(new JunctionClient(settings.junction_url, settings.junction_api_key, settings.junction_timeout_s * 1000));
const worker = new Worker(db, buildRegistry(db, settings, fx), {
  queues: [DEPOT_QUEUE],
  batchSize: 1,
  pollIntervalS: Math.min(settings.worker_poll_interval_s, 1),
  visibilityTimeoutS: Math.max(settings.worker_visibility_timeout_s, 1800),
});
const tick = () => scheduleDaily(db).catch((e: Error) => log.error({ err: e.message }, "depot scheduler tick failed"));
const timer = settings.depot_scheduler_enabled ? setInterval(tick, settings.depot_tick_s * 1000) : undefined;
if (settings.depot_scheduler_enabled) void tick();
else log.warn("depot scheduler disabled (MINTRAIL_DEPOT_SCHEDULER_ENABLED=false): runs only when requested");
await worker.runForever();
clearInterval(timer);
await pool.end();
