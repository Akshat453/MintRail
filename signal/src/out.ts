/** API representations of Signal resources (shared by Platform's /v1 and dashboard routes). */
import { apiTime } from "@mintrail/shared";

import type { OutboxEvent, WebhookDelivery, WebhookDeliveryAttempt, WebhookEndpoint } from "./schema.js";

export const eventOut = (e: OutboxEvent) => ({
  object: "event",
  id: e.id,
  type: e.type,
  livemode: e.livemode,
  created_at: apiTime(e.createdAt),
  data: e.data,
});

export const endpointOut = (w: WebhookEndpoint) => ({
  object: "webhook_endpoint",
  id: w.id,
  livemode: w.livemode,
  url: w.url,
  description: w.description,
  enabled_events: w.enabledEvents,
  status: w.status,
  secret_hint: w.secretHint,
  secret_rotated_at: apiTime(w.secretRotatedAt),
  previous_secret_expires_at: apiTime(w.previousSecretExpiresAt),
  created_at: apiTime(w.createdAt),
});

export const attemptOut = (a: WebhookDeliveryAttempt) => ({
  attempt: a.attempt,
  status_code: a.statusCode,
  error: a.error,
  duration_ms: a.durationMs,
  response_excerpt: a.responseExcerpt,
  attempted_at: apiTime(a.attemptedAt),
});

export const deliveryOut = (d: WebhookDelivery, attempts?: WebhookDeliveryAttempt[]) => ({
  object: "webhook_delivery",
  id: d.id,
  event_id: d.eventId,
  endpoint_id: d.endpointId,
  event_type: d.eventType,
  livemode: d.livemode,
  status: d.status,
  attempts: d.attempts,
  max_attempts: d.maxAttempts,
  next_attempt_at: apiTime(d.nextAttemptAt),
  last_status_code: d.lastStatusCode,
  last_error: d.lastError,
  replay_of: d.replayOf,
  completed_at: apiTime(d.completedAt),
  created_at: apiTime(d.createdAt),
  ...(attempts ? { attempt_log: attempts.map(attemptOut) } : {}),
});
