/**
 * Seed a realistic MintRail: 50 merchants, ~200k payments over 90 days, refunds,
 * chargebacks, Freight payouts, daily settlements (the real Depot engine),
 * webhook delivery history, Railyard staff personas and a reconciliation report.
 *
 *   make seed                 # idempotent: skips if already seeded
 *   make seed ARGS=--reset    # wipe all MintRail data first, then seed
 *   make fresh                # wipe all MintRail data, keep only the bootstrap Railyard admin
 *   pnpm seed --payments 20000 --days 30   (smaller, for quick local runs)
 *
 * Deterministic: a fixed PRNG seed drives every business value and every id the
 * simulation creates (``MINTRAIL_SEED`` overrides it). API key and webhook secrets
 * are always fresh CSPRNG values — they are written to .mintrail/demo-keys.json
 * (git-ignored), never printed in full.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";

import {
  AuditService,
  DashboardAuthService,
  DerailmentService,
  eventOutboxObject,
  StaffService,
  StaffContext,
  StationService,
  stations,
  updatePolicy,
  type StaffRole,
} from "./seed/api-imports.js";
import { reconcile } from "@mintrail/depot";
import { simulatedUsdInr } from "@mintrail/junction";
import { addDays, getSettings, IdPrefix, istDate, istStartOf, makeDb, makePool, newId, SecretBox, setIdSource } from "@mintrail/shared";
import { EndpointService, signalOptions } from "@mintrail/signal";

import { BufferedLedger, bulkInsert } from "./seed/bulk.js";
import { CATEGORIES, MERCHANTS } from "./seed/catalog.js";
import { Rng } from "./seed/rng.js";
import { type SimMerchant, World } from "./seed/world.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const EMPTY = args.includes("--empty");
const RESET = EMPTY || args.includes("--reset");
const anchorArg = args.indexOf("--anchor");
const PAYMENTS = flag("payments", 200_000);
const DAYS = flag("days", 90);
const SEED = Number(process.env.MINTRAIL_SEED ?? 20_221_117);
const DEMO_PASSWORD = "mintrail-demo-password"; // local demo only
const KEYS_FILE = fileURLToPath(new URL("../.mintrail/demo-keys.json", import.meta.url));

const STAFF: [string, string, StaffRole, string][] = [
  ["riya@mintrail.example", "Riya Menon", "ops", "payments engineer"],
  ["arjun@mintrail.example", "Arjun Rao", "finance", "ledger lead"],
  ["meera@mintrail.example", "Meera Iyer", "security", "security"],
  ["kabir@mintrail.example", "Kabir Shah", "ops", "intern"],
  ["dev@mintrail.example", "Dev Malhotra", "ops", "contractor"],
];

const t0 = performance.now();
const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
const settings = getSettings();
const pool = makePool(settings.database_url, { max: 10, statementTimeoutMs: 600_000 });
// Seed-only: don't wait for WAL flush on each of the ~12k commits (a crash just means re-seeding).
pool.on("connect", (c) => void c.query("SET synchronous_commit TO off"));
const db = makeDb(pool);
const client = await pool.connect();

try {
  const firstMerchantEmail = `finance@${MERCHANTS[0]![2]}.example`;
  const already = await db
    .select({ id: stations.id })
    .from(stations)
    .where(sql`lower(${stations.email}) = ${firstMerchantEmail}`);
  if (already.length && !RESET) {
    console.log("Seed data already present (use `make seed ARGS=--reset` to rebuild). Logins:");
    printLogins();
    process.exit(0);
  }
  if (RESET) {
    const tables = (await client.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'")).rows.map(
      (r) => r.t,
    );
    await client.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    console.log(`reset: truncated ${tables.length} tables`);
  }
  if (EMPTY) {
    // Start-from-scratch mode: no merchants, no demo logins. Sign up at the dashboard's /signup.
    rmSync(KEYS_FILE, { force: true });
    if (settings.bootstrap_admin_email && settings.bootstrap_admin_password) {
      await db.transaction((tx) =>
        new StaffService(tx, settings).ensureBootstrapAdmin(settings.bootstrap_admin_email!, settings.bootstrap_admin_password!),
      );
      console.log(`empty: Railyard admin ${settings.bootstrap_admin_email} (password from MINTRAIL_BOOTSTRAP_ADMIN_PASSWORD in .env)`);
    }
    console.log("empty: no merchants. Create one at http://localhost:13000/signup");
    process.exit(0);
  }

  const rng = new Rng(SEED);
  // The simulation covers the DAYS full IST days before the anchor (default: today), so two runs
  // with the same seed and anchor produce identical data.
  const anchor = anchorArg >= 0 ? args[anchorArg + 1]! : istDate(new Date());
  const firstDay = addDays(anchor, -DAYS);
  let simNow = istStartOf(addDays(firstDay, -30)).getTime();
  setIdSource({ nowMs: () => BigInt(simNow), random80: () => rng.bits80() });

  // ---------------------------------------------------------------- staff personas
  const staffIds: Record<string, string> = {};
  await db.transaction(async (tx) => {
    const svc = new StaffService(tx, settings);
    if (settings.bootstrap_admin_email && settings.bootstrap_admin_password) {
      await svc.ensureBootstrapAdmin(settings.bootstrap_admin_email, settings.bootstrap_admin_password);
    }
    for (const [email, name, role] of STAFF) {
      const u = (await svc.findByEmail(email)) ?? (await svc.createStaff({ email, fullName: name, role, password: DEMO_PASSWORD }));
      staffIds[email] = u.id;
    }
  });
  const riya = staffIds["riya@mintrail.example"]!;
  const arjun = staffIds["arjun@mintrail.example"]!;
  console.log(`staff     ${STAFF.length} personas (${elapsed()})`);

  // ---------------------------------------------------------------- merchants
  const secretBox = new SecretBox(settings.secrets_key);
  const keys: Record<string, unknown> = {};
  const merchants: SimMerchant[] = [];
  const endpointsFor: { stationId: string; livemode: boolean; endpointId: string }[] = [];
  await db.transaction(async (tx) => {
    const stationsSvc = new StationService(tx, { pepper: settings.api_key_pepper, secretBox });
    const dash = new DashboardAuthService(tx, settings);
    const audit = new AuditService(tx, "10.20.0.15");
    const riyaCtx = new StaffContext((await new StaffService(tx, settings).get(riya))!, "seed");
    const o = signalOptions(settings);
    const endpoints = new EndpointService(tx, { secretBox: o.secretBox, allowLocal: true, graceS: o.graceS, maxAttempts: o.maxAttempts });
    for (const [i, [legal, display, slug, catKey, plan, verified]] of MERCHANTS.entries()) {
      simNow = istStartOf(addDays(firstDay, -rng.int(30, 600))).getTime() + rng.int(0, 20) * 3_600_000;
      const cat = CATEGORIES.find((c) => c.key === catKey)!;
      const schedule = plan === "enterprise" ? "T+1" : cat.reserve[0] > 0 ? "T+3" : plan === "growth" ? "T+1" : "T+2";
      let [station] = await stationsSvc.createStation({
        legalName: legal,
        displayName: display,
        email: `finance@${slug}.example`,
        businessCategory: cat.mcc,
        defaultCurrency: "INR",
        settings: { fee_plan: plan, settlement_schedule: schedule, webhook_url: null },
      });
      await tx
        .update(stations)
        .set({ createdAt: new Date(simNow).toISOString() })
        .where(eq(stations.id, station.id));
      if (verified) {
        station = await stationsSvc.kycVerify(station.id, riya);
        await audit.record(riyaCtx, "station.kyc_verify", { targetType: "station", targetId: station.id });
      }
      const [testKey, testSecret] = await stationsSvc.issueKey(station.id, "test", null, "seed");
      const live = verified ? await stationsSvc.issueKey(station.id, "live", null, "seed") : null;
      const owner = `owner@${slug}.example`;
      await dash.createUser({ stationId: station.id, email: owner, fullName: `${display} Owner`, role: "owner", password: DEMO_PASSWORD });
      if (i % 4 === 0)
        await dash.createUser({
          stationId: station.id,
          email: `dev@${slug}.example`,
          fullName: `${display} Developer`,
          role: "developer",
          password: DEMO_PASSWORD,
        });
      const threshold = BigInt(rng.pick([1_00_000, 2_00_000, 5_00_000])) * 100n;
      await updatePolicy(tx, settings, station.id, {
        reserveBps: cat.reserve[0],
        reserveHoldDays: cat.reserve[1],
        payoutApprovalThreshold: threshold,
        payoutDailyLimit: 50_00_000_00n,
      });
      if (rng.chance(0.7)) {
        const [ep] = await endpoints.create(
          { stationId: station.id, livemode: verified },
          { url: `https://hooks.${slug}.example/mintrail/webhooks`, description: "Order service", enabled_events: ["*"] },
        );
        endpointsFor.push({ stationId: station.id, livemode: verified, endpointId: ep.id });
      }
      merchants.push({
        station,
        cat,
        livemode: verified,
        weight: (verified ? 1 : 0.25) * Math.pow(1 / (1 + (i % 17)), 0.75) * (plan === "enterprise" ? 2.2 : plan === "growth" ? 1.4 : 1),
        freight: rng.chance(0.6),
        approvalThreshold: threshold,
      });
      keys[display] = {
        station_id: station.id,
        dashboard_login: owner,
        test_key_id: testKey.id,
        test_api_key: testSecret.secret,
        ...(live ? { live_key_id: live[0].id, live_api_key: live[1].secret } : {}),
      };
    }
  });
  console.log(`merchants ${merchants.length} (${merchants.filter((m) => m.livemode).length} live) (${elapsed()})`);

  // ---------------------------------------------------------------- 90 days of business
  const ledger = new BufferedLedger(db);
  await ledger.refresh(client);
  const fx = { rate: async (_b: string, _q: string, date: string) => ({ rate: simulatedUsdInr(date), source: "junction-fx-sim" }) };
  const world = new World(rng, db, client, ledger, settings, merchants, fx, { arjun }, istStartOf(anchor).getTime());
  simNow = istStartOf(firstDay).getTime();
  const origNow = () => BigInt(Math.max(simNow, world.now.getTime()));
  setIdSource({ nowMs: origNow, random80: () => rng.bits80() });
  await world.simulate(firstDay, DAYS, PAYMENTS, (d) => {
    if ((d + 1) % 15 === 0 || d === DAYS - 1) {
      console.log(
        `day ${String(d + 1).padStart(2)}/${DAYS}  payments ${world.stats.payments}  settlements ${world.stats.settlements}  (${elapsed()})`,
      );
      if (process.env.SEED_PROFILE)
        console.log(Object.fromEntries(Object.entries(world.profile).map(([k, v]) => [k, `${(v / 1000).toFixed(1)}s`])));
    }
  });

  // ---------------------------------------------------------------- webhook delivery history (last 14 days)
  await webhookHistory(endpointsFor, rng, anchor);
  console.log(`webhooks  delivery history written (${elapsed()})`);

  // ---------------------------------------------------------------- Railyard extras
  await db.transaction(async (tx) => {
    const d = new DerailmentService(tx);
    const incidents: [string, "sev1" | "sev2" | "sev3", string, string[], string, string[]][] = [
      [
        "UPI success rate dip on one PSP",
        "sev2",
        "UPI collect requests timing out for one PSP handle",
        ["junction", "upi"],
        riya,
        ["PSP confirmed degraded switch", "Routed collect retries; success rate back to 93%"],
      ],
      [
        "Settlement run delayed",
        "sev3",
        "Depot run finished 40 minutes late after a slow reconciliation query",
        ["depot"],
        arjun,
        ["Added index on settlement_entries(kind, reference_id)", "Run time back under 5 minutes"],
      ],
      [
        "Webhook backlog for one merchant",
        "sev3",
        "A merchant endpoint returned 503 for 2 hours; deliveries retried with backoff",
        ["signal"],
        staffIds["meera@mintrail.example"]!,
        ["Endpoint recovered; backlog drained"],
      ],
    ];
    for (const [title, sev, summary, affected, commander, notes] of incidents) {
      const inc = await d.create(commander, { title, severity: sev, summary, affected });
      await d.addNote(commander, inc.id, notes[0]!, "mitigated");
      await d.addNote(commander, inc.id, notes[notes.length - 1]!, "resolved");
    }
    await d.create(riya, {
      title: "Card authorisation latency above SLO",
      severity: "sev3",
      summary: "p95 card authorisation latency at 3.4s since 09:40 IST",
      affected: ["junction", "cards"],
    });
  });

  // ---------------------------------------------------------------- outbox hygiene + reconciliation
  await client.query("UPDATE outbox_events SET dispatched_at = created_at WHERE dispatched_at IS NULL");
  await client.query("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE queue = 'depot' AND status = 'queued'");
  const [report, mismatches] = await db.transaction((tx) => reconcile(tx));
  console.log(
    `reconcile ${report.status}: ${report.stationsChecked} stations, ${report.settlementsChecked} settlements, ${mismatches.length} mismatches (${elapsed()})`,
  );
  if (mismatches.length) console.log(mismatches.slice(0, 10));

  mkdirSync(fileURLToPath(new URL("../.mintrail", import.meta.url)), { recursive: true });
  writeFileSync(
    KEYS_FILE,
    JSON.stringify(
      { password: DEMO_PASSWORD, staff: STAFF.map(([email, name, role, persona]) => ({ email, name, role, persona })), merchants: keys },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  chmodSync(KEYS_FILE, 0o600);
  const s = world.stats;
  console.log(
    `\nSeeded ${s.payments} payments (${s.captured} captured, ${((s.captured / s.payments) * 100).toFixed(1)}%), ${s.refunds} refunds, ${s.disputes} disputes, ${s.payouts} payouts, ${s.settlements} settlements in ${elapsed()}.`,
  );
  console.log(`Keys and logins: ${KEYS_FILE}`);
  printLogins();
  if (mismatches.length) process.exitCode = 1;
} finally {
  setIdSource(null);
  client.release();
  await pool.end();
}

function printLogins(): void {
  console.log(`  Railyard  riya@ / arjun@ / meera@ / kabir@ / dev@mintrail.example   password: ${DEMO_PASSWORD}`);
  console.log(`  Dashboard owner@${MERCHANTS[0]![2]}.example (any merchant: owner@<slug>.example)   password: ${DEMO_PASSWORD}`);
}

/** Recent events → outbox (dispatched) + deliveries + attempt logs for merchants with endpoints. */
async function webhookHistory(
  endpointsFor: { stationId: string; livemode: boolean; endpointId: string }[],
  rng: Rng,
  anchor: string,
): Promise<void> {
  const since = new Date(istStartOf(anchor).getTime() - 14 * 86_400_000).toISOString();
  const events: unknown[][] = [];
  const deliveries: unknown[][] = [];
  const attempts: unknown[][] = [];
  for (const ep of endpointsFor) {
    const objs = await eventOutboxObject(db, ep.stationId, ep.livemode, since);
    for (const { type, at, object } of objs) {
      const evtId = newId(IdPrefix.EVENT, BigInt(new Date(at).getTime()));
      events.push([evtId, ep.stationId, ep.livemode, type, { object }, at, at]);
      const fails = rng.chance(0.012);
      const tries = fails ? settings.signal_max_attempts : rng.chance(0.03) ? rng.int(2, 4) : 1;
      const dId = newId(IdPrefix.WEBHOOK_DELIVERY, BigInt(new Date(at).getTime() + 300));
      let t = new Date(at).getTime() + 400;
      for (let a = 1; a <= tries; a++) {
        const last = a === tries;
        const ok = last && !fails;
        attempts.push([
          dId,
          a,
          ok ? 200 : rng.pick([500, 502, 503, 504]),
          ok ? null : "endpoint answered 503",
          rng.int(40, 900),
          ok ? '{"received":true}' : "Service Unavailable",
          new Date(t),
        ]);
        t += Math.min(21_600_000, 30_000 * 2 ** (a - 1));
      }
      deliveries.push([
        dId,
        evtId,
        ep.endpointId,
        ep.stationId,
        ep.livemode,
        type,
        fails ? "failed" : "succeeded",
        tries,
        settings.signal_max_attempts,
        fails ? 503 : 200,
        fails ? "endpoint answered 503" : null,
        new Date(t),
        at,
        new Date(t),
      ]);
    }
  }
  await bulkInsert(
    client,
    "outbox_events",
    [
      ["id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["type", "text"],
      ["data", "jsonb"],
      ["dispatched_at", "timestamptz"],
      ["created_at", "timestamptz"],
    ],
    events,
    5_000,
  );
  await bulkInsert(
    client,
    "webhook_deliveries",
    [
      ["id", "text"],
      ["event_id", "text"],
      ["endpoint_id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["event_type", "text"],
      ["status", "text"],
      ["attempts", "int"],
      ["max_attempts", "int"],
      ["last_status_code", "int"],
      ["last_error", "text"],
      ["completed_at", "timestamptz"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
    deliveries,
    5_000,
  );
  await bulkInsert(
    client,
    "webhook_delivery_attempts",
    [
      ["delivery_id", "text"],
      ["attempt", "int"],
      ["status_code", "int"],
      ["error", "text"],
      ["duration_ms", "int"],
      ["response_excerpt", "text"],
      ["attempted_at", "timestamptz"],
    ],
    attempts,
    10_000,
  );
}
