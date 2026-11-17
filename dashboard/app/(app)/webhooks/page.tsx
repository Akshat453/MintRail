import { randomUUID } from "node:crypto";

import { Badge, Card, Empty, Field, Flash, PageHeader } from "@mintrail/web/ui";

import { createWebhook } from "@/app/actions";
import { SecretForm } from "@/components/client";
import { Deliveries } from "@/components/deliveries";
import { csrfToken, load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Webhooks" };

const EVENTS = [
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "refund.created",
  "refund.processed",
  "refund.failed",
  "settlement.processed",
  "dispute.created",
  "dispute.closed",
  "payout.processed",
  "payout.failed",
];

export default async function WebhooksPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, csrf] = await Promise.all([searchParams, csrfToken()]);
  const [endpoints, deliveries] = await load((a) =>
    Promise.all([a.get("/dashboard/v1/webhook_endpoints"), a.get("/dashboard/v1/webhook_deliveries", { limit: "15" })]),
  );
  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="MintRail POSTs signed events to your endpoints (MintRail-Signature: t=…,v1=…) and retries with backoff for up to ~2 days."
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <div className="grid grid-2">
        <Card title="Endpoints">
          {endpoints.data.length === 0 ? (
            <Empty>No endpoints yet.</Empty>
          ) : (
            <table>
              <tbody>
                {endpoints.data.map((e: { id: string; url: string; status: string; enabled_events: string[]; secret_hint: string }) => (
                  <tr key={e.id}>
                    <td>
                      <a href={`/webhooks/${e.id}`}>{e.url}</a>
                      <div className="muted">
                        {e.enabled_events.join(", ")} · secret …{e.secret_hint}
                      </div>
                    </td>
                    <td>
                      <Badge status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Add endpoint">
          <SecretForm action={createWebhook} csrf={csrf} idem={randomUUID()} button="Add endpoint" what="Endpoint signing secret">
            <Field label="URL">
              <input name="url" type="url" required placeholder="https://your-app.example/webhooks/mintrail" />
            </Field>
            <Field label="Description">
              <input name="description" maxLength={200} />
            </Field>
            <Field label="Events" hint="None selected = all events">
              <select name="events" multiple size={6}>
                {EVENTS.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </Field>
          </SecretForm>
        </Card>
      </div>
      <Card title="Recent deliveries">
        <Deliveries rows={deliveries.data} />
      </Card>
    </>
  );
}
