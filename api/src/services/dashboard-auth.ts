/**
 * Merchant dashboard users and sessions (ADR-0018). Same hardening as Railyard
 * staff auth: scrypt passwords, peppered session-token hashes, lockout after
 * repeated failures, constant-ish timing for unknown emails.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  AuthenticationError,
  type Clock,
  ConflictError,
  ErrorCode,
  hashPassword,
  hmacSha256Hex,
  IdPrefix,
  InvalidRequestError,
  newId,
  NotFoundError,
  PermissionDeniedError,
  randomToken,
  type Settings,
  systemClock,
  type Tx,
  verifyPassword,
} from "@mintrail/shared";

import { type DashboardRole, type DashboardUser, dashboardSessions, dashboardUsers, type Station, stations } from "../schema/index.js";
import type { Principal } from "./stations.js";

export const DASHBOARD_TOKEN_PREFIX = "dss_";
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const parseTs = (v: string): number => Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

/** What each dashboard role may do. */
export const DASHBOARD_PERMISSIONS = {
  owner: ["read", "refunds", "disputes", "payouts", "webhooks", "api_keys", "reports"],
  admin: ["read", "refunds", "disputes", "payouts", "webhooks", "api_keys", "reports"],
  developer: ["read", "webhooks", "api_keys"],
  viewer: ["read", "reports"],
} as const satisfies Record<DashboardRole, readonly string[]>;
export type DashboardPermission = (typeof DASHBOARD_PERMISSIONS)[DashboardRole][number];

export class DashboardContext implements Principal {
  constructor(
    readonly user: DashboardUser,
    readonly station: Station,
    readonly sessionId: string,
    readonly livemode: boolean,
  ) {}
  can(p: DashboardPermission): boolean {
    return (DASHBOARD_PERMISSIONS[this.user.role as DashboardRole] as readonly string[]).includes(p);
  }
  require(p: DashboardPermission): void {
    if (!this.can(p)) throw new PermissionDeniedError(`role '${this.user.role}' cannot do '${p}'`);
  }
}

export class DashboardAuthService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly clock: Clock = systemClock,
  ) {}

  private tokenHash(token: string): string {
    return hmacSha256Hex(this.settings.api_key_pepper, `dashboard-session:${token}`);
  }

  async findByEmail(email: string): Promise<DashboardUser | null> {
    const [u] = await this.tx
      .select()
      .from(dashboardUsers)
      .where(sql`lower(${dashboardUsers.email}) = ${email.trim().toLowerCase()}`);
    return u ?? null;
  }

  async createUser(args: {
    stationId: string;
    email: string;
    fullName: string;
    role: DashboardRole;
    password: string;
  }): Promise<DashboardUser> {
    if (args.password.length < 12) throw new InvalidRequestError("password must be at least 12 characters", { param: "password" });
    if (await this.findByEmail(args.email)) throw new ConflictError("a dashboard user with this email already exists", { param: "email" });
    const [u] = await this.tx
      .insert(dashboardUsers)
      .values({
        id: newId(IdPrefix.DASHBOARD_USER),
        stationId: args.stationId,
        email: args.email.trim(),
        fullName: args.fullName.trim(),
        role: args.role,
        passwordHash: await hashPassword(args.password),
        status: "active",
        failedLogins: 0,
      })
      .returning();
    return u!;
  }

  async login(email: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<[DashboardUser, string]> {
    const now = this.clock.now();
    const failed = () => new AuthenticationError("email or password is incorrect", { code: ErrorCode.DASHBOARD_LOGIN_FAILED });
    const user = await this.findByEmail(email);
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw failed();
    }
    if (user.lockedUntil && parseTs(user.lockedUntil) > now.getTime()) {
      throw new AuthenticationError("account temporarily locked after repeated failures", { code: ErrorCode.STAFF_ACCOUNT_LOCKED });
    }
    if (user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
      let n = user.failedLogins + 1;
      let lockedUntil = user.lockedUntil;
      if (n >= this.settings.staff_max_failed_logins) {
        lockedUntil = new Date(now.getTime() + this.settings.staff_lockout_s * 1000).toISOString();
        n = 0;
      }
      await this.tx
        .update(dashboardUsers)
        .set({ failedLogins: n, lockedUntil, updatedAt: sql`now()` })
        .where(eq(dashboardUsers.id, user.id));
      throw failed();
    }
    const [updated] = await this.tx
      .update(dashboardUsers)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now.toISOString(), updatedAt: sql`now()` })
      .where(eq(dashboardUsers.id, user.id))
      .returning();
    const token = randomToken(DASHBOARD_TOKEN_PREFIX);
    await this.tx.insert(dashboardSessions).values({
      id: newId(IdPrefix.DASHBOARD_SESSION),
      userId: user.id,
      tokenHash: this.tokenHash(token),
      expiresAt: new Date(now.getTime() + this.settings.dashboard_session_ttl_s * 1000).toISOString(),
      ip: meta.ip,
      userAgent: (meta.userAgent ?? "").slice(0, 300) || null,
    });
    return [updated!, token];
  }

  /** Resolve a session token into a context for ``mode`` (live needs verified KYC). */
  async resolve(token: string, mode: "test" | "live"): Promise<DashboardContext> {
    if (!token.startsWith(DASHBOARD_TOKEN_PREFIX)) throw new AuthenticationError("invalid dashboard session");
    const [row] = await this.tx
      .select({ s: dashboardSessions, u: dashboardUsers, st: stations })
      .from(dashboardSessions)
      .innerJoin(dashboardUsers, eq(dashboardUsers.id, dashboardSessions.userId))
      .innerJoin(stations, eq(stations.id, dashboardUsers.stationId))
      .where(eq(dashboardSessions.tokenHash, this.tokenHash(token)));
    if (!row || row.s.revokedAt !== null || parseTs(row.s.expiresAt) <= this.clock.now().getTime()) {
      throw new AuthenticationError("dashboard session is invalid or expired");
    }
    if (row.u.status !== "active") throw new AuthenticationError("dashboard user is disabled");
    if (row.st.status === "suspended")
      throw new PermissionDeniedError("this station is suspended; contact MintRail support", { code: ErrorCode.STATION_SUSPENDED });
    if (mode === "live" && row.st.kycStatus !== "verified")
      throw new PermissionDeniedError("live mode requires verified KYC", { code: ErrorCode.KYC_NOT_VERIFIED });
    return new DashboardContext(row.u, row.st, row.s.id, mode === "live");
  }

  async logout(sessionId: string): Promise<void> {
    await this.tx
      .update(dashboardSessions)
      .set({ revokedAt: this.clock.now().toISOString() })
      .where(and(eq(dashboardSessions.id, sessionId), isNull(dashboardSessions.revokedAt)));
  }

  async listUsers(stationId: string): Promise<DashboardUser[]> {
    return this.tx.select().from(dashboardUsers).where(eq(dashboardUsers.stationId, stationId)).orderBy(dashboardUsers.email);
  }

  async get(id: string): Promise<DashboardUser> {
    const [u] = await this.tx.select().from(dashboardUsers).where(eq(dashboardUsers.id, id));
    if (!u) throw new NotFoundError(`dashboard user ${id} not found`);
    return u;
  }
}
