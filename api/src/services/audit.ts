/** Staff audit log. Written in the same transaction as the action it records. */
import { and, desc, eq, lt } from "drizzle-orm";

import { logContext, type Tx } from "@mintrail/shared";

import { type StaffAuditEntry, staffAuditLog } from "../schema/index.js";
import type { StaffContext } from "./staff.js";

export class AuditService {
  constructor(
    readonly tx: Tx,
    private readonly ip: string | null = null,
  ) {}

  async record(
    actor: StaffContext | null,
    action: string,
    opts: { targetType?: string | null; targetId?: string | null; details?: Record<string, unknown>; actorEmail?: string } = {},
  ): Promise<StaffAuditEntry> {
    const [row] = await this.tx
      .insert(staffAuditLog)
      .values({
        staffId: actor ? actor.staff.id : null,
        staffEmail: actor ? actor.staff.email : (opts.actorEmail ?? "unknown"),
        action,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        details: opts.details ?? {},
        requestId: logContext.getStore()?.request_id ?? null,
        ip: this.ip,
      })
      .returning();
    return row!;
  }

  async search(opts: {
    limit: number;
    beforeId?: bigint | null;
    targetId?: string | null;
    staffId?: string | null;
  }): Promise<[StaffAuditEntry[], boolean]> {
    const where = [];
    if (opts.beforeId != null) where.push(lt(staffAuditLog.id, opts.beforeId));
    if (opts.targetId != null) where.push(eq(staffAuditLog.targetId, opts.targetId));
    if (opts.staffId != null) where.push(eq(staffAuditLog.staffId, opts.staffId));
    const rows = await this.tx
      .select()
      .from(staffAuditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(staffAuditLog.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }
}
