/**
 * Risk engine: runs every rule and folds hits into allow / review / block.
 * Conductor never reads Platform's tables; velocity comes via ``VelocityCounter``.
 */
import { and, desc, eq } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  IdPrefix,
  InvalidRequestError,
  type Money,
  newId,
  NotFoundError,
  systemClock,
  type Tx,
} from "@mintrail/shared";

import * as rules from "./rules.js";
import { type BlocklistEntry, type BlocklistKind, conductorBlocklist } from "./schema.js";

export type Decision = "allow" | "review" | "block";

export interface RiskInput {
  stationId: string;
  livemode: boolean;
  amount: Money;
  method: string;
  instrumentFingerprint?: string | null;
  cardBin?: string | null;
  vpa?: string | null;
  stationMaxAmount?: bigint | null;
}

export interface RuleHit {
  rule: string;
  outcome: string;
  detail: string;
}

export interface RiskAssessment {
  decision: Decision;
  score: number;
  hits: RuleHit[];
}

export const reasons = (a: RiskAssessment): Record<string, string>[] =>
  a.hits.map((h) => ({ rule: h.rule, outcome: h.outcome, detail: h.detail }));

export interface VelocityCounter {
  attemptsSince(fingerprint: string, since: Date, livemode: boolean): Promise<number>;
  failuresSince(fingerprint: string, since: Date, livemode: boolean): Promise<number>;
}

export class RiskEngine {
  constructor(
    readonly tx: Tx,
    private readonly velocityCounter: VelocityCounter,
    private readonly clock: Clock = systemClock,
  ) {}

  async evaluate(data: RiskInput): Promise<RiskAssessment> {
    const hits = rules.amountLimits(data.amount, data.method, data.stationMaxAmount ?? null);
    const [bins, vpas] = await this.activeBlocklist();
    hits.push(...rules.blocklist({ cardBin: data.cardBin ?? null, vpa: data.vpa ?? null, blockedBins: bins, blockedVpas: vpas }));
    if (data.instrumentFingerprint) {
      const now = this.clock.now().getTime();
      const attempts = await this.velocityCounter.attemptsSince(
        data.instrumentFingerprint,
        new Date(now - rules.VELOCITY_WINDOW_S * 1000),
        data.livemode,
      );
      const failures = await this.velocityCounter.failuresSince(
        data.instrumentFingerprint,
        new Date(now - rules.FAILURE_WINDOW_S * 1000),
        data.livemode,
      );
      hits.push(...rules.velocity(attempts, failures));
    }
    const decision: Decision = hits.some((h) => h.outcome === "block") ? "block" : hits.length > 0 ? "review" : "allow";
    return {
      decision,
      score: Math.min(
        100,
        hits.reduce((a, h) => a + h.weight, 0),
      ),
      hits: hits.map((h) => ({ rule: h.rule, outcome: h.outcome, detail: h.detail })),
    };
  }

  private async activeBlocklist(): Promise<[Set<string>, Set<string>]> {
    const rows = await this.tx
      .select({ kind: conductorBlocklist.kind, value: conductorBlocklist.value })
      .from(conductorBlocklist)
      .where(eq(conductorBlocklist.active, true));
    return [
      new Set(rows.filter((r) => r.kind === "card_bin").map((r) => r.value)),
      new Set(rows.filter((r) => r.kind === "vpa").map((r) => r.value)),
    ];
  }

  async addToBlocklist(kind: BlocklistKind, value: string, opts: { reason: string; staffId: string }): Promise<BlocklistEntry> {
    const normalised = normalise(kind, value);
    const [existing] = await this.tx
      .select({ id: conductorBlocklist.id })
      .from(conductorBlocklist)
      .where(and(eq(conductorBlocklist.kind, kind), eq(conductorBlocklist.value, normalised), eq(conductorBlocklist.active, true)));
    if (existing) throw new ConflictError(`${kind} ${normalised} is already blocklisted`);
    const [row] = await this.tx
      .insert(conductorBlocklist)
      .values({ id: newId(IdPrefix.BLOCKLIST_ENTRY), kind, value: normalised, reason: opts.reason, active: true, createdBy: opts.staffId })
      .returning();
    return row!;
  }

  async removeFromBlocklist(entryId: string): Promise<BlocklistEntry> {
    const [entry] = await this.tx.select().from(conductorBlocklist).where(eq(conductorBlocklist.id, entryId));
    if (!entry) throw new NotFoundError(`blocklist entry ${entryId} not found`);
    if (!entry.active) return entry;
    const [row] = await this.tx
      .update(conductorBlocklist)
      .set({ active: false, deactivatedAt: this.clock.now().toISOString() })
      .where(eq(conductorBlocklist.id, entryId))
      .returning();
    return row!;
  }

  async listBlocklist(activeOnly = true): Promise<BlocklistEntry[]> {
    const q = this.tx.select().from(conductorBlocklist);
    return (activeOnly ? q.where(eq(conductorBlocklist.active, true)) : q).orderBy(desc(conductorBlocklist.id));
  }
}

function normalise(kind: BlocklistKind, value: string): string {
  const v = value.trim();
  if (kind === "card_bin") {
    if (!(/^\d+$/.test(v) && (v.length === 6 || v.length === 8))) {
      throw new InvalidRequestError("card BIN must be 6 or 8 digits", { param: "value" });
    }
    return v;
  }
  if (!v.includes("@")) throw new InvalidRequestError("VPA must look like name@handle", { param: "value" });
  return v.toLowerCase();
}
