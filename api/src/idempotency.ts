/**
 * ``Idempotency-Key`` handling for every public POST (same storage and
 * semantics as M1, ADR-0009). The in-progress row is committed first (it is
 * the lock); handler writes and the stored response commit together; 4xx are
 * stored and replayed; 5xx release the key.
 */
import { and, eq, sql } from "drizzle-orm";

import { ConflictError, type Db, ErrorCode, InvalidRequestError, logContext, MintRailError, sha256Hex, type Tx } from "@mintrail/shared";

import { idempotencyKeys } from "./schema/index.js";

export const HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Non-JSON responses (CSV reports, evidence downloads). Never stored for idempotency. */
  raw?: { contentType: string; body: Buffer | string; filename?: string };
}

export const requestDigest = (method: string, path: string, body: Buffer): string =>
  sha256Hex(Buffer.concat([Buffer.from(`${method.toUpperCase()}\n${path}\n`), body]));

export function validateKey(key: string | undefined): string {
  if (key === undefined) {
    throw new InvalidRequestError(`POST requests require an ${HEADER} header`, { code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED, param: HEADER });
  }
  if (!KEY_RE.test(key)) {
    throw new InvalidRequestError(`${HEADER} must be 1-255 printable ASCII characters without spaces`, { param: HEADER });
  }
  return key;
}

const inProgress = (): ConflictError =>
  new ConflictError("a request with this Idempotency-Key is still being processed; retry shortly", {
    code: ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS,
    param: HEADER,
  });

export class Idempotency {
  private readonly digest: string;

  constructor(
    private readonly db: Db,
    private readonly scope: { stationId: string; livemode: boolean },
    private readonly key: string,
    private readonly method: string,
    private readonly path: string,
    body: Buffer,
    private readonly lockTimeoutS: number,
  ) {
    this.digest = requestDigest(method, path, body);
  }

  /** ``prepare`` runs (validation) before the claim; ``handler`` runs in the response transaction. */
  async run(handler: (tx: Tx) => Promise<Reply>): Promise<Reply> {
    const claimed = await this.claim();
    if (typeof claimed !== "bigint") return claimed;
    const id = claimed;
    let reply: Reply;
    try {
      reply = await this.db.transaction(async (tx) => {
        const r = await handler(tx);
        await this.complete(tx, id, r.status, r.body as Record<string, unknown>);
        return r;
      });
    } catch (e) {
      if (e instanceof MintRailError && e.httpStatus < 500) {
        await this.db.transaction((tx) => this.complete(tx, id, e.httpStatus, errorBody(e)));
      } else {
        await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
      }
      throw e;
    }
    return reply;
  }

  private async find(tx: Tx) {
    const [row] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.stationId, this.scope.stationId),
          eq(idempotencyKeys.livemode, this.scope.livemode),
          eq(idempotencyKeys.key, this.key),
        ),
      );
    return row;
  }

  private async claim(): Promise<bigint | Reply> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.db.transaction(async (tx): Promise<bigint | Reply | null> => {
        const existing = await this.find(tx);
        if (existing) {
          if (existing.requestDigest !== this.digest) {
            throw new ConflictError(`${HEADER} was already used for a different request`, {
              code: ErrorCode.IDEMPOTENCY_KEY_REUSED,
              param: HEADER,
            });
          }
          if (existing.status === "completed") {
            return { status: existing.responseStatus ?? 200, body: existing.responseBody, headers: { [REPLAYED_HEADER]: "true" } };
          }
          const taken = await tx
            .update(idempotencyKeys)
            .set({ lockedAt: sql`now()` })
            .where(
              and(
                eq(idempotencyKeys.id, existing.id),
                eq(idempotencyKeys.status, "in_progress"),
                sql`${idempotencyKeys.lockedAt} < now() - make_interval(secs => ${this.lockTimeoutS})`,
              ),
            )
            .returning({ id: idempotencyKeys.id });
          if (taken.length > 0) return existing.id;
          throw inProgress();
        }
        const inserted = await tx
          .insert(idempotencyKeys)
          .values({
            stationId: this.scope.stationId,
            livemode: this.scope.livemode,
            key: this.key,
            method: this.method.toUpperCase(),
            path: this.path,
            requestDigest: this.digest,
            status: "in_progress",
          })
          .onConflictDoNothing({ target: [idempotencyKeys.stationId, idempotencyKeys.livemode, idempotencyKeys.key] })
          .returning({ id: idempotencyKeys.id });
        return inserted[0]?.id ?? null;
      });
      if (result !== null) return result;
    }
    throw inProgress();
  }

  private async complete(tx: Tx, id: bigint, status: number, body: Record<string, unknown>): Promise<void> {
    await tx
      .update(idempotencyKeys)
      .set({ status: "completed", responseStatus: status, responseBody: body, completedAt: sql`now()` })
      .where(eq(idempotencyKeys.id, id));
  }
}

function errorBody(e: MintRailError): Record<string, unknown> {
  const body = e.toDict();
  const rid = logContext.getStore()?.request_id;
  if (rid !== undefined) body.request_id = rid;
  return { error: body };
}
