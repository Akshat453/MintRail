/** Station lifecycle: onboarding, KYC, settings, API keys and merchant authentication (ported from M1). */
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";

import {
  AuthenticationError,
  type Clock,
  ConflictError,
  type Currency,
  DecryptionError,
  ErrorCode,
  IdPrefix,
  InvalidRequestError,
  isValidId,
  log,
  newId,
  NotFoundError,
  PermissionDeniedError,
  pyRepr,
  type SecretBox,
  SignatureError,
  signatures,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import { ensureStationAccounts, ensureSystemAccounts, LedgerService } from "@mintrail/ledger";

import { type GeneratedKey, generateKey, hashSecret, modeOf } from "../keys.js";
import { type ApiKey, apiKeys, type KeyMode, type KycStatus, liveEnabled, type Station, stations } from "../schema/index.js";
import { allows, normaliseScopes, type Scope } from "../scopes.js";
import { canonicalRequest } from "../signing.js";
import { urlparse } from "../urlparse.js";

export const LAST_USED_RESOLUTION_MS = 60_000;
export const MAX_ACTIVE_KEYS_PER_MODE = 5;
export const SETTABLE_BY_MERCHANT = new Set(["webhook_url", "auto_capture"]);
export const SETTABLE_BY_STAFF = new Set([
  ...SETTABLE_BY_MERCHANT,
  "settlement_schedule",
  "fee_plan",
  "max_payment_amount",
  "rate_limit_per_sec",
  "rate_limit_burst",
]);

const COLUMN: Record<string, keyof Station> = {
  webhook_url: "webhookUrl",
  auto_capture: "autoCapture",
  settlement_schedule: "settlementSchedule",
  fee_plan: "feePlan",
  max_payment_amount: "maxPaymentAmount",
  rate_limit_per_sec: "rateLimitPerSec",
  rate_limit_burst: "rateLimitBurst",
};

export interface NewStation {
  legalName: string;
  displayName: string;
  email: string;
  businessCategory: string;
  defaultCurrency: Currency;
  country?: string;
  settings?: Record<string, unknown>;
}

/** Who a request acts for: a Station in one mode. API keys and dashboard sessions both provide one. */
export interface Principal {
  readonly station: Station;
  readonly livemode: boolean;
}

export class AuthContext implements Principal {
  constructor(
    readonly station: Station,
    readonly apiKey: ApiKey,
    readonly signed = false,
  ) {}
  get mode(): KeyMode {
    return this.apiKey.mode as KeyMode;
  }
  get livemode(): boolean {
    return this.mode === "live";
  }
  hasScope(scope: Scope): boolean {
    return allows(this.apiKey.scopes, scope);
  }
}

export function validateWebhookUrl(url: string | null | undefined, environmentAllowsHttp: boolean): string | null {
  if (url === null || url === undefined || url === "") return null;
  const parsed = urlparse(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.scheme !== "https" && !(parsed.scheme === "http" && local)) {
    throw new InvalidRequestError("webhook_url must be an https:// URL", { param: "webhook_url" });
  }
  if (local && !environmentAllowsHttp) throw new InvalidRequestError("webhook_url cannot point at localhost", { param: "webhook_url" });
  if (!parsed.hostname) throw new InvalidRequestError("webhook_url has no host", { param: "webhook_url" });
  return url;
}

const duplicateEmail = (): ConflictError =>
  new ConflictError("a station with this email already exists", { code: ErrorCode.STATION_ALREADY_EXISTS, param: "email" });

const isUniqueViolation = (e: unknown): boolean =>
  (e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

export class StationService {
  private readonly ledger: LedgerService;

  constructor(
    readonly tx: Tx,
    private readonly opts: { pepper: string; secretBox: SecretBox; clock?: Clock; allowLocalWebhooks?: boolean },
  ) {
    this.ledger = new LedgerService(tx, opts.clock ?? systemClock);
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  // ------------------------------------------------------------ onboarding
  /** Create a Station (KYC pending, test mode only) with ledger accounts and a test key. */
  async createStation(data: NewStation): Promise<[Station, ApiKey, GeneratedKey]> {
    const email = data.email.trim();
    if ((await this.findByEmail(email)) !== null) throw duplicateEmail();
    const values: Record<string, unknown> = {
      id: newId(IdPrefix.STATION),
      legalName: data.legalName.trim(),
      displayName: data.displayName.trim(),
      email,
      businessCategory: data.businessCategory,
      country: data.country ?? "IN",
      defaultCurrency: data.defaultCurrency,
      status: "active",
      kycStatus: "pending",
      settlementSchedule: "T+2",
      feePlan: "standard",
      autoCapture: true,
      rateLimitPerSec: 25,
      rateLimitBurst: 50,
    };
    this.applySettings(values, data.settings ?? {}, SETTABLE_BY_STAFF);
    let station: Station;
    try {
      station = await this.tx.transaction(
        async (sp) =>
          (
            await sp
              .insert(stations)
              .values(values as typeof stations.$inferInsert)
              .returning()
          )[0]!,
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateEmail();
      throw e;
    }
    await this.provisionLedger(station, false);
    const [row, key] = await this.issue(station, "test", null, "Default test key");
    log.info({ station_id: station.id }, "station created");
    return [station, row, key];
  }

  private async provisionLedger(station: Station, livemode: boolean): Promise<void> {
    const currency = station.defaultCurrency as Currency;
    await ensureSystemAccounts(this.ledger, currency, livemode);
    await ensureStationAccounts(this.ledger, station.id, currency, livemode);
  }

  // ------------------------------------------------------------ KYC
  async kycVerify(stationId: string, reviewerId: string): Promise<Station> {
    const station = await this.kycTransition(stationId, ["pending"], "verified");
    const updated = await this.save(station.id, {
      kycStatus: "verified",
      kycRejectionReason: null,
      kycReviewedBy: reviewerId,
      kycReviewedAt: this.clock.now().toISOString(),
    });
    await this.provisionLedger(updated, true);
    return updated;
  }

  async kycReject(stationId: string, reviewerId: string, reason: string): Promise<Station> {
    const station = await this.kycTransition(stationId, ["pending"], "rejected");
    return this.save(station.id, {
      kycStatus: "rejected",
      kycRejectionReason: reason,
      kycReviewedBy: reviewerId,
      kycReviewedAt: this.clock.now().toISOString(),
    });
  }

  async kycReopen(stationId: string): Promise<Station> {
    const station = await this.kycTransition(stationId, ["rejected"], "pending");
    return this.save(station.id, { kycStatus: "pending" });
  }

  private async kycTransition(stationId: string, from: KycStatus[], to: KycStatus): Promise<Station> {
    const station = await this.get(stationId);
    if (!from.includes(station.kycStatus as KycStatus)) {
      throw new ConflictError(`cannot move KYC from ${station.kycStatus} to ${to}`, { code: ErrorCode.INVALID_KYC_TRANSITION });
    }
    return station;
  }

  private async save(id: string, values: Partial<typeof stations.$inferInsert>): Promise<Station> {
    const [row] = await this.tx
      .update(stations)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(stations.id, id))
      .returning();
    return row!;
  }

  // ------------------------------------------------------------ settings & status
  async updateSettings(stationId: string, changes: Record<string, unknown>, byStaff: boolean): Promise<[Station, Record<string, unknown>]> {
    const station = await this.get(stationId);
    const allowed = byStaff ? SETTABLE_BY_STAFF : SETTABLE_BY_MERCHANT;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(changes)) {
      if (allowed.has(k)) before[k] = station[COLUMN[k]!];
    }
    const values: Record<string, unknown> = {};
    this.applySettings(values, changes, allowed);
    return [await this.save(station.id, values as Partial<typeof stations.$inferInsert>), before];
  }

  private applySettings(target: Record<string, unknown>, changes: Record<string, unknown>, allowed: Set<string>): void {
    for (const [key, raw] of Object.entries(changes)) {
      let value = raw;
      if (!allowed.has(key)) throw new PermissionDeniedError(`setting ${pyRepr(key)} cannot be changed here`, { param: key });
      switch (key) {
        case "webhook_url":
          value = validateWebhookUrl(value as string | null, this.opts.allowLocalWebhooks ?? true);
          break;
        case "max_payment_amount":
          if (value !== null && (value as bigint) <= 0n) throw new InvalidRequestError("must be positive", { param: key });
          break;
        case "rate_limit_per_sec":
        case "rate_limit_burst": {
          // M1 parity: an explicit null reached int(None) → 500.
          if (value === null) throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not 'NoneType'`);
          const n = Number(value);
          if (!(n >= 1 && n <= 10_000)) throw new InvalidRequestError("must be within 1..10000", { param: key });
          value = n;
          break;
        }
        case "settlement_schedule":
        case "fee_plan":
        case "auto_capture":
          // M1 parity: None is not a valid enum / NOT NULL value → 500.
          if (value === null) throw new TypeError(`${key} may not be None`);
          break;
      }
      target[COLUMN[key]!] = value;
    }
  }

  async suspend(stationId: string, reason: string): Promise<Station> {
    const s = await this.get(stationId);
    return this.save(s.id, { status: "suspended", suspendedReason: reason });
  }

  async reactivate(stationId: string): Promise<Station> {
    const s = await this.get(stationId);
    return this.save(s.id, { status: "active", suspendedReason: null });
  }

  // ------------------------------------------------------------ reads
  async get(stationId: string): Promise<Station> {
    const [s] = await this.tx.select().from(stations).where(eq(stations.id, stationId));
    if (!s) throw new NotFoundError(`station ${stationId} not found`, { code: ErrorCode.STATION_NOT_FOUND });
    return s;
  }

  /** Newest first, cursor-paginated by ID (IDs are time-sortable). */
  async listStations(opts: {
    limit: number;
    startingAfter?: string | null;
    kycStatus?: KycStatus | null;
    query?: string | null;
  }): Promise<[Station[], boolean]> {
    const where = [];
    if (opts.startingAfter) where.push(lt(stations.id, opts.startingAfter));
    if (opts.kycStatus) where.push(eq(stations.kycStatus, opts.kycStatus));
    if (opts.query) {
      const like = `%${opts.query.toLowerCase()}%`;
      where.push(
        or(
          sql`lower(${stations.displayName}) LIKE ${like}`,
          sql`lower(${stations.legalName}) LIKE ${like}`,
          sql`lower(${stations.email}) LIKE ${like}`,
          eq(stations.id, opts.query),
        )!,
      );
    }
    const rows = await this.tx
      .select()
      .from(stations)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(stations.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  private async findByEmail(email: string): Promise<Station | null> {
    const [s] = await this.tx
      .select()
      .from(stations)
      .where(sql`lower(${stations.email}) = ${email.toLowerCase()}`);
    return s ?? null;
  }

  // ------------------------------------------------------------ API keys
  async issueKey(stationId: string, mode: KeyMode, scopes: string[] | null, label: string | null): Promise<[ApiKey, GeneratedKey]> {
    const station = await this.get(stationId);
    if (mode === "live" && !liveEnabled(station)) {
      throw new PermissionDeniedError("live keys require verified KYC", { code: ErrorCode.KYC_NOT_VERIFIED, param: "mode" });
    }
    const [row] = await this.tx
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.stationId, station.id), eq(apiKeys.mode, mode), eq(apiKeys.status, "active")));
    if ((row?.n ?? 0) >= MAX_ACTIVE_KEYS_PER_MODE) {
      throw new ConflictError(`at most ${MAX_ACTIVE_KEYS_PER_MODE} active ${mode} keys are allowed; revoke one first`);
    }
    return this.issue(station, mode, scopes, label);
  }

  private async issue(station: Station, mode: KeyMode, scopes: string[] | null, label: string | null): Promise<[ApiKey, GeneratedKey]> {
    const generated = generateKey(mode, this.opts.pepper);
    const id = newId(IdPrefix.API_KEY);
    const [row] = await this.tx
      .insert(apiKeys)
      .values({
        id,
        stationId: station.id,
        mode,
        label,
        scopes: normaliseScopes(scopes),
        secretHash: generated.secretHash,
        signingKeyEnc: this.opts.secretBox.encrypt(generated.signingKey, Buffer.from(id)),
        hint: generated.hint,
        status: "active",
      })
      .returning();
    return [row!, generated];
  }

  async listKeys(stationId: string): Promise<ApiKey[]> {
    await this.get(stationId);
    return this.tx.select().from(apiKeys).where(eq(apiKeys.stationId, stationId)).orderBy(apiKeys.id);
  }

  async revokeKey(keyId: string): Promise<ApiKey> {
    const [key] = await this.tx.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    if (!key) throw new NotFoundError(`api key ${keyId} not found`);
    if (key.status === "revoked") return key;
    const [row] = await this.tx
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: this.clock.now().toISOString() })
      .where(eq(apiKeys.id, keyId))
      .returning();
    return row!;
  }

  // ------------------------------------------------------------ auth
  async authenticateBearer(presented: string): Promise<AuthContext> {
    const mode = modeOf(presented);
    if (mode === null) {
      throw new AuthenticationError("API key is malformed; expected mr_test_… or mr_live_…", { code: ErrorCode.INVALID_API_KEY });
    }
    if (mode === "live") {
      throw new AuthenticationError("live-mode requests must be signed (MintRail-Key-Id + MintRail-Signature)", {
        code: ErrorCode.SIGNATURE_REQUIRED,
      });
    }
    const [key] = await this.tx
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.secretHash, hashSecret(presented, this.opts.pepper)));
    return this.finish(key ?? null, false);
  }

  async authenticateSigned(
    keyId: string,
    signatureHeader: string,
    req: { method: string; path: string; query: string; body: Buffer; now: number; toleranceS: number },
  ): Promise<AuthContext> {
    const unknown = () => new AuthenticationError("unknown API key id", { code: ErrorCode.INVALID_API_KEY });
    if (!isValidId(keyId, IdPrefix.API_KEY)) throw unknown();
    const [key] = await this.tx.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    if (!key || key.signingKeyEnc === null) throw unknown();
    let signingKey: Buffer;
    try {
      signingKey = this.opts.secretBox.decrypt(key.signingKeyEnc, Buffer.from(key.id));
    } catch (e) {
      if (!(e instanceof DecryptionError)) throw e;
      log.error({ key_id: key.id }, "DERAILMENT: api key signing secret failed to decrypt");
      throw unknown();
    }
    try {
      signatures.verify(signingKey, signatureHeader, canonicalRequest(req.method, req.path, req.query, req.body), {
        now: req.now,
        toleranceS: req.toleranceS,
      });
    } catch (e) {
      if (!(e instanceof SignatureError)) throw e;
      throw new AuthenticationError(`request signature rejected: ${e.reason}`, {
        code: e.expired ? ErrorCode.REQUEST_EXPIRED : ErrorCode.INVALID_SIGNATURE,
      });
    }
    return this.finish(key, true);
  }

  private async finish(key: ApiKey | null, signed: boolean): Promise<AuthContext> {
    if (key === null) throw new AuthenticationError("invalid API key", { code: ErrorCode.INVALID_API_KEY });
    if (key.status === "revoked") throw new AuthenticationError("this API key has been revoked", { code: ErrorCode.API_KEY_REVOKED });
    const station = await this.get(key.stationId);
    if (station.status === "suspended") {
      throw new PermissionDeniedError("this station is suspended; contact MintRail support", { code: ErrorCode.STATION_SUSPENDED });
    }
    if (key.mode === "live" && !liveEnabled(station)) {
      throw new PermissionDeniedError("live mode requires verified KYC", { code: ErrorCode.KYC_NOT_VERIFIED });
    }
    const touched = await this.touch(key);
    return new AuthContext(station, touched, signed);
  }

  private async touch(key: ApiKey): Promise<ApiKey> {
    const now = this.clock.now();
    if (
      key.lastUsedAt !== null &&
      now.getTime() - Date.parse(key.lastUsedAt.replace(" ", "T").replace(/\+00$/, "Z")) < LAST_USED_RESOLUTION_MS
    ) {
      return key;
    }
    await this.tx.update(apiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(apiKeys.id, key.id));
    return { ...key, lastUsedAt: now.toISOString() };
  }
}
