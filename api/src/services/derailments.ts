/** Derailments: Railyard incident records with an append-only note timeline. */
import { asc, desc, eq, sql } from "drizzle-orm";

import { ConflictError, ErrorCode, IdPrefix, newId, NotFoundError, type Tx } from "@mintrail/shared";

import { type Derailment, type DerailmentNote, derailmentNotes, derailments } from "../schema/index.js";

export class DerailmentService {
  constructor(readonly tx: Tx) {}

  async create(staffId: string, args: { title: string; severity: string; summary: string; affected: string[] }): Promise<Derailment> {
    const [d] = await this.tx
      .insert(derailments)
      .values({
        id: newId(IdPrefix.DERAILMENT),
        title: args.title,
        severity: args.severity,
        status: "investigating",
        summary: args.summary,
        affected: args.affected,
        commanderId: staffId,
      })
      .returning();
    await this.tx
      .insert(derailmentNotes)
      .values({ derailmentId: d!.id, staffId, body: `Derailment opened: ${args.summary}`.slice(0, 4000), statusChange: "investigating" });
    return d!;
  }

  list(limit: number, status?: string | null): Promise<Derailment[]> {
    return this.tx
      .select()
      .from(derailments)
      .where(status ? eq(derailments.status, status) : undefined)
      .orderBy(desc(derailments.startedAt), desc(derailments.id))
      .limit(limit);
  }

  async get(id: string): Promise<[Derailment, DerailmentNote[]]> {
    const [d] = await this.tx.select().from(derailments).where(eq(derailments.id, id));
    if (!d) throw new NotFoundError(`derailment ${id} not found`, { code: ErrorCode.DERAILMENT_NOT_FOUND });
    return [d, await this.tx.select().from(derailmentNotes).where(eq(derailmentNotes.derailmentId, id)).orderBy(asc(derailmentNotes.id))];
  }

  async addNote(staffId: string, id: string, body: string, status?: string | null): Promise<[Derailment, DerailmentNote[]]> {
    const [d] = await this.get(id);
    if (d.status === "resolved" && status !== "investigating") throw new ConflictError("derailment is resolved; reopen it to add notes");
    await this.tx.insert(derailmentNotes).values({ derailmentId: id, staffId, body, statusChange: status ?? null });
    if (status && status !== d.status) {
      await this.tx
        .update(derailments)
        .set({ status, resolvedAt: status === "resolved" ? sql`now()` : null, updatedAt: sql`now()` })
        .where(eq(derailments.id, id));
    }
    return this.get(id);
  }
}
