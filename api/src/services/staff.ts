/** Railyard staff accounts, sessions and role-based permissions (ported from M1, ADR-0010). */
import { eq, isNull, and, sql } from "drizzle-orm";

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
  randomToken,
  type Settings,
  systemClock,
  type Tx,
  verifyPassword,
} from "@mintrail/shared";

import { type StaffRole, type StaffUser, staffSessions, staffUsers } from "../schema/index.js";

export const TOKEN_PREFIX = "rys_";
export const MIN_PASSWORD_LEN = 12;

export const PERMISSIONS = [
  "stations:read",
  "stations:write",
  "stations:suspend",
  "kyc:review",
  "api_keys:manage",
  "payments:read",
  "risk:review",
  "risk_rules:manage",
  "ledger:read",
  "audit:read",
  "staff:manage",
  // M2
  "disputes:manage",
  "payouts:approve",
  "webhooks:replay",
  "settlements:read",
  "settlements:run",
  "derailments:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  ops: new Set([
    "stations:read",
    "stations:write",
    "kyc:review",
    "payments:read",
    "risk:review",
    "disputes:manage",
    "webhooks:replay",
    "settlements:read",
    "derailments:write",
  ]),
  finance: new Set([
    "stations:read",
    "stations:write",
    "payments:read",
    "ledger:read",
    "payouts:approve",
    "settlements:read",
    "settlements:run",
    "derailments:write",
  ]),
  security: new Set([
    "stations:read",
    "stations:suspend",
    "api_keys:manage",
    "payments:read",
    "risk_rules:manage",
    "audit:read",
    "webhooks:replay",
    "derailments:write",
  ]),
  admin: new Set(PERMISSIONS),
};

export class StaffContext {
  constructor(
    readonly staff: StaffUser,
    readonly sessionId: string,
  ) {}
  get role(): StaffRole {
    return this.staff.role as StaffRole;
  }
  can(p: Permission): boolean {
    return ROLE_PERMISSIONS[this.role].has(p);
  }
}

export class LoginFailure extends AuthenticationError {}
const loginFailed = (): AuthenticationError =>
  new AuthenticationError("email or password is incorrect", { code: ErrorCode.STAFF_LOGIN_FAILED });

const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const parseTs = (v: string): number => Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

export class StaffService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly clock: Clock = systemClock,
  ) {}

  private tokenHash(token: string): string {
    return hmacSha256Hex(this.settings.api_key_pepper, `staff-session:${token}`);
  }

  async createStaff(args: { email: string; fullName: string; role: StaffRole; password: string }): Promise<StaffUser> {
    if (args.password.length < MIN_PASSWORD_LEN) {
      throw new InvalidRequestError(`password must be at least ${MIN_PASSWORD_LEN} characters`, { param: "password" });
    }
    if ((await this.findByEmail(args.email)) !== null) {
      throw new ConflictError("a staff user with this email already exists", { param: "email" });
    }
    const [row] = await this.tx
      .insert(staffUsers)
      .values({
        id: newId(IdPrefix.STAFF),
        email: args.email.trim(),
        fullName: args.fullName.trim(),
        role: args.role,
        passwordHash: await hashPassword(args.password),
        status: "active",
        failedLogins: 0,
      })
      .returning();
    return row!;
  }

  async ensureBootstrapAdmin(email: string, password: string): Promise<boolean> {
    if ((await this.findByEmail(email)) !== null) return false;
    await this.createStaff({ email, fullName: "Bootstrap Admin", role: "admin", password });
    return true;
  }

  async findByEmail(email: string): Promise<StaffUser | null> {
    const [u] = await this.tx
      .select()
      .from(staffUsers)
      .where(sql`lower(${staffUsers.email}) = ${email.trim().toLowerCase()}`);
    return u ?? null;
  }

  async get(staffId: string): Promise<StaffUser> {
    const [u] = await this.tx.select().from(staffUsers).where(eq(staffUsers.id, staffId));
    if (!u) throw new NotFoundError(`staff user ${staffId} not found`);
    return u;
  }

  listStaff(): Promise<StaffUser[]> {
    return this.tx.select().from(staffUsers).orderBy(staffUsers.email);
  }

  async disable(staffId: string): Promise<StaffUser> {
    await this.get(staffId);
    const [u] = await this.tx
      .update(staffUsers)
      .set({ status: "disabled", updatedAt: sql`now()` })
      .where(eq(staffUsers.id, staffId))
      .returning();
    await this.tx
      .update(staffSessions)
      .set({ revokedAt: this.clock.now().toISOString() })
      .where(and(eq(staffSessions.staffId, staffId), isNull(staffSessions.revokedAt)));
    return u!;
  }

  /** On failure the counter is updated in ``tx`` (caller commits) and the error is thrown. */
  async login(email: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<[StaffUser, string]> {
    const now = this.clock.now();
    const user = await this.findByEmail(email);
    if (user === null) {
      await verifyPassword(password, DUMMY_HASH); // equalise timing
      throw loginFailed();
    }
    if (user.lockedUntil !== null && parseTs(user.lockedUntil) > now.getTime()) {
      throw new AuthenticationError("account temporarily locked after repeated failures", { code: ErrorCode.STAFF_ACCOUNT_LOCKED });
    }
    if (user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
      let failed = user.failedLogins + 1;
      let lockedUntil = user.lockedUntil;
      if (failed >= this.settings.staff_max_failed_logins) {
        lockedUntil = new Date(now.getTime() + this.settings.staff_lockout_s * 1000).toISOString();
        failed = 0;
      }
      await this.tx
        .update(staffUsers)
        .set({ failedLogins: failed, lockedUntil, updatedAt: sql`now()` })
        .where(eq(staffUsers.id, user.id));
      throw loginFailed();
    }
    const [updated] = await this.tx
      .update(staffUsers)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now.toISOString(), updatedAt: sql`now()` })
      .where(eq(staffUsers.id, user.id))
      .returning();
    const token = randomToken(TOKEN_PREFIX);
    await this.tx.insert(staffSessions).values({
      id: newId(IdPrefix.STAFF_SESSION),
      staffId: user.id,
      tokenHash: this.tokenHash(token),
      expiresAt: new Date(now.getTime() + this.settings.staff_session_ttl_s * 1000).toISOString(),
      ip: meta.ip,
      userAgent: (meta.userAgent ?? "").slice(0, 300) || null,
    });
    return [updated!, token];
  }

  async resolve(token: string): Promise<StaffContext> {
    if (!token.startsWith(TOKEN_PREFIX)) throw new AuthenticationError("invalid Railyard session token");
    const [row] = await this.tx
      .select({ s: staffSessions, u: staffUsers })
      .from(staffSessions)
      .innerJoin(staffUsers, eq(staffUsers.id, staffSessions.staffId))
      .where(eq(staffSessions.tokenHash, this.tokenHash(token)));
    if (!row || row.s.revokedAt !== null || parseTs(row.s.expiresAt) <= this.clock.now().getTime()) {
      throw new AuthenticationError("Railyard session is invalid or expired");
    }
    if (row.u.status !== "active") throw new AuthenticationError("staff account is disabled");
    return new StaffContext(row.u, row.s.id);
  }

  async logout(sessionId: string): Promise<void> {
    await this.tx
      .update(staffSessions)
      .set({ revokedAt: this.clock.now().toISOString() })
      .where(and(eq(staffSessions.id, sessionId), isNull(staffSessions.revokedAt)));
  }
}
