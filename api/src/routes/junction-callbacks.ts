/** Inbound Junction callbacks (bank → MintRail), authenticated by HMAC signature. */
import { AuthenticationError, ErrorCode, InvalidRequestError, log, parseJson, SignatureError, signatures } from "@mintrail/shared";

import type { AppDeps } from "../deps.js";
import type { makeRoute } from "../http/route.js";
import { PaymentService } from "../services/payments.js";
import { applyM2Event, isM2Event } from "../services/junction-events.js";

const REQUIRED = ["id", "type", "sequence", "ref", "payment_id"];

export function junctionCallbackRoutes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  route("post", "/internal/junction/v1/callbacks", {}, async (c) => {
    const header = c.req.get("junction-signature") ?? "";
    if (!header) throw new AuthenticationError("missing Junction-Signature", { code: ErrorCode.SIGNATURE_REQUIRED });
    const body = c.req.mr.rawBody;
    try {
      signatures.verify(Buffer.from(deps.settings.junction_callback_secret, "utf8"), header, body, { now: Math.floor(Date.now() / 1000) });
    } catch (e) {
      if (!(e instanceof SignatureError)) throw e;
      log.warn({ reason: e.reason }, "rejected junction callback");
      throw new AuthenticationError(`callback signature rejected: ${e.reason}`, { code: ErrorCode.INVALID_SIGNATURE });
    }
    let event: Record<string, unknown>;
    try {
      event = parseJson(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new InvalidRequestError("callback body is not JSON");
    }
    if (isM2Event(event)) {
      const outcome = await applyM2Event(deps, event);
      log.info({ type: event.type, ref: event.ref, outcome }, "junction callback");
      return { status: 200, body: { received: true, outcome } };
    }
    const missing = REQUIRED.filter((f) => !(f in event));
    if (missing.length > 0) throw new InvalidRequestError(`callback missing fields: [${missing.map((m) => `'${m}'`).join(", ")}]`);
    const outcome = await deps.db.transaction((tx) =>
      new PaymentService(tx, deps.settings, deps.junction, deps.clock).applyJunctionEvent(event),
    );
    log.info({ payment_id: event.payment_id, type: event.type, outcome }, "junction callback");
    return { status: 200, body: { received: true, outcome } };
  });
}
